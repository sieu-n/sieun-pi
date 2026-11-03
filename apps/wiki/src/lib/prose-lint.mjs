// Prose lint for llm-wiki HTML pages against `.agents/skills/apps/llm-wiki/references/writing.md` and unslop.
// Pure module; the write API, scripts/prose-lint.mjs and scripts/repo/agent/commit.mjs call it.

/** The standard a finding points the writer to. */
export const STANDARD_FILE = '.agents/skills/apps/llm-wiki/references/writing.md';

export const LIMITS = Object.freeze({
	/** A bullet longer than this is stuffed clauses. */
	BULLET_MAX_WORDS: 30,
	/** A bullet shorter than this is a fragment. */
	BULLET_MIN_WORDS: 4,
	/** A sentence longer than this is hard to read at speech pace (warn). */
	SENTENCE_MAX_WORDS: 30,
	/** A paragraph with more sentences than this is a wall of text. */
	PARAGRAPH_MAX_SENTENCES: 3,
	/** A paragraph with more words than this is a wall of text. */
	PARAGRAPH_MAX_WORDS: 70,
	/** Paragraphs may hold at most this share of the body's prose words; the rest is numbered lines... */
	PARAGRAPH_MAX_SHARE: 0.4,
	/** ...once the body holds at least this many prose words. */
	PARAGRAPH_SHARE_MIN_WORDS: 250,
	/** A page over this many words needs a diagram or image... */
	VISUAL_MIN_WORDS: 300,
	/** ...and one more for every this many words... */
	WORDS_PER_VISUAL: 400,
	/** ...and one for every this many numbered lines. */
	LINES_PER_VISUAL: 10,
	/** A run of more numbered lines than this with no diagram or image between them is a wall. */
	MAX_LINES_WITHOUT_VISUAL: 24,
	/** A label prefix before a colon has at most this many words. */
	LABEL_MAX_WORDS: 6,
	/** Bold spans allowed per page: max(BOLD_MIN_PER_PAGE, words / BOLD_WORDS_PER_SPAN). */
	BOLD_MIN_PER_PAGE: 3,
	BOLD_WORDS_PER_SPAN: 300,
	/** A bold span longer than this is a sentence in bold, not a label. */
	BOLD_MAX_CHARS: 40,
	/** A table cell over this many words is prose that belongs in a sentence. */
	CELL_MAX_WORDS: 20,
	/** A table with more columns than this is a wall (warn). */
	TABLE_MAX_COLUMNS: 6,
	/** Tables may hold at most this share of the page's words... */
	TABLE_MAX_SHARE: 0.35,
	/** ...once the tables hold at least this many words. */
	TABLE_SHARE_MIN_WORDS: 150,
	/** Excerpt length in characters. */
	EXCERPT_CHARS: 90,
});


const SESSION_LOG = /^sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/index\.html$/;

/**
 * True when a content-relative path is a page this lint judges. Session logs are API-managed,
 * requests.html holds verbatim asks, and archive/ is frozen history moved in as it was.
 * @param {string} relPath path relative to apps/llm-wiki/content (a repo-relative path also works)
 */
export function isLintedPath(relPath) {
	const rel = contentRel(relPath);
	if (!rel.endsWith('.html')) return false;
	if (rel === 'requests.html' || rel.endsWith('/requests.html')) return false;
	if (SESSION_LOG.test(rel)) return false;
	if (rel.startsWith('archive/') || rel.startsWith('@code/')) return false;
	return true;
}

/** @param {string} relPath a content-relative or repo-relative path */
function contentRel(relPath) {
	const marker = 'apps/llm-wiki/content/';
	let rel = relPath.replace(/\\/g, '/');
	const at = rel.indexOf(marker);
	if (at >= 0) rel = rel.slice(at + marker.length);
	return rel.replace(/^\.?\//, '');
}

const CURATED_PAGE = /^(?:apps|domains|projects|experiments)\/(?!.*\/(?:data|assets)\/).*\.html$/;
const SESSION_LOG_FOLDER = /^sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/;
/** A wiki URL on any host that serves it on :5176: the server in hosts.json, or the Mac's old localhost wiki. */
const WIKI_ORIGIN = /^https?:\/\/[^/\s]+:5176(?=\/)/i;

/**
 * The content path a curated page's href points at when it is a session artifact, else null.
 * Only a session log `index.html` is git-tracked, so any other file under sessions/ is dead in git.
 * @param {string} href
 * @param {string} pagePath content-relative path of the linking page
 */
export function sessionArtifactLink(href, pagePath) {
	let target = href.trim().replace(WIKI_ORIGIN, '');
	let base = pagePath.split('/').slice(0, -1);
	if (target.startsWith('/page/')) {
		target = target.slice('/page/'.length);
		base = [];
	}
	if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
	try {
		target = decodeURIComponent(target.split('#')[0].split('?')[0]);
	} catch {
		return null;
	}
	const parts = [...base];
	for (const part of contentRel(target).split('/')) {
		if (part === '..') parts.pop();
		else if (part && part !== '.') parts.push(part);
	}
	const rel = parts.join('/');
	if (!rel.startsWith('sessions/') || SESSION_LOG.test(rel) || SESSION_LOG_FOLDER.test(rel)) return null;
	return rel;
}


/**
 * @typedef {{ type: 'el', tag: string, attrs: string, start: number, parent: El | null, children: Node[] }} El
 * @typedef {{ type: 'text', text: string, start: number }} Text
 * @typedef {El | Text} Node
 */

/** @param {string} s a whitespace-separated word list */
const wordSet = (s) => new Set(s.trim().split(/\s+/));

const VOID = wordSet(`area base br col embed hr img input link meta source track wbr`);
const RAW_TEXT = new Set(['script', 'style', 'textarea']);
const BLOCK =
	wordSet(`address article aside blockquote details div dl dd dt fieldset figcaption figure footer form h1 h2
	h3 h4 h5 h6 header hr li main nav ol p pre section table ul summary`);
const TOKEN =
	/<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;

/**
 * Parse HTML into a small element tree. Tolerant: an unmatched close tag is ignored, and
 * <li>, <p>, <td>, <th>, <tr>, <dt>, <dd> close themselves the way browsers close them.
 * Comments, including the `<!--wiki ...-->` frontmatter, are dropped.
 * @param {string} html
 * @returns {El}
 */
export function parseHtml(html) {
	/** @type {El} */
	const root = { type: 'el', tag: '#root', attrs: '', start: 0, parent: null, children: [] };
	/** @type {El} */
	let cur = root;
	let i = 0;
	let textStart = 0;
	const flushText = (/** @type {number} */ end) => {
		if (end > textStart) cur.children.push({ type: 'text', text: html.slice(textStart, end), start: textStart });
	};
	/** @param {string} tag */
	const openIndex = (tag) => {
		/** @type {El | null} */
		let n = cur;
		for (; n && n !== root; n = n.parent) if (n.tag === tag) return n;
		return null;
	};
	/** @param {El} target */
	const closeTo = (target) => {
		cur = target.parent ?? root;
	};
	/**
	 * Close an open `tag` when it is open below the nearest `stop` element.
	 * @param {string[]} tags
	 * @param {string[]} stops
	 */
	const implicitClose = (tags, stops) => {
		/** @type {El | null} */
		let n = cur;
		for (; n && n !== root; n = n.parent) {
			if (stops.includes(n.tag)) return;
			if (tags.includes(n.tag)) {
				closeTo(n);
				return;
			}
		}
	};
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt < 0) break;
		TOKEN.lastIndex = lt;
		const m = TOKEN.exec(html);
		if (!m) {
			i = lt + 1;
			continue;
		}
		flushText(lt);
		i = lt + m[0].length;
		textStart = i;
		if (m[1]) {
			const tag = m[1].toLowerCase();
			const open = openIndex(tag);
			if (open) closeTo(open);
			continue;
		}
		if (!m[2]) continue; // comment or doctype
		const tag = m[2].toLowerCase();
		if (tag === 'li') implicitClose(['li'], ['ul', 'ol', 'menu']);
		else if (tag === 'dt' || tag === 'dd') implicitClose(['dt', 'dd'], ['dl']);
		else if (tag === 'td' || tag === 'th') implicitClose(['td', 'th'], ['tr', 'table']);
		else if (tag === 'tr') implicitClose(['tr', 'td', 'th'], ['table', 'thead', 'tbody', 'tfoot']);
		else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot')
			implicitClose(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], ['table']);
		if (BLOCK.has(tag) && cur.tag === 'p') closeTo(cur);
		/** @type {El} */
		const el = { type: 'el', tag, attrs: m[3] ?? '', start: lt, parent: cur, children: [] };
		cur.children.push(el);
		if (VOID.has(tag) || m[4] === '/') continue;
		if (RAW_TEXT.has(tag)) {
			const close = html.toLowerCase().indexOf(`</${tag}`, i);
			const end = close < 0 ? html.length : close;
			el.children.push({ type: 'text', text: html.slice(i, end), start: i });
			const gt = close < 0 ? html.length : html.indexOf('>', close);
			i = gt < 0 ? html.length : gt + 1;
			textStart = i;
			continue;
		}
		cur = el;
	}
	flushText(html.length);
	return root;
}

