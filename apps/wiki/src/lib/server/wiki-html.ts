import { META_LIST_KEYS, META_STRING_KEYS, type WikiMeta } from './wiki-frontmatter';

/**
 * Pure helpers for wiki pages: `<!--wiki {json}-->` metadata and index-time summary extraction (title, headings, hrefs,
 * excerpt, search tokens). It imports nothing from `wiki.ts`, so `wiki.ts` can import it without a cycle.
 */

export const META_COMMENT = /<!--\s*wiki\s*([\s\S]*?)-->/i;
const TAG = /<[^>]+>/g;
/** Any character reference — named, decimal, or hex. */
const ENTITY_REF = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,10});/gi;
/**
 * The named references this wiki's authored HTML actually uses, measured across every
 * page: `&middot;` alone appears 827 times in headings, because it is the separator in
 * THE PAGE FORMAT ("1 · Why X"). Anything outside this table decodes to nothing rather
 * than leaking a half-decoded `&foo;` into a title.
 */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	middot: '\u00b7',
	mdash: '\u2014',
	ndash: '\u2013',
	hellip: '\u2026',
	larr: '\u2190',
	rarr: '\u2192',
	harr: '\u2194',
	times: '\u00d7',
	ge: '\u2265',
	le: '\u2264',
	sect: '\u00a7',
	ldquo: '\u201c',
	rdquo: '\u201d',
	lsquo: '\u2018',
	rsquo: '\u2019',
	deg: '\u00b0',
	copy: '\u00a9',
	trade: '\u2122',
};

/** Decode character references in one pass; chained `.replace()` calls would turn `&amp;lt;` into `<`. */
export function decodeHtmlEntities(text: string): string {
	return text.replace(ENTITY_REF, (match, ref: string) => {
		if (ref.startsWith('#')) {
			const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
	});
}

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(value: string): string {
	return escapeHtml(value).replace(/"/g, '&quot;');
}

/** Parse the leading `<!--wiki { ... json ... }-->` block into the view fields. */
export function parseHtmlMeta(content: string): WikiMeta {
	const meta: WikiMeta = { apps: [], tags: [] };
	const match = content.match(META_COMMENT);
	if (!match) return meta;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(match[1].trim()) as Record<string, unknown>;
	} catch {
		return meta; // malformed meta → empty (page still indexes)
	}
	for (const key of META_STRING_KEYS) {
		if (typeof raw[key] === 'string') (meta as Record<string, unknown>)[key] = raw[key];
	}
	for (const key of META_LIST_KEYS) {
		if (Array.isArray(raw[key])) {
			(meta as Record<string, unknown>)[key] = raw[key].filter((x): x is string => typeof x === 'string');
		}
	}
	return meta;
}

/** Strip the wiki meta comment so it never reaches the rendered output. */
export function stripHtmlMeta(content: string): string {
	return content
		.replace(META_COMMENT, '')
		.replace(/^\s*\n/, '')
		.trimStart();
}

/** Collapse HTML to its visible text (for titles, headings, excerpts, the table of contents). */
export function stripHtmlTags(html: string): string {
	return decodeHtmlEntities(html.replace(TAG, ' ')).replace(/\s+/g, ' ').trim();
}

/** First `<h1>` text, or null (caller falls back to a filename-derived title). */
export function extractHtmlTitle(content: string): string | null {
	const inner = content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	const text = inner ? stripHtmlTags(inner) : '';
	return text || null;
}

/** `<h1>`–`<h4>` text in document order (capped at 20, matching the markdown path). */
export function extractHtmlHeadings(content: string): string[] {
	return Array.from(content.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi))
		.map((match) => stripHtmlTags(match[2]))
		.filter((heading): heading is string => Boolean(heading))
		.slice(0, 20);
}

/** Raw `href` values from `<a>` tags — the caller normalizes them via the shared resolver. */
export function extractHtmlHrefs(content: string): string[] {
	const hrefs = new Set<string>();
	for (const match of content.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
		hrefs.add(match[1]);
	}
	return Array.from(hrefs);
}

/** A 260-char text excerpt (meta comment and tags removed). */
export function makeHtmlExcerpt(content: string): string {
	return stripHtmlTags(stripHtmlMeta(content)).slice(0, 260);
}

/**
 * Everything that is not a token character: alphanumerics, `_ . / -`, and the letter blocks this wiki uses. Dashes and
 * arrows stay out. Explicit ranges instead of `\p{L}\p{N}`: the property-escape form cost 12 s per cold index build
 * against 1.8 s for the same tokens.
 */
const SEARCH_SEPARATOR =
	/[^0-9a-z_./\u00C0-\u024F\u0370-\u04FF\u0590-\u06FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF-]+/g;
/**
 * The searchable body of a page: its unique lowercase tokens, in document order.
 *
 * Without the body, a term that lives only there (an env var, a table name, a proper
 * noun) never finds the page. Keeping every body verbatim costs ~93 MB of strings across
 * this wiki; deduplicating to unique tokens costs ~33 MB and keeps substring matching
 * intact, because a token is stored whole (`claim_batch` still answers a `batch` query).
 */
export function makeSearchText(content: string, isHtml: boolean): string {
	// Entities are dropped, not decoded: `&middot;` is punctuation either way, and dropping
	// keeps `mdash`, `middot`, `times` and `sect` from becoming tokens on hundreds of pages.
	const text = isHtml ? stripHtmlMeta(content).replace(TAG, ' ').replace(ENTITY_REF, ' ') : content;
	const seen = new Set<string>();
	for (const token of text.toLowerCase().split(SEARCH_SEPARATOR)) {
		if (token) seen.add(token);
	}
	return Array.from(seen).join(' ');
}
