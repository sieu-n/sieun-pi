// The page standard (skills/wiki/references/writing.md) numbers a page's lines in top-level <ol> lists whose start= runs on
// across sections. A writer who adds or drops a line has to shift every later start= by hand, and on 2026-11-04 the wiki
// dream found 115 of 410 curated pages where one did not, such as apps/crawler-v3/workers.html showing 58 twice. The page
// API now sets each top-level start= on every curated write, and moves an in-page "item N" reference with its line.

const SKIP = /<!--[\s\S]*?-->|<(pre|script|style|code|textarea)\b[\s\S]*?<\/\1\s*>/gi;
const TAG = /<(\/?)(ol|ul|li|table)\b([^>]*)>/gi;
const START = /\sstart\s*=\s*(["']?)(-?\d+)\1/i;
const REF = /(?<![-\w])(items?)(\s+)(\d+(?:(?:\s*,\s*|\s+(?:to|and|or)\s+|\s*[-\u2013]\s*)\d+)*)\b/gi;

/** The [from, to) spans of comments and of pre, script, style, code and textarea blocks, which hold no page lines. */
function skipSpans(html) {
	return [...html.matchAll(SKIP)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * Each top-level <ol> of the page in order: one that sits in no list or table, with the span of its open tag, the start=
 * it states (1 when it has none) and its count of direct <li> items.
 */
export function topLists(html) {
	const spans = skipSpans(html);
	const lists = [];
	const stack = [];
	let span = 0;
	for (const m of html.matchAll(TAG)) {
		while (span < spans.length && spans[span][1] <= m.index) span++;
		if (span < spans.length && spans[span][0] <= m.index) continue;
		const [, close, rawTag, attrs] = m;
		const tag = rawTag.toLowerCase();
		if (close) {
			const at = stack.lastIndexOf(tag);
			if (at !== -1) stack.length = at;
			continue;
		}
		if (tag === 'li' && stack.length === 1 && stack[0] === 'ol' && lists.at(-1)?.open) lists.at(-1).count++;
		if (tag === 'ol' && stack.length === 0) {
			for (const list of lists) list.open = false;
			const start = START.exec(attrs);
			lists.push({ at: m.index, tag: m[0], start: start ? Number(start[2]) : 1, count: 0, open: true });
		}
		stack.push(tag);
	}
	return lists.map(({ at, tag, start, count }) => ({ at, tag, start, count }));
}

/** The (expected, actual) start of each top-level list that does not run on from the list before it. */
export function numberBreaks(html) {
	const breaks = [];
	let next = null;
	for (const list of topLists(html)) {
		if (next !== null && list.start !== next) breaks.push([next, list.start]);
		next = list.start + list.count;
	}
	return breaks;
}

function withStart(tag, start) {
	if (START.test(tag)) return tag.replace(START, ` start="${start}"`);
	if (start === 1) return tag;
	return tag.replace(/^<ol\b/i, `<ol start="${start}"`);
}

/**
 * The page with every top-level <ol> after the first numbered on from the one before, and each "item N" or "items N to M"
 * in its text moved to the new number of the line it named. A reference to a number that two lines shared before has no
 * one target, so it lands in `ambiguous` and the page is left as it was. `moved` counts the lists whose start= changed.
 */
export function renumberLists(html) {
	const lists = topLists(html);
	const plan = [];
	const old = new Map();
	let next = null;
	for (const list of lists) {
		const start = next ?? list.start;
		for (let i = 0; i < list.count; i++) {
			const n = list.start + i;
			const seen = old.get(n);
			old.set(n, seen === undefined ? start + i : null);
		}
		if (start !== list.start) plan.push({ ...list, to: start });
		next = start + list.count;
	}
	if (plan.length === 0) return { html, moved: 0, ambiguous: [] };
	let out = '';
	let from = 0;
	for (const list of plan) {
		out += html.slice(from, list.at) + withStart(list.tag, list.to);
		from = list.at + list.tag.length;
	}
	out += html.slice(from);
	const ambiguous = new Set();
	const spans = skipSpans(out);
	const inSkip = (i) => spans.some(([a, b]) => a <= i && i < b);
	const inTag = (i) => out.lastIndexOf('<', i) > out.lastIndexOf('>', i);
	out = out.replace(REF, (whole, word, gap, nums, offset) => {
		if (inSkip(offset) || inTag(offset)) return whole;
		const moved = nums.replace(/\d+/g, (d) => {
			const to = old.get(Number(d));
			if (to === null) ambiguous.add(Number(d));
			return to === undefined || to === null ? d : String(to);
		});
		return word + gap + moved;
	});
	if (ambiguous.size) return { html, moved: 0, ambiguous: [...ambiguous].sort((a, b) => a - b) };
	return { html: out, moved: plan.length, ambiguous: [] };
}