/**
 * @param {string} attrs
 * @param {string} name
 */
function attr(attrs, name) {
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attrs);
	return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const ENTITIES = /** @type {Record<string, string>} */ ({
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '\u2014',
	ndash: '\u2013',
	hellip: '\u2026',
	lsquo: '\u2018',
	rsquo: '\u2019',
	ldquo: '\u201c',
	rdquo: '\u201d',
	middot: '\u00b7',
	rarr: '\u2192',
	larr: '\u2190',
	harr: '\u2194',
	times: '\u00d7',
	copy: '\u00a9',
	reg: '\u00ae',
	trade: '\u2122',
	deg: '\u00b0',
	plusmn: '\u00b1',
	le: '\u2264',
	ge: '\u2265',
	ne: '\u2260',
	minus: '\u2212',
	bull: '\u2022',
	thinsp: ' ',
	ensp: ' ',
	emsp: ' ',
	zwj: '',
	zwnj: '',
	shy: '',
});

/** @param {string} s */
export function decodeEntities(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, /** @type {string} */ name) => {
		if (name[0] === '#') {
			const cp = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
		}
		return ENTITIES[name.toLowerCase()] ?? whole;
	});
}


/**
 * @typedef {'bullet' | 'paragraph' | 'loose' | 'cell' | 'heading' | 'caption'} UnitKind
 * @typedef {{ text: string, start: number }} Piece
 * @typedef {{
 *   kind: UnitKind, tag: string, line: number, raw: string, text: string, words: number,
 *   pieces: Piece[], firstBold: boolean, linkOnly: boolean, codeOnly: boolean,
 *   hasNestedList: boolean, inTldr: boolean, isHead: boolean, ko: boolean, numbered: boolean, start: number,
 * }} Unit
 * @typedef {{ raw: string, pieces: Piece[], first: null | 'bold' | 'other', inLinkLetters: number, outLetters: number, code: number, nested: boolean }} Acc
 * @typedef {{ inTldr: boolean, isHead: boolean, ko: boolean }} Ctx
 * @typedef {{ text: string, line: number }} Span
 * @typedef {{ columns: number, words: number, line: number }} TableInfo
 * @typedef {{
 *   path: string, units: Unit[], bold: Span[], italics: Span[], tables: TableInfo[],
 *   visuals: number[], words: number, lineOf: (offset: number) => number, ko: boolean,
 *   links: { href: string, line: number }[], now: number, meta: Record<string, unknown>,
 * }} Page
 */

/** Diagrams and images; a `<pre class="mermaid">` counts too. A figure holding an image counts once. */
const VISUAL = new Set(['svg', 'img', 'picture', 'video', 'wiki-figure', 'wiki-gallery', 'wiki-image', 'wiki-mermaid']);
/** A unit that opens with "1." or "2)" is a numbered line written as plain text. */
const NUMBER_MARKER = /^\d{1,3}[.)]\s+/;

/** Elements dropped with their content: code blocks, diagrams, verbatim quotes. */
const SKIP = wordSet(`script style svg pre blockquote textarea math template noscript wiki-mermaid head title`);
/** Inline code: replaced by one neutral token so sentences stay whole. */
const CODE = new Set(['code', 'kbd', 'samp', 'var', 'tt']);
const CODE_TOKEN = 'CODE';
const QUOTE_TOKEN = 'QUOTE';
/** Elements that are their own unit. */
const UNIT_KIND = /** @type {Record<string, UnitKind>} */ ({
	li: 'bullet',
	p: 'paragraph',
	td: 'cell',
	th: 'cell',
	dd: 'paragraph',
	dt: 'paragraph',
	figcaption: 'caption',
	caption: 'caption',
	summary: 'heading',
	h1: 'heading',
	h2: 'heading',
	h3: 'heading',
	h4: 'heading',
	h5: 'heading',
	h6: 'heading',
});
const INLINE =
	wordSet(`a abbr b bdi bdo br cite code data del dfn em i img ins kbd label mark q s samp small span strong
	sub sup time u var wbr tt`);
/** Subtrees a unit's own text never includes; they are walked as units of their own. */
const OWN_UNITS = new Set(['ul', 'ol', 'menu', 'table', 'dl', 'wiki-table']);

/** @returns {Acc} */
const newAcc = () => ({ raw: '', pieces: [], first: null, inLinkLetters: 0, outLetters: 0, code: 0, nested: false });

/**
 * Source offsets of every diagram and image, in document order.
 * @param {El} el
 * @param {number[]} out
 * @returns {number[]}
 */
function findVisuals(el, out = []) {
	for (const node of el.children) {
		if (node.type !== 'el') continue;
		const cls = attr(node.attrs, 'class');
		if (VISUAL.has(node.tag) || (cls !== null && /(^|\s)mermaid(\s|$)/.test(cls))) out.push(node.start);
		else findVisuals(node, out);
	}
	return out;
}

/**
 * Korean on purpose, such as a ko article or Korean product copy: `lang="ko"` on the element.
 * @param {El} el
 */
function isKo(el) {
	return /^ko(?:-|$)/i.test((attr(el.attrs, 'lang') ?? '').trim());
}

/** @param {El} el */
function isSkipped(el) {
	if (SKIP.has(el.tag)) return true;
	const cls = attr(el.attrs, 'class');
	return cls !== null && /(^|\s)mermaid(\s|$)/.test(cls);
}

/** @param {string} s */
export function countWords(s) {
	return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** @param {string} s */
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Replace text inside straight or curly double quotes with one token. Quoted words are
 * verbatim (the owner's words, a log line), not ours to lint. A closing . ! ? inside the
 * quote stays, so the sentence still ends.
 * @param {string} s
 */
export function stripQuotes(s) {
	return s.replace(
		/"([^"\n]{1,400})"|\u201c([^\u201d]{1,400})\u201d/g,
		(_m, /** @type {string|undefined} */ a, /** @type {string|undefined} */ b) => {
			const inner = (a ?? b ?? '').trim();
			const end = /[.!?]$/.test(inner) ? inner.slice(-1) : '';
			return QUOTE_TOKEN + end;
		},
	);
}

/**
 * Collect the visible text of one unit. Code becomes CODE, <q> becomes QUOTE, nested lists
 * and tables are left for their own units, skipped elements disappear.
 * @param {El} el
 * @param {boolean} inLink
 * @param {boolean} inBold
 * @param {Acc} acc
 * @param {(child: El) => void} deferred
 */
