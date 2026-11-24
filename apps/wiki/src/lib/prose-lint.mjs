// Prose lint for llm-wiki HTML pages against sieun-pi `skills/wiki/references/writing.md` and unslop.
// Pure module; the write API, scripts/prose-lint.mjs and scripts/repo/agent/commit.mjs call it.
import { isSessionLogPath, sessionFolderLink } from './session-links.mjs';

/** The standard a finding points the writer to. */
export const STANDARD_FILE = 'skills/wiki/references/writing.md in sieun-pi (~/.prime/agent/skills/wiki/references/writing.md)';

export const LIMITS = Object.freeze({
	/** A bullet longer than this is stuffed clauses. */
	BULLET_MAX_WORDS: 30,
	/** A bullet shorter than this is a fragment. */
	BULLET_MIN_WORDS: 4,
	/** A sentence longer than this is hard to read at speech pace (warn). */
	SENTENCE_MAX_WORDS: 30,
	/** A page over this many words needs a diagram or image... */
	VISUAL_MIN_WORDS: 300,
	/** ...and one more for every this many words. */
	WORDS_PER_VISUAL: 400,
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
	/** A paragraph, or a step of a numbered list, holds at most this many sentences... */
	DOC_PARAGRAPH_MAX_SENTENCES: 4,
	/** ...and at most this many words, 4 sentences of about 25. */
	DOC_PARAGRAPH_MAX_WORDS: 100,
	/** An explanation page over VISUAL_MIN_WORDS needs one diagram or image per this many words. */
	DOC_WORDS_PER_VISUAL: 800,
	/** An owner design page (doc_kind design) stays under this many words, per owner rules c83 and c201. */
	DESIGN_MAX_WORDS: 800,
	/**
	 * An apps/ or domains/ page past this many words, outside link-only lines, gets a soft core-length warning (c98).
	 * Owner, 2026-11-24 (#dev-crawler p23, c243): such a page holds only the layers a reader can check. 800 is the design
	 * page size he accepted under c201, and the 2,267-word domains/devops/clickhouse-layout.html drew "겁나 길어".
	 */
	CURATED_MAX_WORDS: 800,
	/** A mermaid flowchart with more nodes than this and no subgraph is a flat graph a person cannot place (warn). */
	DIAGRAM_FLAT_NODES: 12,
	/** A diagram label that counts this few things of one kind names instances the diagram should draw one by one (warn). */
	DIAGRAM_MAX_DRAWN: 4,
});

/**
 * The page kinds a page declares in the `doc_kind` field of its `<!--wiki {json}-->` header. Every page reads as plain
 * prose under headings, because the owner finds strings of numbered one-sentence lines unreadable (c235, c243; #dev-crawler
 * p19 "no the llm-wiki is unreadable", 2026-11-24). The first five kinds are the documentation pages he asked for on
 * 2026-11-23 (#sw-factory-build p174, msg mwtd0iuy) and add their section rules; design is a short page for his decision
 * (c83, c201). The header's older `kind` field is a free label that 550 pages set to "reference", so it decides nothing here.
 */
export const DOC_KINDS = Object.freeze(['start', 'tutorial', 'how-to', 'reference', 'explanation', 'design']);
/** The documentation kinds, which open with an intro paragraph and carry their own section and diagram rules. */
const PROSE_KINDS = new Set(['start', 'tutorial', 'how-to', 'reference', 'explanation']);
/** @param {string | null} k */
const isProse = (k) => k !== null && PROSE_KINDS.has(k);
/** A page with no doc_kind, or a design page, keeps the page-wide diagram count of `visuals`. @param {string | null} k */
const countsVisuals = (k) => !isProse(k);

/**
 * True when a page's header sets a prose doc_kind. Such a page numbers each step list from 1, so the page API leaves
 * its <ol> start= values as written (scripts/ol-numbering.mjs).
 * @param {string} html
 */
export function isProseDocPage(html) {
	const k = wikiMeta(html).doc_kind;
	return typeof k === 'string' && PROSE_KINDS.has(k);
}

/**
 * The headings a documentation page must have, by doc_kind, matched on the heading text in lower case.
 * @type {Record<string, { name: string, rx: RegExp }[]>}
 */