function gather(el, inLink, inBold, acc, deferred) {
	for (const node of el.children) {
		if (node.type === 'text') {
			const text = decodeEntities(node.text);
			if (!text) continue;
			if (acc.first === null && /\S/.test(text)) acc.first = inBold ? 'bold' : 'other';
			const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
			if (inLink) acc.inLinkLetters += letters;
			else acc.outLetters += letters;
			acc.pieces.push({ text, start: node.start });
			acc.raw += text;
			continue;
		}
		if (isSkipped(node)) {
			// A code block or quote inside a bullet lets the bullet end in a colon.
			if (BLOCK.has(node.tag) || node.tag.startsWith('wiki-')) acc.nested = true;
			continue;
		}
		if (OWN_UNITS.has(node.tag)) {
			if (node.tag !== 'table' && node.tag !== 'wiki-table') acc.nested = true;
			deferred(node);
			acc.raw += ' ';
			continue;
		}
		if (CODE.has(node.tag)) {
			if (acc.first === null) acc.first = inBold ? 'bold' : 'other';
			acc.code += 1;
			acc.raw += CODE_TOKEN;
			continue;
		}
		if (node.tag === 'q' || isKo(node)) {
			if (acc.first === null) acc.first = inBold ? 'bold' : 'other';
			acc.raw += QUOTE_TOKEN;
			continue;
		}
		if (node.tag === 'br') {
			acc.raw += ' ';
			continue;
		}
		const block = !INLINE.has(node.tag);
		if (block) acc.raw += ' ';
		gather(node, inLink || node.tag === 'a', inBold || node.tag === 'strong' || node.tag === 'b', acc, deferred);
		if (block) acc.raw += ' ';
	}
}

/**
 * Find bold and italic spans in a subtree.
 * @param {El} el
 * @param {Page} page
 * @param {boolean} exempt bold inside wiki-tldr and table headers does not count
 */
function collectSpans(el, page, exempt) {
	for (const node of el.children) {
		if (node.type !== 'el' || isSkipped(node)) continue;
		const ex = exempt || node.tag === 'wiki-tldr' || node.tag === 'th' || node.tag === 'thead';
		if (!ex && (node.tag === 'strong' || node.tag === 'b' || node.tag === 'em' || node.tag === 'i')) {
			const acc = newAcc();
			gather(node, false, false, acc, () => {});
			const text = squash(acc.raw);
			if (text)
				(node.tag === 'strong' || node.tag === 'b' ? page.bold : page.italics).push({
					text,
					line: page.lineOf(node.start),
				});
		}
		collectSpans(node, page, ex);
	}
}

/**
 * Parse a page into lintable units.
 * @param {string} html
 * @param {{ path?: string, now?: number }} [opts]
 * @returns {Page}
 */
export function parsePage(html, opts = {}) {
	const lineStarts = [0];
	for (let i = 0; i < html.length; i++) if (html.charCodeAt(i) === 10) lineStarts.push(i + 1);
	/** @param {number} offset */
	const lineOf = (offset) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
	const links = [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => ({
		href: m[1],
		line: lineOf(m.index ?? 0),
	}));
	/** @type {Page} */
	const page = {
		path: contentRel(opts.path ?? ''),
		units: [],
		bold: [],
		italics: [],
		tables: [],
		visuals: [],
		words: 0,
		lineOf,
		links,
		now: opts.now ?? Date.now(),
		// A page marked Korean in its wiki header ("lang": "ko") or kept under a ko/ folder.
		ko:
			/"lang"\s*:\s*"ko/.test(/<!--wiki((?:(?!-->)[\s\S])*)-->/.exec(html.slice(0, 4000))?.[1] ?? '') ||
			/(?:^|\/)ko\//.test(contentRel(opts.path ?? '')),
		meta: wikiMeta(html),
	};
	const root = parseHtml(html);
	page.visuals = findVisuals(root);

	/**
	 * @param {El} el
	 * @param {UnitKind} kind
	 * @param {Ctx} ctx
	 */
	const addUnit = (el, kind, ctx) => {
		/** @type {El[]} */
		const later = [];
		const acc = newAcc();
		gather(el, el.tag === 'a', el.tag === 'strong' || el.tag === 'b', acc, (child) => later.push(child));
		pushUnit(el.tag, el.start, kind, acc, ctx, el.tag === 'li' && el.parent?.tag === 'ol');
		for (const child of later) walk(child, ctx);
	};

	/**
	 * @param {string} tag
	 * @param {number} start
	 * @param {UnitKind} kind
	 * @param {Acc} acc
	 * @param {Ctx} ctx
	 * @param {boolean} [numbered] an <ol> item
	 */
	const pushUnit = (tag, start, kind, acc, ctx, numbered = false) => {
		const raw = squash(acc.raw);
		if (!raw) return;
		let text = squash(stripQuotes(raw));
		if ((kind === 'paragraph' || kind === 'loose' || kind === 'bullet') && NUMBER_MARKER.test(text)) {
			text = text.replace(NUMBER_MARKER, '');
			kind = 'bullet';
			numbered = true;
		}
		const firstPiece = acc.pieces.find((p) => /\S/.test(p.text));
		const line = lineOf(
			firstPiece ? firstPiece.start + (firstPiece.text.length - firstPiece.text.trimStart().length) : start,
		);
		page.units.push({
			kind,
			tag,
			line,
			raw,
			text,
			words: countWords(text),
			pieces: acc.pieces,
			firstBold: acc.first === 'bold',
			linkOnly: acc.outLetters === 0 && acc.inLinkLetters > 0 && acc.code === 0,
			codeOnly: acc.outLetters === 0 && acc.inLinkLetters === 0 && acc.code > 0,
			hasNestedList: acc.nested,
			inTldr: ctx.inTldr,
			isHead: ctx.isHead,
			ko: ctx.ko,
			numbered,
			start,
		});
	};

	/**
	 * Walk a container. Unit elements become units; runs of loose inline text become loose units.
	 * @param {El} el
	 * @param {Ctx} ctx
	 */
	const walk = (el, ctx) => {
		if (isSkipped(el)) return;
		const inTldr = ctx.inTldr || el.tag === 'wiki-tldr';
		const isHead = ctx.isHead || el.tag === 'thead';
		const ko = ctx.ko || isKo(el);
		const here = { inTldr, isHead, ko };
		if (el.tag === 'table') {
			/** @type {El[]} */
			const rows = [];
			/** @param {El} n */
			const findRows = (n) => {
				for (const c of n.children) {
					if (c.type !== 'el' || c.tag === 'table') continue;
					if (c.tag === 'tr') rows.push(c);
					else findRows(c);
				}
			};
			findRows(el);
			const columns = Math.max(
				0,
				...rows.map((r) => r.children.filter((c) => c.type === 'el' && (c.tag === 'td' || c.tag === 'th')).length),
			);
			const before = page.units.length;
			for (const c of el.children) if (c.type === 'el') walk(c, here);
			const words = page.units
				.slice(before)
				.filter((u) => u.kind === 'cell')
				.reduce((n, u) => n + u.words, 0);
			page.tables.push({ columns, words, line: lineOf(el.start) });
			return;
		}
		const kind = UNIT_KIND[el.tag];
		if (kind) {
			addUnit(el, kind, { inTldr, isHead: isHead || el.tag === 'th', ko });
			return;
		}
		if (el.tag === 'wiki-figure' || el.tag === 'wiki-image' || el.tag === 'img') {
			const text = attr(el.attrs, 'caption') ?? (el.tag === 'img' ? null : attr(el.attrs, 'alt'));
			if (text) {
				pushUnit(
					el.tag,
					el.start,
					'caption',
					{
						raw: text,
						pieces: [{ text: decodeEntities(text), start: el.start }],
						first: 'other',
						inLinkLetters: 0,
						outLetters: 1,
						code: 0,
						nested: false,
					},
					here,
				);
			}
		}
		let run = newAcc();
		let runStart = el.start;
		const flush = () => {
			if (squash(run.raw)) pushUnit(el.tag, runStart, 'loose', run, here);
			run = newAcc();
		};
		for (const node of el.children) {
			const inline = node.type === 'text' || (INLINE.has(node.tag) && !isSkipped(node));
			if (inline) {
				if (!squash(run.raw)) runStart = node.start;
				gather(
					{ type: 'el', tag: '#run', attrs: '', start: node.start, parent: null, children: [node] },
					false,
					false,
					run,
					(child) => walk(child, here),
				);
				continue;
			}
			flush();
			walk(node, here);
		}
		flush();
	};

	walk(root, { inTldr: false, isHead: false, ko: false });
	collectSpans(root, page, false);
	page.words = page.units.reduce((n, u) => n + u.words, 0);
	return page;
}


const ABBREVIATIONS = wordSet(`eg ie vs etc mr mrs ms dr no cf approx fig st jr al viz ca resp incl avg est ref`);

/**
 * Split text into sentences: . ! ? then space then an uppercase letter, digit, quote or token;
 * never after a common abbreviation. A semicolon followed by a space also ends a clause.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
	const out = [];
	let from = 0;
	const rx = /([.!?]+)["'\u201d\u2019)\]]*\s+(?=["'\u201c\u2018(\[]?[\p{Lu}\p{N}])|;\s+(?=\S)/gu;
	for (let m = rx.exec(text); m; m = rx.exec(text)) {
		if (m[1]) {
			const before = text.slice(from, m.index);
			const word = (/(\S+)$/.exec(before)?.[1] ?? '').replace(/[.()\[\]"']/g, '').toLowerCase();
			if (m[1] === '.' && ABBREVIATIONS.has(word)) continue;
		}
		const piece = text.slice(from, m.index + m[0].length).trim();
		if (piece) out.push(piece);
		from = m.index + m[0].length;
	}
	const tail = text.slice(from).trim();
	if (tail) out.push(tail);
	return out;
}


// Unicode word class and word boundary.
const W = '0-9A-Za-z_\\p{L}\\p{N}';
const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
const MASK = '\u0000';
/** Masks for URLs, paths, file names, snake_case identifiers, number ranges. */
const MASKS = [
	new RegExp(`https?://\\S+`, 'gu'),
	new RegExp(
		`(?<![${W}/])(?:~|\\.{1,2})?/[${W}.\\-/@]+` +
			`|(?<![${W}.])[${W}\\-.]+\\.(?:mjs|js|ts|py|md|json|jsonl|sh|svelte|toml|yaml|yml|sql|csv|tsx|html)${B}` +
			`|(?<![${W}/])[${W}.\\-@]+(?:/[${W}.\\-@]+)+`,
		'gu',
	),
	new RegExp(`${B}[${W}]+_[${W}]+${B}`, 'gu'),
	new RegExp(`\\p{Nd}+\\s*[\\u2013-]\\s*\\p{Nd}+`, 'gu'),
];

/** @param {string} s */
function mask(s) {
	let out = s;
	for (const rx of MASKS) out = out.replace(rx, (m) => MASK.repeat(m.length));
	return out;
}

/**
 * @typedef {{ name: string, severity: 'error' | 'warn', pattern: RegExp, fix: string, exempt?: RegExp, scope?: 'text' | 'heading' }} WordRule
 */

/** @type {WordRule[]} */
const WORD_RULES = [
	{
		name: '6 emoji',
		severity: 'error',
		pattern: /[\u{1F300}-\u{1FAFF}\u2705\u274C\u2728\u26A0\u2714\u2717\uFE0F]/gu,
		fix: 'Delete the emoji; a heading or status line says its state in words.',
	},
	{
		name: '10 announcing honesty',
		severity: 'error',
		pattern: new RegExp(
			`${B}(the honest (answer|framing|version|truth)|to be honest|honestly[,\\s]|stated with its limits|the uncomfortable (part|truth)|answered honestly)`,
			'giu',
		),
		fix: 'Delete the announcement and state the limit in one sentence.',
	},
	{
		name: '15 fancy word',
		severity: 'error',
		pattern: new RegExp(
			`${B}(delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge` +
				`|paradigm|tapestry|realm|beacon|multifaceted|meticulous|intricate|paramount` +
				`|transformative|elevate|embark|supercharge|ever-evolving|seamless|comprehensive` +
				`|pivotal|holistic|myriad|additionally|crucial|enhance|enduring|garner|interplay` +
				`|showcase|testament|underscore|vibrant|commence|remediate|methodology)[${W}]*${B}` +
				`|${B}harness(?:es|ed|ing)? (?:the|its|their|this|that|our|your)${B}`,
			'giu',
		),
		exempt: new RegExp(`${B}(terminate[sd]?|terminating|instance termination|robustness)${B}`, 'iu'),
		fix: 'Use the word a coworker would say out loud: use, help, start, fix, strong, full, key.',
	},
	{
		name: '16 marketing word',
		severity: 'error',
		pattern: new RegExp(`${B}(easy|easily|simple|simply|quick|quickly|powerful)${B}`, 'giu'),
		fix: 'Replace the marketing word with the concrete fact, such as "one command" or the measured time.',
	},
	{
		name: '27 puffery',
		severity: 'error',
		pattern: /plays a (vital|key|critical) role|marks a pivotal|underscores|a testament to|setting the stage for/giu,
		fix: 'State the fact and let the reader judge its importance.',
	},
	{
		name: '30 meta-narration',
		severity: 'error',
		pattern:
			/this section (describes|covers)|this page (describes|covers|explains)|as mentioned|worth noting|it is important to note|let'?s (look at|dive|explore)|in other words|now that we'?ve/giu,
		fix: 'Delete the narration and state the point.',
	},
	{
		name: '37 filler',
		severity: 'error',
		pattern: /in order to|due to the fact that|for the purpose of|in the event that/giu,
		fix: 'Use the short form: "to", "because", "for", "if".',
	},
	{
		name: '39 chatbot',
		severity: 'error',
		pattern:
			/I hope this helps|let me know if|of course[,!]|certainly[,!]|great question|you'?re absolutely right|smoking gun/giu,
		fix: 'Delete the chatbot phrase and answer directly.',
	},
	{
		name: '43 metaphor noun',
		severity: 'error',
		pattern: new RegExp(
			`${B}(substrate|wedge in|vector|locus|vantage|nexus|primitive|bedrock|scaffolding` +
				`|modality|gold-plating|ratchet|evacuate|endgame|north star|flywheel)${B}` +
				`|${B}(?:API|attack|design) surface${B}`,
			'giu',
		),
		exempt: new RegExp(
			`${B}vector (?:search|index|store|field|embedding|db|database|similarity)|${B}(?:embedding|dense|sparse) vector${B}`,
			'iu',
		),
		fix: "Replace the metaphor noun with the plain word: base, add, way, the mechanism's real name.",
	},
	{
		name: '12 hollow superlative',
		severity: 'error',
		pattern:
			/the (most|single most) (valuable|durable|important|useful|striking)|the right call|the sharpest|earned (its|their) (way|place)|the (biggest|cleanest|best) (win|finding|part)|the one thing I would/giu,
		fix: 'Report what changed and what it cost instead of praising it.',
	},
	{
		name: '21 weak verb',
		severity: 'error',
		pattern: new RegExp(
			`${B}(serves as|stands as|boasts|has the ability to|made (a|the) decision|is configurable|provides for)${B}`,
			'giu',
		),
		fix: 'Use the plain verb: "is", "has", "can", "decided".',
	},
	{
		name: '29 faux insight',
		severity: 'error',
		pattern: /here'?s the thing|what most people miss|the (real )?truth is|the thing is|what nobody tells you/giu,
		fix: 'Delete the setup and make the claim stand alone.',
	},
	{
		name: '31 superficial -ing clause',
		severity: 'error',
		pattern: /,\s+(ensuring|highlighting|showcasing|demonstrating|underscoring|reflecting)\s/giu,
		fix: 'Replace the -ing clause with the real consequence in its own sentence, or delete it.',
	},
	{
		name: '32 weasel attribution',
		severity: 'error',
		pattern:
			/studies show|experts (believe|say|agree)|industry reports suggest|widely (regarded|believed|considered)|it is (widely|generally) (known|accepted)/giu,
		fix: 'Name the file, log, measurement or person, or cut the claim.',
	},
	{
		name: '38 excessive hedging',
		severity: 'error',
		pattern:
			/could potentially|may possibly|might potentially|it could be argued|there is a possibility that|it may be that/giu,
		fix: 'Say "may" once, or give the measurement.',
	},
	{
		name: '40 cutoff disclaimer',
		severity: 'error',
		pattern:
			/while specific details are limited|as of my (last|knowledge)|I do not have access to real-?time|without more (context|information), it/giu,
		fix: 'Find the fact or drop the claim.',
	},
	{
		name: '41 generic conclusion',
		severity: 'error',
		pattern:
			/the future looks bright|only time will tell|the possibilities are endless|remains to be seen|in conclusion,/giu,
		fix: 'State the plan or the number.',
	},
	{
		name: '28 binary contrast',
		severity: 'error',
		pattern: new RegExp(
			`${B}not (?:just |only |merely )?(?:an?|the )?[${W}' \\-]{1,35}, but(?: also)? ` +
				`|${B}it'?s not [^,.]{1,40}, it'?s |${B}not just${B}`,
			'giu',
		),
		fix: 'State the positive claim alone; drop the "not X" half.',
	},
	{
		name: '17 empty qualifier',
		severity: 'warn',
		pattern: new RegExp(
			`${B}(very|just|really|actually|essentially|exactly|arguably|significantly|typically|generally|fundamentally|importantly|strictly)${B}`,
			'giu',
		),
		fix: 'Cut the qualifier, or give the number it stands for.',
	},
	{
		name: '2 mid-sentence colon',
		severity: 'warn',
		pattern: new RegExp(`(?<=[${W}]):\\s(?!\\s*$)(?!\\s*(?:${QUOTE_TOKEN}|${CODE_TOKEN})\\b)`, 'gu'),
		fix: 'Use a colon only before a list or an example; otherwise write two plain sentences.',
	},
];