const DOC_SECTIONS = {
	start: [{ name: 'Start here', rx: /^start here\b/ }],
	tutorial: [
		{ name: 'Before you start', rx: /^before you (?:start|begin)\b/ },
		{ name: 'Check it worked', rx: /^check (?:that )?it work/ },
		{ name: 'When it goes wrong', rx: /^when (?:it|something|things) goes? wrong\b/ },
		{ name: 'Next steps', rx: /^(?:next steps?|what'?s next|where to go next)\b/ },
	],
	'how-to': [
		{ name: 'Before you start', rx: /^before you (?:start|begin)\b/ },
		{ name: 'Check it worked', rx: /^check (?:that )?it work/ },
		{ name: 'When it goes wrong', rx: /^when (?:it|something|things) goes? wrong\b/ },
	],
};



/**
 * True when a content-relative path is a page this lint judges. Session and job logs are API-managed,
 * requests.html holds verbatim asks, and archive/ is frozen history moved in as it was.
 * @param {string} relPath path relative to the wiki content root
 */
export function isLintedPath(relPath) {
	const rel = contentRel(relPath);
	if (!rel.endsWith('.html')) return false;
	if (rel === 'requests.html' || rel.endsWith('/requests.html')) return false;
	if (isSessionLogPath(rel)) return false;
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
/** A page under apps/ or domains/, which holds only the layers a reader can check (owner, #dev-crawler p23, c243). */
const isCoreLayerPath = (/** @type {string} */ rel) => /^(?:apps|domains)\/(?!.*\/(?:data|assets)\/).*\.html$/.test(rel);
/** A page's words outside link-only lines, such as a hub's list of pages. @param {Page} page */
const coreWords = (page) => page.units.reduce((n, u) => n + (u.linkOnly || u.inTldr ? 0 : u.words), 0);
/** A wiki URL on any host that serves it on :5176: the server in hosts.json, or the Mac's old localhost wiki. */
const WIKI_ORIGIN = /^https?:\/\/[^/\s]+:5176(?=\/)/i;

/**
 * The sessionFolderLink finding (session-links.mjs) for a curated page's href, else null: a link to a file in a session
 * or job folder other than its log `index.html`.
 * @param {string} href
 * @param {string} pagePath content-relative path of the linking page
 * @returns {{ target: string, log: string | null } | null}
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
	return sessionFolderLink(parts.join('/'));
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
 * @typedef {'bullet' | 'paragraph' | 'loose' | 'cell' | 'heading' | 'caption' | 'step'} UnitKind
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
 *   docKind: string | null, steps: { line: number, text: string, proof: boolean }[], proofs: number[],
 *   diagrams: { src: string, line: number }[], hasDl: boolean,
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
 * The source of every mermaid block outside an HTML comment, entities decoded, with the line it starts on.
 * @param {string} html
 * @param {(offset: number) => number} lineOf
 * @returns {{ src: string, line: number }[]}
 */
function mermaidSources(html, lineOf) {
	const comments = [...html.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
	const block = /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>|<wiki-mermaid\b[^>]*>([\s\S]*?)<\/wiki-mermaid\s*>/gi;
	/** @type {{ src: string, line: number }[]} */
	const out = [];
	for (const m of html.matchAll(block)) {
		const at = m.index ?? 0;
		if (comments.some(([from, to]) => at >= from && at < to)) continue;
		if (m[2] !== undefined && !/\bclass\s*=\s*["']?[^"'>]*\bmermaid\b/i.test(m[1])) continue;
		out.push({ src: decodeEntities((m[2] ?? m[3] ?? '').replace(/<br\s*\/?>/gi, ' ')), line: lineOf(at) });
	}
	return out;
}

/** Plural nouns that name things a diagram should draw one by one when there are only a few of them. */
const INSTANCE_NOUN =
	'(?:boxes|hosts|machines|servers|tiers|workers|replicas|shards|instances|nodes|pods|containers|threads|agents|accounts|copies|regions|clusters|databases|queues|services|processes|relays|browsers|tabs|sessions)';
const NUMBER_WORD = { two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * A flowchart's node ids, whether it groups nodes in a subgraph, and each node label that counts a few instances of
 * one kind ("3 tiers", "workers x3"), which a person reads faster as that many boxes (owner, #dev-crawler p23).
 * @param {string} src
 * @returns {{ flowchart: boolean, nodes: number, subgraph: boolean, counted: string[] }}
 */
function readFlowchart(src) {
	const flowchart = /^\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\b/i.test(src);
	const labels = [...src.matchAll(/"([^"]*)"|\[([^\]"]*)\]|\(([^)"]*)\)|\{([^}"]*)\}|\|([^|"]*)\|/g)].map((m) =>
		(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim(),
	);
	const counted = labels.filter((label) => {
		const words = new RegExp(`\\b([2-9]|two|three|four|five|six)\\s+${INSTANCE_NOUN}\\b`, 'i').exec(label);
		const times = /(?:^|\s)[x\u00d7]\s?([2-9])(?:\s|$)|(?:^|\s)([2-9])\s?[x\u00d7](?:\s|$)/i.exec(label);
		const n = words ? (NUMBER_WORD[/** @type {keyof NUMBER_WORD} */ (words[1].toLowerCase())] ?? Number(words[1])) : times ? Number(times[1] ?? times[2]) : 0;
		return n >= 2 && n <= LIMITS.DIAGRAM_MAX_DRAWN;
	});
	const bare = src.replace(/"[^"]*"/g, '""').replace(/\|[^|]*\|/g, '');
	const ids = new Set();
	for (const line of bare.split('\n')) {
		if (/^\s*(?:flowchart|graph|subgraph|end\b|direction|classDef|class\s|style|linkStyle|click|%%)/i.test(line)) continue;
		for (const m of line.matchAll(/(?:^|[\s;&>-])([A-Za-z_][\w]*)\s*(?=\[|\(|\{|>|@\{)/g)) ids.add(m[1]);
	}
	return { flowchart, nodes: ids.size, subgraph: /^\s*subgraph\b/im.test(src), counted };
}

/**
 * Source offsets of every code block, diagram and image, in document order: what shows a step's command, output or screen.
 * @param {El} el
 * @param {number[]} out
 * @returns {number[]}
 */
function findProofs(el, out = []) {
	for (const node of el.children) {
		if (node.type !== 'el') continue;
		const cls = attr(node.attrs, 'class');
		if (node.tag === 'pre' || VISUAL.has(node.tag) || (cls !== null && /(^|\s)mermaid(\s|$)/.test(cls))) out.push(node.start);
		else findProofs(node, out);
	}
	return out;
}

/**
 * The items of every `<ol>` that sits in no list item, table or `<wiki-tldr>`: the steps of a tutorial or how-to.
 * @param {El} el
 * @param {(offset: number) => number} lineOf
 * @param {{ line: number, text: string, proof: boolean }[]} out
 */
function findSteps(el, lineOf, out = []) {
	for (const node of el.children) {
		if (node.type !== 'el' || node.tag === 'li' || node.tag === 'table' || node.tag === 'wiki-tldr' || isSkipped(node))
			continue;
		if (node.tag !== 'ol') {
			findSteps(node, lineOf, out);
			continue;
		}
		for (const li of node.children) {
			if (li.type !== 'el' || li.tag !== 'li') continue;
			const acc = newAcc();
			gather(li, false, false, acc, () => {});
			out.push({ line: lineOf(li.start), text: squash(acc.raw), proof: findProofs(li).length > 0 });
		}
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
		docKind: null,
		steps: [],
		proofs: [],
		diagrams: [],
		hasDl: false,
	};
	page.docKind = typeof page.meta.doc_kind === 'string' ? page.meta.doc_kind : null;
	const root = parseHtml(html);
	page.visuals = findVisuals(root);
	page.proofs = findProofs(root);
	page.diagrams = mermaidSources(html, lineOf);
	page.hasDl = /<dl\b/i.test(html.replace(/<!--[\s\S]*?-->/g, ''));
	if (isProse(page.docKind)) page.steps = findSteps(root, lineOf);

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
		// A numbered item is a step in order, which holds a short paragraph, not a one-sentence line (c243).
		if (numbered && tag === 'li') kind = 'step';
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
 * @typedef {{ id: string, unslop: string, severity: Severity, scope: Scope, fix: string, check: (unit: any, page: Page) => Hit[], when?: (docKind: string | null) => boolean }} Rule
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

/** The fix both session link rules name. */
const SESSION_LINK_FIX =
	'Link the log index.html named in the finding instead of a file inside a session or job folder, and move the fact ' +
	'you linked into this line or into the curated page that owns it.';

/**
 * One hit per link of a curated page or the home page into a session or job folder past its log, for the targets
 * `pick` keeps. The excerpt names the log to link instead.
 * @param {Page} page
 * @param {(target: string) => boolean} pick
 * @returns {Hit[]}
 */
function sessionLinkHits(page, pick) {
	if (!CURATED_PAGE.test(page.path) && page.path !== 'index.html') return [];
	return page.links.flatMap((l) => {
		const found = sessionArtifactLink(l.href, page.path);
		if (!found || !pick(found.target)) return [];
		const instead = found.log ? `link its log "${found.log}"` : 'link a session log index.html';
		return [{ excerpt: `links into session folder "${found.target}"; ${instead}`, line: l.line }];
	});
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
		// A reference page is tables with short prose between them.
		when: (k) => k !== 'reference',
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
		when: countsVisuals,
		fix: `Add a mermaid diagram or image: one per ${LIMITS.WORDS_PER_VISUAL} words once a page passes ${LIMITS.VISUAL_MIN_WORDS} words.`,
		check: (_u, page) => {
			const byWords =
				page.words > LIMITS.VISUAL_MIN_WORDS ? Math.max(1, Math.floor(page.words / LIMITS.WORDS_PER_VISUAL)) : 0;
			// Owner rule c83 gives a design page one diagram, and design-length already caps its size.
			const need = page.docKind === 'design' ? 1 : byWords;
			return page.visuals.length < need
				? [{ excerpt: `${page.visuals.length} diagrams or images for ${page.words} words, want ${need}`, line: 1 }]
				: [];
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
		fix: SESSION_LINK_FIX,
		check: (_u, page) => sessionLinkHits(page, (target) => target.startsWith('sessions/')),
	},
	{
		// A warning first, by owner rules c81 and c98. On 2026-11-22 at 03:57Z the page API took two contact-discovery
		// pages that linked a verdict.html inside a pi-host job folder with no word to the writer, and the 05:00Z wiki
		// dream precheck counted 2 session links. Those were the only 2 such writes in 7,192 curated revisions from
		// 11-08 to 11-22, so the rule turns into an error only once warned writers keep such links.
		id: 'job-folder-link',
		unslop: 'wiki',
		severity: 'warn',
		scope: 'page',
		fix: SESSION_LINK_FIX,
		check: (_u, page) => sessionLinkHits(page, (target) => !target.startsWith('sessions/')),
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
	{
		id: 'doc-kind',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		fix: `Set doc_kind to one of ${DOC_KINDS.join(', ')}, or leave it out for a numbered-line page.`,
		check: (_u, page) =>
			page.docKind !== null && !DOC_KINDS.includes(page.docKind)
				? [{ excerpt: `"doc_kind": "${page.docKind}" is not a page kind`, line: 2 }]
				: [],
	},
	{
		// Owner, 2026-11-23 (#sw-factory-build p174, msg mwtd0iuy): "think of writing an actual confluence tutorial page
		// like as to onboard me", and 2026-11-24 (#dev-crawler p19): "the llm-wiki is unreadable". Every page reads as
		// paragraphs of two to four sentences, and a numbered step holds the same.
		id: 'doc-paragraph',
		unslop: '20',
		severity: 'error',
		scope: 'paragraph',
		fix: `Keep a paragraph or step to ${LIMITS.DOC_PARAGRAPH_MAX_SENTENCES} sentences and ${LIMITS.DOC_PARAGRAPH_MAX_WORDS} words; start a new paragraph for the next idea.`,
		check: (/** @type {Unit} */ u) => {
			if (u.inTldr) return [];
			const n = sentencesOf(u).length;
			if (n > LIMITS.DOC_PARAGRAPH_MAX_SENTENCES || u.words > LIMITS.DOC_PARAGRAPH_MAX_WORDS)
				return [{ excerpt: `${n} sentences, ${u.words} words: ${excerpt(u.text)}` }];
			return [];
		},
	},
	{
		id: 'doc-intro',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		when: isProse,
		fix: 'Open the page under the <h1> with a <p> that says who the page is for and what they have at the end, with no <wiki-tldr>.',
		check: (_u, page) => {
			/** @type {Hit[]} */
			const hits = [];
			const tldr = page.units.find((u) => u.inTldr);
			if (tldr) hits.push({ excerpt: `a <wiki-tldr> block: ${excerpt(tldr.text)}`, line: tldr.line });
			const body = page.units.filter((u) => !u.inTldr && u.kind !== 'caption');
			const h1 = body.findIndex((u) => u.tag === 'h1');
			const first = body[h1 + 1];
			if (!first || first.tag !== 'p')
				hits.push({ excerpt: `the page opens with ${first ? `<${first.tag}>` : 'nothing'} under its title, not an intro paragraph`, line: first?.line ?? 1 });
			return hits;
		},
	},
	{
		id: 'doc-sections',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		when: (k) => k !== null && k in DOC_SECTIONS,
		fix: 'Add each missing section under that heading, and show a command and its output or a screenshot under Check it worked.',
		check: (_u, page) => {
			const heads = page.units
				.filter((u) => u.kind === 'heading' && /^h[2-4]$/.test(u.tag))
				.map((u) => ({ u, text: u.text.toLowerCase().replace(/^[\d.\s\u00b7-]+/, '').trim() }));
			/** @type {Hit[]} */
			const hits = [];
			for (const want of DOC_SECTIONS[/** @type {string} */ (page.docKind)]) {
				const at = heads.findIndex((h) => want.rx.test(h.text));
				if (at === -1) {
					hits.push({ excerpt: `no "${want.name}" heading`, line: 1 });
					continue;
				}
				if (want.name !== 'Check it worked') continue;
				const from = heads[at].u.start;
				const to = heads.slice(at + 1).find((h) => h.u.tag <= heads[at].u.tag)?.u.start ?? Infinity;
				if (!page.proofs.some((p) => p > from && p < to))
					hits.push({ excerpt: '"Check it worked" shows no command output, code block or screenshot', line: heads[at].u.line });
			}
			return hits;
		},
	},
	{
		// Owner, 2026-11-23 (p174): a tutorial onboards him step by step, so each step shows the real command and what it
		// printed, or a screenshot of the screen it changed.
		id: 'doc-step-proof',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		when: (k) => k === 'tutorial' || k === 'how-to',
		fix: 'Put the real command in a <pre><code> block inside the step, with its output or a screenshot after it.',
		check: (_u, page) =>
			page.steps.filter((s) => !s.proof).map((s) => ({ excerpt: `step with no code block or image: ${excerpt(s.text)}`, line: s.line })),
	},
	{
		id: 'doc-diagram',
		unslop: '24',
		severity: 'error',
		scope: 'page',
		when: (k) => k === 'explanation',
		fix: `Draw the flow or structure the page explains as a mermaid diagram: one per ${LIMITS.DOC_WORDS_PER_VISUAL} words once the page passes ${LIMITS.VISUAL_MIN_WORDS} words.`,
		check: (_u, page) => {
			if (page.words <= LIMITS.VISUAL_MIN_WORDS) return [];
			const need = Math.max(1, Math.floor(page.words / LIMITS.DOC_WORDS_PER_VISUAL));
			return page.visuals.length < need
				? [{ excerpt: `${page.visuals.length} diagrams or images for ${page.words} words, want ${need}`, line: 1 }]
				: [];
		},
	},
	{
		// Owner rules c83 and c201: a design page for his decision is about 1/10 of a spec, with one diagram.
		id: 'design-length',
		unslop: 'wiki',
		severity: 'error',
		scope: 'page',
		when: (k) => k === 'design',
		fix: `Cut the design page to ${LIMITS.DESIGN_MAX_WORDS} words; move detail to a reference or explanation page and link it.`,
		check: (_u, page) =>
			page.words > LIMITS.DESIGN_MAX_WORDS ? [{ excerpt: `${page.words} words`, line: 1 }] : [],
	},
	{
		// Owner, 2026-11-24 (#dev-crawler p23, msg mwtwsw4j, c243): a page under apps/ or domains/ holds only the core a
		// reader can check, and the long write-up stays in the writer's session folder.
		id: 'core-length',
		unslop: 'wiki',
		severity: 'warn',
		scope: 'page',
		when: (k) => k !== 'start' && k !== 'tutorial' && k !== 'how-to',
		fix: `Keep an apps/ or domains/ page near ${LIMITS.CURATED_MAX_WORDS} words of the layers a reader can check (flow or call stack, tables, fields), and move the rest to a session page you link.`,
		check: (_u, page) => {
			if (!isCoreLayerPath(page.path)) return [];
			const words = coreWords(page);
			return words > LIMITS.CURATED_MAX_WORDS
				? [{ excerpt: `${words} words, target ${LIMITS.CURATED_MAX_WORDS}`, line: 1 }]
				: [];
		},
	},
	{
		// Owner, 2026-11-24 (#dev-crawler p23, c243): "확인 가능한 실질적인 레이어 (flow/call stack, tables, fields)".
		id: 'core-layers',
		unslop: 'wiki',
		severity: 'warn',
		scope: 'page',
		when: (k) => k !== 'start',
		fix: 'Show a layer a reader can check against the system: a flow or call stack as a diagram or numbered steps, a table, a field list or a code block.',
		check: (_u, page) => {
			if (!isCoreLayerPath(page.path)) return [];
			const linkOnly = page.units.filter((u) => u.linkOnly).length;
			if (linkOnly * 2 >= page.units.length) return [];
			const layer = page.tables.length > 0 || page.proofs.length > 0 || page.hasDl || page.units.some((u) => u.numbered);
			return layer ? [] : [{ excerpt: 'no diagram, numbered steps, table, field list or code block', line: 1 }];
		},
	},
	{
		// Owner, 2026-11-24 (#dev-crawler p23, c243): a diagram is drawn for a person, with "proper placing & hierarchy,
		// shapes, things that are multiple -> 여러개".
		id: 'diagram-shape',
		unslop: 'wiki',
		severity: 'warn',
		scope: 'page',
		fix: `Draw a few instances as that many nodes instead of one node with a count, and group a flowchart over ${LIMITS.DIAGRAM_FLAT_NODES} nodes in subgraphs or split it into two diagrams.`,
		check: (_u, page) => {
			if (!isCoreLayerPath(page.path)) return [];
			/** @type {Hit[]} */
			const hits = [];
			for (const d of page.diagrams) {
				const f = readFlowchart(d.src);
				if (!f.flowchart) continue;
				for (const label of f.counted) hits.push({ excerpt: `one node counts instances: "${excerpt(label)}"`, line: d.line });
				if (f.nodes > LIMITS.DIAGRAM_FLAT_NODES && !f.subgraph)
					hits.push({ excerpt: `${f.nodes} nodes with no subgraph`, line: d.line });
			}
			return hits;
		},
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
	prose: (u) => u.kind === 'bullet' || u.kind === 'paragraph' || u.kind === 'loose' || u.kind === 'step',
	bullet: (u) => u.kind === 'bullet',
	paragraph: (u) => u.kind === 'paragraph' || u.kind === 'step' || (u.kind === 'loose' && !u.inTldr),
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
		if (rule.when && !rule.when(page.docKind)) continue;
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
 * @returns {{ ok: boolean, grown: Record<string, { before: number, after: number }>, newFindings: Finding[], findings: Finding[], before: Counts, after: Counts }}
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
	return {
		ok: Object.keys(grown).length === 0,
		grown,
		newFindings,
		findings: cur.findings,
		before: old.counts,
		after: cur.counts,
	};
}

/**
 * What a saved page write answers about the findings the ratchet let through: every warning and every error of old
 * debt, so the writer fixes them from the write answer instead of linting after the write and writing again. On
 * 2026-11-04 wiki-dream writers made 10 extra revisions in 7 days that way. Null when the page is clean.
 * @param {Finding[]} findings the findings of the saved content, as ratchet returns them
 * @returns {{ lint: { line: number, rule: string, severity: Severity, excerpt: string, fix: string }[], warning: string } | null}
 */
export function savedLintAnswer(findings) {
	if (!findings.length) return null;
	/** @type {Map<string, number>} */
	const byRule = new Map();
	for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
	const rules = [...byRule].map(([rule, n]) => `${rule} ${n}`).join(', ');
	return {
		lint: findings.map((f) => ({ line: f.line, rule: f.rule, severity: f.severity, excerpt: f.excerpt, fix: f.fix })),
		warning:
			`prose lint: the page is saved with ${findings.length} finding(s) (${rules}). ` +
			`Fix each one in "lint" in your next write of this page; the write answer lists what is left.`,
	};
}