/**
 * @typedef {'error' | 'warn'} Severity
 * @typedef {'text' | 'prose' | 'bullet' | 'paragraph' | 'cell' | 'heading' | 'page'} Scope
 * @typedef {{ excerpt: string, line?: number }} Hit
 * @typedef {{ id: string, unslop: string, severity: Severity, scope: Scope, fix: string, check: (unit: any, page: Page) => Hit[] }} Rule
 * @typedef {{ rule: string, unslop: string, severity: Severity, line: number, excerpt: string, fix: string }} Finding
 */

/**
 * @param {string} s
 * @param {number} [at]
 */
function excerpt(s, at = 0) {
	const max = LIMITS.EXCERPT_CHARS;
	const clean = s.split(MASK).join('');
	if (clean.length <= max) return clean;
	const from = Math.max(0, Math.min(at - 20, clean.length - max));
	return (from > 0 ? '...' : '') + clean.slice(from, from + max).trim() + (from + max < clean.length ? '...' : '');
}

/**
 * The source line where a fragment of a unit's text sits: first source text piece that holds it.
 * @param {Unit} unit
 * @param {string} frag
 * @param {Page} page
 */
function lineFor(unit, frag, page) {
	const needle = frag.split(MASK).join('').trim().slice(0, 24);
	if (!needle) return unit.line;
	for (const p of unit.pieces) {
		const at = p.text.indexOf(needle);
		if (at >= 0) return page.lineOf(p.start + at);
	}
	return unit.line;
}

/** @param {Unit} unit */
const sentencesOf = (unit) => splitSentences(unit.text);

/** A verb or a subject pronoun before the colon means a clause, not a label. */
const CLAUSE_WORD =
	/\b(is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|should|may|might|must|wrote|said|says|put|puts|asked|asks|reads|means|shows|returns|needs|uses|gets|takes|makes|runs|holds|found|follows|looks|works|it|this|that|these|those|we|i|they|you|he|she|there|here)\b/i;

/** @param {string} s */
const labelPrefix = (s) => {
	// "Owner: x", "Why not Redis: y", "Staging: z". A time (12:30) or a URL has no space after the colon.
	const m = /^([^:.!?]{1,80}?):\s/.exec(s);
	if (!m) return null;
	const prefix = m[1].trim();
	const words = prefix.split(/\s+/).filter(Boolean);
	if (!words.length || words.length > LIMITS.LABEL_MAX_WORDS) return null;
	// A colon after a clause with a verb introduces a list or a quote ("The owner wrote: ...").
	if (CLAUSE_WORD.test(prefix)) return null;
	return prefix;
};

/** Hangul letters and jamo; any outside a quote or code make the sentence an error. */
const HANGUL = /\p{Script=Hangul}/u;

/** `2026-10-28T04:26Z`, `10-28 04:26Z`, `2026-10-28 at 04:26Z`, `04:26Z on 10-28`, then a day after "since". */
const UTC_STAMPS = [
	/(?<![\d-])(?:(\d{4})-)?(\d{2})-(\d{2})(?:T| | at )(\d{1,2}):(\d{2})(?::\d{2})?Z(?![\w])/g,
	/(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?Z (?:on|of) (?:(\d{4})-)?(\d{2})-(\d{2})(?![\d-])/g,
	/(?<![\w])[Ss]ince (?:(\d{4})-)?(\d{2})-(\d{2})(?![\d-]|T\d| (?:at )?\d{1,2}:\d{2})/g,
];
/** Clock skew a writer may have; a stamp past now by more than this is wrong. */
const FUTURE_SLACK_MS = 10 * 60 * 1000;
const HALF_YEAR_MS = 183 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** A day with no time: "on 2026-10-29" or "on 10-29", never one that a time follows. */
const ON_DAY = /(?<![\w])(?<!\d:\d{2}(?::\d{2})?Z )[Oo]n (?:(\d{4})-)?(\d{2})-(\d{2})(?![\d-]|T\d| (?:at )?\d{1,2}:\d{2})/g;
/** -ed words that set a plan or a basis, not a past event: "scheduled on 11-30", "based on 10-28". */
const NOT_PAST = wordSet(`based centered conditioned dated depended due expected focused intended keyed needed planned
	proposed relied required scheduled slated targeted timed`);
const PAST_IRREGULAR = wordSet(`began begun broke broken brought built came cut did done fell found gave got hit held
	kept left lost made met paid put ran rose sent shipped shut split spent stood took went won wrote written`);
const isPast = (/** @type {string} */ w) => {
	const lw = w.toLowerCase();
	return PAST_IRREGULAR.has(lw) || (lw.length > 3 && lw.endsWith('ed') && !NOT_PAST.has(lw));
};
/** How many words on each side of "on <day>" may hold the past verb, inside one clause. */
const PAST_REACH = 5;

/**
 * Days after a past-tense verb in a text, "removed on 2026-10-29" or "On 10-29 the job landed it", that come after
 * the UTC day of `now`. A plan day with no past verb, such as "expires on 2026-11-30", passes.
 * @param {string} text
 * @param {number} now epoch ms
 * @returns {string[]}
 */
function futurePastDays(text, now) {
	const year = new Date(now).getUTCFullYear();
	const today = Math.floor(now / DAY_MS) * DAY_MS;
	/** @type {string[]} */
	const out = [];
	for (const m of text.matchAll(ON_DAY)) {
		const at = m.index ?? 0;
		const before = text.slice(0, at).split(/[.;:!?(),]/).pop() ?? '';
		const after = m[0][0] === 'O' ? (text.slice(at + m[0].length).split(/[.;:!?()]/)[0] ?? '') : '';
		const words = [...before.split(/\s+/).slice(-PAST_REACH), ...after.split(/[\s,]+/).slice(0, PAST_REACH * 2)];
		if (!words.some((w) => isPast(w.replace(/[^A-Za-z]/g, '')))) continue;
		const [y, mo, d] = [m[1], +m[2], +m[3]];
		if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
		let t = Date.UTC(y ? +y : year, mo - 1, d);
		if (!y && t - now > HALF_YEAR_MS) t = Date.UTC(year - 1, mo - 1, d);
		if (t > today) out.push(m[0]);
	}
	return out;
}

/** Frontmatter keys that date a write or a check, so none of them may be later than the write. */
const META_DATES = ['date', 'updated', 'last_verified'];

/**
 * Frontmatter dates later than `now`: a day after the UTC day of `now`, or a time more than the clock slack past it.
 * @param {Record<string, unknown>} meta
 * @param {number} now epoch ms
 * @returns {{ key: string, value: string }[]}
 */
export function futureMetaDates(meta, now) {
	const today = Math.floor(now / DAY_MS) * DAY_MS;
	return META_DATES.flatMap((key) => {
		const value = meta[key];
		if (typeof value !== 'string') return [];
		const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
		if (!m) return [];
		const late = m[4]
			? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - now > FUTURE_SLACK_MS
			: Date.UTC(+m[1], +m[2] - 1, +m[3]) > today;
		return late ? [{ key, value }] : [];
	});
}

/**
 * The `<!--wiki {json}-->` header at the top of a page, or {} when it is missing or not JSON.
 * @param {string} html
 * @returns {Record<string, unknown>}
 */
function wikiMeta(html) {
	const m = /^\s*<!--wiki((?:(?!-->)[\s\S])*)-->/.exec(html);
	if (!m) return {};
	try {
		const meta = JSON.parse(m[1]);
		return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
	} catch {
		return {};
	}
}

/**
 * Z-stamped times in a text that are later than `now`. A stamp without a year takes the year of
 * `now`, or the year before when that lands more than half a year ahead (a December time read in January).
 * @param {string} text
 * @param {number} now epoch ms
 * @returns {string[]}
 */
export function futureUtcStamps(text, now) {
	const year = new Date(now).getUTCFullYear();
	/** @type {string[]} */
	const out = [];
	for (const [i, rx] of UTC_STAMPS.entries()) {
		for (const m of text.matchAll(rx)) {
			// A day after "since" counts from its start, so only a day after today's UTC day is refused.
			const [y, mo, d, h, mi] =
				i === 0 ? [m[1], m[2], m[3], m[4], m[5]] : i === 1 ? [m[3], m[4], m[5], m[1], m[2]] : [m[1], m[2], m[3], 0, 0];
			if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) continue;
			let t = Date.UTC(y ? +y : year, +mo - 1, +d, +h, +mi);
			if (!y && t - now > HALF_YEAR_MS) t = Date.UTC(year - 1, +mo - 1, +d, +h, +mi);
			if (t - now > FUTURE_SLACK_MS) out.push(m[0]);
		}
	}
	return [...out, ...futurePastDays(text, now)];
}

/** @type {Rule[]} */
export const RULES = [
	{
		id: 'em-dash',
		unslop: '1',
		severity: 'error',
		scope: 'text',
		fix: 'End the sentence or use a comma; do not swap in an en dash, a spaced hyphen or parentheses.',
		check: (/** @type {Unit} */ u, page) => {
			const t = mask(u.text);
			const rx = new RegExp(
				`[\\u2014]|(?<=[${W}${MASK}]) [-\\u2013]{1,2} (?=[${W}${MASK}])|(?<=[${W}])--(?=[${W}])`,
				'gu',
			);
			return [...t.matchAll(rx)].map((m) => ({
				excerpt: excerpt(u.text, m.index ?? 0),
				line: lineFor(u, u.text.slice(Math.max(0, (m.index ?? 0) - 12), m.index), page),
			}));
		},
	},
	{
		id: 'bullet-one-sentence',
		unslop: '4a',
		severity: 'error',
		scope: 'bullet',
		fix: 'Make the bullet one complete sentence; move each extra sentence to its own bullet or a paragraph.',
		check: (/** @type {Unit} */ u) => {
			if (u.linkOnly || u.codeOnly) return [];
			const n = sentencesOf(u).length;
			return n > 1 ? [{ excerpt: `${n} sentences: ${excerpt(u.text)}` }] : [];
		},
	},
	{
		id: 'bullet-fragment',
		unslop: '4a',
		severity: 'error',
		scope: 'bullet',
		fix: 'Write the bullet as a full sentence with a subject and a verb that ends in a period.',
		check: (/** @type {Unit} */ u) => {
			if (u.linkOnly || u.codeOnly) return [];
			const end = u.text.replace(/[\s"'\u201d\u2019)\]]+$/, '');
			if (u.hasNestedList && end.endsWith(':')) return [];
			if (!/[.!?]$/.test(end)) return [{ excerpt: `no end punctuation: ${excerpt(u.text)}` }];
			if (u.words < LIMITS.BULLET_MIN_WORDS) return [{ excerpt: `${u.words} words: ${excerpt(u.text)}` }];
			return [];
		},
	},
	{
		id: 'bullet-too-long',
		unslop: '4a',
		severity: 'error',
		scope: 'bullet',
		fix: `Keep a bullet to ${LIMITS.BULLET_MAX_WORDS} words; split stuffed clauses into separate bullets.`,
		check: (/** @type {Unit} */ u) =>
			u.words > LIMITS.BULLET_MAX_WORDS && !u.linkOnly ? [{ excerpt: `${u.words} words: ${excerpt(u.text)}` }] : [],
	},
	{
		id: 'label-opener',
		unslop: '4',
		severity: 'error',
		scope: 'prose',
		fix: 'Drop the bold lead-in or "Label:" prefix and write the plain sentence.',
		check: (/** @type {Unit} */ u) => {
			if (u.inTldr || u.kind === 'loose' || u.linkOnly) return [];
			if (u.firstBold) return [{ excerpt: `bold opener: ${excerpt(u.raw)}` }];
			const prefix = labelPrefix(u.text);
			return prefix ? [{ excerpt: `"${prefix}:" opener: ${excerpt(u.text)}` }] : [];
		},
	},
	{
		id: 'paragraph-blob',
		unslop: '22',
		severity: 'error',
		scope: 'paragraph',
		fix: `Split the paragraph: at most ${LIMITS.PARAGRAPH_MAX_SENTENCES} sentences and ${LIMITS.PARAGRAPH_MAX_WORDS} words each.`,
		check: (/** @type {Unit} */ u) => {
			if (u.inTldr) return [];
			const n = sentencesOf(u).length;
			if (n > LIMITS.PARAGRAPH_MAX_SENTENCES || u.words > LIMITS.PARAGRAPH_MAX_WORDS)
				return [{ excerpt: `${n} sentences, ${u.words} words: ${excerpt(u.text)}` }];
			return [];
		},
	},
	{
		id: 'paragraph-share',
		unslop: '4a',
		severity: 'error',
		scope: 'page',
		fix: `Write the body as numbered one-sentence lines in <ol>; paragraphs and <ul> bullets may hold at most ${Math.round(LIMITS.PARAGRAPH_MAX_SHARE * 100)}% of its words.`,
		check: (_u, page) => {
			const body = page.units.filter(
				(u) => !u.inTldr && !u.linkOnly && (u.kind === 'paragraph' || u.kind === 'loose' || u.kind === 'bullet'),
			);
			const total = body.reduce((n, u) => n + u.words, 0);
			if (total < LIMITS.PARAGRAPH_SHARE_MIN_WORDS) return [];
			const prose = body.filter((u) => !u.numbered);
			const share = prose.reduce((n, u) => n + u.words, 0) / total;
			return share > LIMITS.PARAGRAPH_MAX_SHARE
				? [
						{
							excerpt: `paragraphs and unnumbered bullets hold ${Math.round(share * 100)}% of ${total} body words`,
							line: prose[0].line,
						},
					]
				: [];
		},
	},
	{
		id: 'long-sentence',
		unslop: '22',
		severity: 'warn',
		scope: 'prose',
		fix: `Split any sentence over ${LIMITS.SENTENCE_MAX_WORDS} words into two.`,
		check: (/** @type {Unit} */ u, page) => {
			const all = sentencesOf(u);
			// A one-sentence bullet over the limit is already bullet-too-long.
			if (u.kind === 'bullet' && all.length < 2) return [];
			return all
				.filter((s) => countWords(s) > LIMITS.SENTENCE_MAX_WORDS)
				.map((s) => ({ excerpt: `${countWords(s)} words: ${excerpt(s)}`, line: lineFor(u, s, page) }));
		},
	},
	{
		id: 'bold-overuse',
		unslop: '3',
		severity: 'error',
		scope: 'page',
		fix: 'Keep bold for 2 or 3 short labels per page; turn bold sentences into plain text.',
		check: (_u, page) => {
			const limit = Math.max(LIMITS.BOLD_MIN_PER_PAGE, Math.floor(page.words / LIMITS.BOLD_WORDS_PER_SPAN));
			/** @type {Hit[]} */
			const hits = page.bold
				.filter((b) => b.text.length > LIMITS.BOLD_MAX_CHARS)
				.map((b) => ({ excerpt: `${b.text.length}-char bold span: ${excerpt(b.text)}`, line: b.line }));
			if (page.bold.length > limit) {
				hits.unshift({
					excerpt: `${page.bold.length} bold spans, limit ${limit}: ${page.bold
						.slice(0, 6)
						.map((b) => `L${b.line} "${excerpt(b.text).slice(0, 30)}"`)
						.join(', ')}${page.bold.length > 6 ? ', ...' : ''}`,
					line: page.bold[limit]?.line ?? page.bold[0].line,
				});
			}
			return hits;
		},
	},
	{
		id: 'table-wall',
		unslop: '24',
		severity: 'error',
		scope: 'cell',
		fix: `Keep a cell under ${LIMITS.CELL_MAX_WORDS} words; move the explanation into a sentence below the table.`,
		check: (/** @type {Unit} */ u) =>
			u.words > LIMITS.CELL_MAX_WORDS ? [{ excerpt: `${u.words}-word cell: ${excerpt(u.text)}` }] : [],
	},
	{
		id: 'table-share',
		unslop: '24',
		severity: 'error',
		scope: 'page',
		fix: `Tables may hold at most ${Math.round(LIMITS.TABLE_MAX_SHARE * 100)}% of the page's words; write the findings as sentences and keep the table for numbers.`,
		check: (_u, page) => {
			const words = page.tables.reduce((n, t) => n + t.words, 0);
			if (words < LIMITS.TABLE_SHARE_MIN_WORDS || page.words === 0) return [];
			const share = words / page.words;
			return share > LIMITS.TABLE_MAX_SHARE
				? [{ excerpt: `tables hold ${Math.round(share * 100)}% of ${page.words} words`, line: page.tables[0].line }]
				: [];
		},
	},
	{
		id: 'table-columns',
		unslop: '24',
		severity: 'warn',
		scope: 'page',
		fix: `Keep a table to ${LIMITS.TABLE_MAX_COLUMNS} columns; split it or move columns into sentences.`,
		check: (_u, page) =>
			page.tables
				.filter((t) => t.columns > LIMITS.TABLE_MAX_COLUMNS)
				.map((t) => ({ excerpt: `${t.columns} columns`, line: t.line })),
	},
	{
		id: 'visuals',
		unslop: '24',
		severity: 'error',
		scope: 'page',
		fix: `Add mermaid diagrams or images: one per ${LIMITS.LINES_PER_VISUAL} numbered lines, and one per ${LIMITS.WORDS_PER_VISUAL} words once a page passes ${LIMITS.VISUAL_MIN_WORDS} words.`,
		check: (_u, page) => {
			const lines = page.units.filter((u) => u.numbered).length;
			const byWords =
				page.words > LIMITS.VISUAL_MIN_WORDS ? Math.max(1, Math.floor(page.words / LIMITS.WORDS_PER_VISUAL)) : 0;
			const need = Math.max(byWords, Math.floor(lines / LIMITS.LINES_PER_VISUAL));
			return page.visuals.length < need
				? [
						{
							excerpt: `${page.visuals.length} diagrams or images for ${lines} numbered lines and ${page.words} words, want ${need}`,
							line: 1,
						},
					]
				: [];
		},
	},
	{
		id: 'visual-gap',
		unslop: '24',
		severity: 'error',
		scope: 'page',
		fix: `Put a diagram or image between numbered lines at least every ${LIMITS.MAX_LINES_WITHOUT_VISUAL} lines.`,
		check: (_u, page) => {
			/** @type {Hit[]} */
			const hits = [];
			const lines = page.units.filter((u) => u.numbered).sort((a, b) => a.start - b.start);
			let v = 0;
			/** @type {Unit[]} */
			let run = [];
			const close = () => {
				if (run.length > LIMITS.MAX_LINES_WITHOUT_VISUAL)
					hits.push({ excerpt: `${run.length} numbered lines with no diagram or image`, line: run[0].line });
				run = [];
			};
			for (const u of lines) {
				let crossed = false;
				while (v < page.visuals.length && page.visuals[v] < u.start) {
					v += 1;
					crossed = true;
				}
				if (crossed) close();
				run.push(u);
			}
			close();
			return hits;
		},
	},
	{
		id: 'curly-quotes',
		unslop: '7',
		severity: 'warn',
		scope: 'text',
		fix: 'Use straight quotes and apostrophes.',
		check: (/** @type {Unit} */ u, page) => {
			const m = /[\u2018\u2019\u201c\u201d]/.exec(u.raw);
			return m
				? [{ excerpt: excerpt(u.raw, m.index), line: lineFor(u, u.raw.slice(m.index, m.index + 12), page) }]
				: [];
		},
	},
	{
		id: '8 italics',
		unslop: '8',
		severity: 'warn',
		scope: 'page',
		fix: 'Drop the italics and fix the word order instead.',
		check: (_u, page) => page.italics.map((s) => ({ excerpt: excerpt(s.text), line: s.line })),
	},
	{
		id: '5 title case heading',
		unslop: '5',
		severity: 'warn',
		scope: 'heading',
		fix: 'Write the heading in sentence case.',
		check: (/** @type {Unit} */ u) => {
			const words = u.text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && w !== CODE_TOKEN && w !== QUOTE_TOKEN);
			if (words.length < 3) return [];
			const capped = words.filter((w, i) => i > 0 && /^[A-Z][a-z]/.test(w));
			return capped.length >= 2 && capped.length >= words.length - 2 ? [{ excerpt: excerpt(u.text) }] : [];
		},
	},
	{
		// Owner rule c2, repeated as c102 on 2026-10-18 after the bloat, soft-caps and multi-box
		// design pages were written in Korean. A page may still quote the owner as he wrote: text in
		// double quotes, <q>, <blockquote> and code is gone from u.text before this check runs.
		// Korean on purpose, such as a ko article, is marked lang="ko" and passes.
		id: 'english-only',
		unslop: 'wiki',
		severity: 'error',
		scope: 'text',
		fix: 'Write the page in English; keep Korean only inside a quote of the owner ("...", <q>, <blockquote>) or code.',
		check: (/** @type {Unit} */ u, page) =>
			u.ko || page.ko
				? []
				: u.text
						.split(/(?<=[.!?\u3002])\s+/u)
						.filter((s) => HANGUL.test(s))
						.map((s) => ({ excerpt: `Korean outside a quote: ${excerpt(s)}`, line: lineFor(u, s, page) })),
	},
	{
		id: 'session-link',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		fix: 'Link the curated page the session graduated to, or the session log index.html, because only the log is in git.',
		check: (_u, page) => {
			if (!CURATED_PAGE.test(page.path) && page.path !== 'index.html') return [];
			return page.links.flatMap((l) => {
				const target = sessionArtifactLink(l.href, page.path);
				return target ? [{ excerpt: `links into session folder "${target}"`, line: l.line }] : [];
			});
		},
	},
	{
		// A time with a Z is a past UTC event, so one later than the write is a date in the wrong zone.
		// On 2026-10-27 four curated pages dated 3abfc49767, committed 20:11Z on 10-27, as "04:26Z on
		// 10-28", the owner's KST day. A day after a past-tense verb ("removed on 2026-10-29") is a past event too,
		// and a plan date with no past verb, such as an expiry, stays allowed.
		id: 'future-utc-time',
		unslop: 'wiki',
		severity: 'error',
		scope: 'text',
		fix: 'Write the UTC day and time, such as the commit\'s own `git log -1 --format=%cI <sha>`, never the KST day.',
		check: (/** @type {Unit} */ u, page) =>
			futureUtcStamps(u.text, page.now).map((s) => ({
				excerpt: `"${s}" is later than the write: ${excerpt(u.text, u.text.indexOf(s))}`,
				line: lineFor(u, s, page),
			})),
	},
	{
		// The wiki header dates the write, so a date later than the write is the KST day. On 2026-10-28 at 15:30Z a
		// job wrote "updated": "2026-10-29" into linkedin/fields.html, and the wiki host committed it in dbaf9ad972.
		id: 'future-meta-date',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		fix: 'Set date, updated and last_verified to the UTC day or time of the write, never the KST day.',
		check: (_u, page) =>
			futureMetaDates(page.meta, page.now).map(({ key, value }) => ({
				excerpt: `"${key}": "${value}" is later than the write`,
				line: 2,
			})),
	},
	...WORD_RULES.map(
		(w) =>
			/** @type {Rule} */ ({
				id: w.name,
				unslop: w.name.split(' ')[0],
				severity: w.severity,
				scope: 'text',
				fix: w.fix,
				check: (/** @type {Unit} */ u, /** @type {Page} */ page) => {
					const t = mask(u.text);
					/** @type {Hit[]} */
					const hits = [];
					for (const m of t.matchAll(new RegExp(w.pattern.source, w.pattern.flags))) {
						const frag = m[0];
						if (w.exempt && w.exempt.test(t.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + frag.length + 20)))
							continue;
						hits.push({
							excerpt: `"${frag.trim()}" in: ${excerpt(u.text, m.index ?? 0)}`,
							line: lineFor(u, frag, page),
						});
					}
					return hits;
				},
			}),
	),
];

/** @type {Record<Scope, (u: Unit) => boolean>} */
const SCOPE = {
	text: () => true,
	prose: (u) => u.kind === 'bullet' || u.kind === 'paragraph' || u.kind === 'loose',
	bullet: (u) => u.kind === 'bullet',
	paragraph: (u) => u.kind === 'paragraph' || (u.kind === 'loose' && !u.inTldr),
	cell: (u) => u.kind === 'cell',
	heading: (u) => u.kind === 'heading',
	page: () => false,
};

/**
 * @typedef {{ errors: number, warns: number, byRule: Record<string, { errors: number, warns: number }> }} Counts
 */

/**
 * @param {Finding[]} findings
 * @returns {Counts}
 */
export function countFindings(findings) {
	/** @type {Counts} */
	const counts = { errors: 0, warns: 0, byRule: {} };
	for (const f of findings) {
		const row = (counts.byRule[f.rule] ??= { errors: 0, warns: 0 });
		if (f.severity === 'error') {
			counts.errors += 1;
			row.errors += 1;
		} else {
			counts.warns += 1;
			row.warns += 1;
		}
	}
	return counts;
}

/**
 * Lint one HTML page.
 * @param {string} html
 * @param {{ path?: string, now?: number }} [opts]
 * @returns {{ findings: Finding[], counts: Counts }}
 */
export function lintHtml(html, opts = {}) {
	const page = parsePage(html, opts);
	/** @type {Finding[]} */
	const findings = [];
	for (const rule of RULES) {
		/**
		 * @param {Hit} h
		 * @param {number} line
		 */
		const add = (h, line) =>
			findings.push({
				rule: rule.id,
				unslop: rule.unslop,
				severity: rule.severity,
				line: h.line ?? line,
				excerpt: h.excerpt,
				fix: rule.fix,
			});
		if (rule.scope === 'page') {
			for (const h of rule.check(null, page)) add(h, 1);
			continue;
		}
		const take = SCOPE[rule.scope];
		for (const u of page.units) {
			if (!take(u)) continue;
			// A label opener already reports its colon; do not count it twice.
			if (rule.id === '2 mid-sentence colon' && labelPrefix(u.text)) continue;
			for (const h of rule.check(u, page)) add(h, u.line);
		}
	}
	findings.sort((a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
	return { findings, counts: countFindings(findings) };
}

/**
 * Compare a write against the content it replaces. The write passes unless some rule has
 * more errors after than before; a new file counts as before = 0 errors. Pages with old
 * debt stay editable, and no edit can add debt.
 * @param {string | null} before
 * @param {string} after
 * @param {{ path?: string, now?: number }} [opts]
 * @returns {{ ok: boolean, grown: Record<string, { before: number, after: number }>, newFindings: Finding[], before: Counts, after: Counts }}
 */
export function ratchet(before, after, opts = {}) {
	const old = before ? lintHtml(before, opts) : { findings: [], counts: countFindings([]) };
	const cur = lintHtml(after, opts);
	/** @type {Record<string, { before: number, after: number }>} */
	const grown = {};
	for (const [rule, row] of Object.entries(cur.counts.byRule)) {
		const was = old.counts.byRule[rule]?.errors ?? 0;
		if (row.errors > was) grown[rule] = { before: was, after: row.errors };
	}
	// Name the new findings: errors of a grown rule whose excerpt the old page did not have.
	/** @type {Map<string, number>} */
	const seen = new Map();
	for (const f of old.findings)
		if (f.severity === 'error') seen.set(`${f.rule}\n${f.excerpt}`, (seen.get(`${f.rule}\n${f.excerpt}`) ?? 0) + 1);
	/** @type {Finding[]} */
	let newFindings = [];
	for (const f of cur.findings) {
		if (f.severity !== 'error' || !grown[f.rule]) continue;
		const key = `${f.rule}\n${f.excerpt}`;
		const left = seen.get(key) ?? 0;
		if (left > 0) seen.set(key, left - 1);
		else newFindings.push(f);
	}
	if (!newFindings.length) newFindings = cur.findings.filter((f) => f.severity === 'error' && grown[f.rule]);
	return { ok: Object.keys(grown).length === 0, grown, newFindings, before: old.counts, after: cur.counts };
}
