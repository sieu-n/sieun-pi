/**
 * The rules that decide whether a code change touches what a wiki page states. The stale report (server/wiki-stale.ts)
 * applies them to each commit after a page's check, and the follow gate (scripts/follow-gate.mjs) applies them to the
 * one commit commit.mjs is about to write, so both read a change the same way.
 */
import { definitionText, rowsHolding } from './definitions.mjs';

/** The UTC start in ms of the day a `last_verified` value names.
 * @param {string} lastVerified
 */
export const dayStart = (lastVerified) => Date.parse(`${lastVerified.slice(0, 10)}T00:00:00Z`);

/**
 * When the page was checked against the code. A `last_verified` time is the check itself, and a time written to the minute covers
 * that whole minute, since its writer read the code before writing the minute down. Read as the minute's start, a page fixed in a
 * docs commit right after its code read as behind that code: on 2026-10-30 db8e5529c5 (02:24:16Z) changed a ref of
 * apps/convex/schema.html and 5c9e190769 (02:24:44Z) wrote the page with `last_verified` 02:24Z, and 31 page checks the wiki dream
 * runs of 10-10 to 10-30 flagged had every changed ref in the minute of their `last_verified`. A bare day is dated by the page's
 * newest first-parent commit on that day (UTC), else the end of that day. Reading every day as its end hid same-day changes:
 * on 2026-10-20 at 02:20Z 32 pages cited a file changed after their commit while the report read 0.
 * @param {string} lastVerified
 * @param {readonly number[]} [pageCommits] the page's commit times in ms, newest first
 * @returns {number}
 */
export function verifiedAt(lastVerified, pageCommits = []) {
	if (lastVerified.includes('T')) {
		const at = Date.parse(lastVerified);
		return /T\d\d:\d\dZ$/.test(lastVerified) ? at + 59_999 : at;
	}
	const start = dayStart(lastVerified);
	const end = start + 86_400_000 - 1000;
	return pageCommits.find((at) => at >= start && at <= end) ?? end;
}

/**
 * @param {string} ref
 * @param {string} file
 */
export const under = (ref, file) => file === ref || file.startsWith(`${ref.replace(/\/+$/, '')}/`);

const CODE_SPAN = /<code[^>]*>([\s\S]*?)<\/code>/g;
/** @type {Record<string, string>} */
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
/** @param {string} source */
const pageBody = (source) => source.replace(/<!--wiki[\s\S]*?-->/, '');
/** The text of each `<code>` span of the page body, with its tags stripped and its entities decoded.
 * @param {string} source
 */
const codeSpans = (source) =>
	[...pageBody(source).matchAll(CODE_SPAN)].map(([, span = '']) =>
		span.replace(/<[^>]+>/g, '').replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => ENTITIES[entity]),
	);
/**
 * @param {string} text
 * @returns {string[]}
 */
export const words = (text) =>
	(text.match(/[A-Za-z_][\w-]*|\d[\d_.,]*/g) ?? [])
		.flatMap((word) => word.split(/[./]/))
		.filter((part) => part.length >= 3);
/** A word rare enough that a diff line holding it is about the same thing: it has `_`, `-` or a digit, is camelCase, or is ALLCAPS of 4 or more.
 * @param {string} word
 */
const distinctive = (word) =>
	/[_\d-]/.test(word) ||
	/[a-z][A-Z]/.test(word) ||
	(word.length >= 4 && /[A-Z]/.test(word) && word === word.toUpperCase());

/** A turbo task id such as `search#build` or `//#ci:guards`, which `definitionText` finds whole as its `turbo.json` key. */
const TASK_ID = /(?:\/\/|[\w@./-]+)#[\w:.-]+/g;
/** A path such as `scripts/ci/tasks/guard-tests.sh`, whose segments name folders and files, never a definition. */
const PATH = /[^\s'"`()<>]*\/[^\s'"`()<>]*/g;

/** A whole path of a `<code>` span, without its edge slashes or trailing punctuation, as a changed line would hold it.
 * @param {string} found
 */
const wholePath = (found) => found.replace(/[.,;:]+$/, '').replace(/^\/+|\/+$/g, '');

/** @typedef {{ tokens: Set<string>; names: Set<string>; paths: Set<string> }} Cited */

/**
 * What a page cites in its `<code>` spans: `tokens`, the distinctive words outside paths a diff line must hold to touch the
 * page; `paths`, each path with a distinctive word, which a changed line must hold whole; and `names`, every identifier a
 * definition in a cited file may carry (`definitionText`), with each turbo task id whole and no word of a path. Until
 * 2026-10-28 a path counted word by word, so the `search-admin` of `/api/search-admin/access` touched every convex/http.ts
 * line of another search-admin route, and on a replay of the 7 days to 2026-10-28 10:28Z the whole-path rule dropped 11 of
 * the 513 flags that ended in a `last_verified`-only recheck and none of the 441 that ended in a page fix.
 * @param {string} source
 * @returns {Cited}
 */
export function citedWords(source) {
	/** @type {Set<string>} */
	const tokens = new Set();
	/** @type {Set<string>} */
	const names = new Set();
	/** @type {Set<string>} */
	const paths = new Set();
	for (const text of codeSpans(source)) {
		const bare = text.replace(PATH, ' ');
		for (const word of words(bare)) if (distinctive(word)) tokens.add(word);
		for (const found of text.match(PATH) ?? []) {
			const whole = wholePath(found);
			if (words(whole).some(distinctive)) paths.add(whole);
		}
		for (const id of text.match(TASK_ID) ?? []) names.add(id);
		for (const name of bare.match(/[A-Za-z_$][\w$]*/g) ?? []) if (name.length >= 3) names.add(name);
	}
	return { tokens, names, paths };
}

/** The lines one text has more often than the other: the added and removed lines of a commit, read from its two versions.
 * @param {string | null} before
 * @param {string | null} after
 * @returns {string[]}
 */
export function changedLines(before, after) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const line of (before ?? '').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
	for (const line of (after ?? '').split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1);
	return [...counts].filter(([, count]) => count !== 0).map(([line]) => line);
}

/** Whether changed code lines touch what a page cites: a distinctive word, a whole path, or anything when the page cites neither.
 * @param {readonly string[]} lines
 * @param {Cited} cited
 * @returns {boolean}
 */
export function linesTouch(lines, { tokens, paths }) {
	if (!tokens.size && !paths.size) return true;
	const changed = new Set(lines.flatMap(words));
	return (
		[...tokens].some((token) => changed.has(token)) ||
		[...paths].some((whole) => lines.some((line) => line.includes(whole)))
	);
}

/**
 * The keys of a table that a page names whole in its `<code>` spans, such as `/api/search-admin/access`,
 * `meta_ads.advertiser_walks_per_minute` or `crawl.bluesky.profile`. A table is a definition whose head opens a literal
 * (`= {`, `= (`, `= [`), and a key is a route, a dotted id or a distinctive word the table holds quoted, with an entry
 * `definitionText` finds, or for a route or a distinctive word the array rows that hold it as an item (`rowsHolding`). The dotted id counts because every `OPERATION_ROWS` key in
 * apps/api-portal/src/lib/server/operations.ts is one, such as `instagram.followers`, and none is distinctive. A `path::name` ref to such a
 * table follows only the entries the page names (`namedEntries`). On a replay of the 7 days to 2026-10-28 10:28Z the route
 * table `ROUTE_ACCESS` in apps/search/src/lib/server/auth/route-access.ts flagged 21 rechecks that changed only `last_verified`
 * and none that fixed a page, and the rule dropped 16 of the 513 such flags and none of the 441 page fixes. On 2026-10-29
 * 29355fa1b8 changed one row of `_PROD_CONTROL_DEFAULTS` in apps/crawler-v3/src/settings.py, which flagged all 5 pages citing
 * the table, and 4 of their rechecks changed only `last_verified`. A distinctive word keys the object rows that hold it,
 * such as `{ table: 'searchCampaignPoolCarry', largeRows: true },` in `CASCADE_TABLES` of convex/search/orgCascade.ts,
 * because apps/search/onboarding-orgs.html was retouched by 39 wiki-dream commits in the 7 days to 2026-10-30, and the
 * recheck after 506e664d4f dropped two rows the page never names changed only `last_verified`.
 * @param {string} source
 * @param {string} definition
 * @returns {string[]}
 */
export function entryKeys(source, definition) {
	if (!/=\s*[({[]\s*$/.test(definition.split('\n')[0] ?? '')) return [];
	/** @type {Set<string>} */
	const keys = new Set();
	for (const text of codeSpans(source))
		for (const word of text.split(/[\s=]+/)) {
			const key = word.replace(/^[`'"(]+|[`'",.;:)]+$/g, '');
			if (!/^\/[^\s/]/.test(key) && !/^\w+(?:\.\w+)+$/.test(key) && !distinctive(key)) continue;
			if (!definition.includes(`'${key}'`) && !definition.includes(`"${key}"`)) continue;
			if (entry(definition, key) !== null) keys.add(key);
		}
	return [...keys];
}

/** The text of the entries of `definition` keyed by one of `keys`, in key order, or null for a null definition.
 * @param {string | null} definition
 * @param {readonly string[]} keys
 * @returns {string | null}
 */
export function namedEntries(definition, keys) {
	if (definition === null) return null;
	return keys.map((key) => entry(definition, key) ?? '').join('\n');
}

/** The entry of a table keyed by `key`, or for a route or a distinctive word the array rows that hold it (`rowsHolding`).
 * An ALLCAPS word keys no row, because `'POST'` is a column of `OPERATION_ROWS` that every POST row holds.
 * @param {string} definition
 * @param {string} key
 * @returns {string | null}
 */
const entry = (definition, key) =>
	definitionText(definition, key) ??
	(/^\/[^\s/]/.test(key) || (distinctive(key) && key !== key.toUpperCase()) ? rowsHolding(definition, key) : null);

const CLASS_HEAD =
	/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface)\s+[\w$]+|^\s*(?:export\s+)?(?:declare\s+)?type\s+[\w$]+(?:<[^=]*>)?\s*=\s*\{\s*$/;
const MEMBER =
	/^\s*(?:(?:public|private|protected|static|readonly|abstract|declare|override|async|get|set|def)\s+)*\*?["']?([A-Za-z_$#][\w$-]*)["']?\s*[?!]?\s*(?:[:(=<]|$)/;
/** A field with a default value, such as `connect_floor: float | None = None` or `retries: number = 3;`. */
const DEFAULTED = /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*:\s*[^=]+=(?![=>])/;
/** @param {string} line */
const depthOf = (line) => line.length - line.trimStart().length;

/**
 * The members of a class, interface or object type, as `{ name, start, end }` line ranges of `definition`, with the decorators
 * above a member in its range; null for any other definition. A member is a line at the body's first depth that opens with a
 * name, such as a field, a method or a property, and runs through its deeper lines and its closing bracket lines.
 * @param {string} definition
 * @returns {{ name: string; start: number; end: number }[] | null}
 */
function classMembers(definition) {
	const lines = definition.split('\n');
	if (!CLASS_HEAD.test(lines[0] ?? '')) return null;
	let body = 1;
	while (body < lines.length && !/[:{]\s*$/.test(lines[body - 1] ?? '')) body += 1;
	const first = lines.slice(body).find((line) => line.trim() && depthOf(line) > depthOf(lines[0]));
	if (first === undefined) return [];
	const depth = depthOf(first);
	/** @type {{ name: string; start: number; end: number }[]} */
	const members = [];
	let decorators = -1;
	for (let at = body; at < lines.length; at += 1) {
		const line = lines[at];
		if (!line.trim() || depthOf(line) !== depth || /^\s*[)\]}]/.test(line)) continue;
		if (/^\s*@/.test(line)) {
			if (decorators < 0) decorators = at;
			continue;
		}
		const name = MEMBER.exec(line)?.[1];
		const start = decorators < 0 ? at : decorators;
		decorators = -1;
		if (!name) continue;
		let end = at + 1;
		for (; end < lines.length; end += 1) {
			const next = lines[end];
			if (next.trim() && depthOf(next) <= depth && !(depthOf(next) === depth && /^\s*[)\]}]/.test(next))) break;
		}
		members.push({ name, start, end });
	}
	return members;
}

/**
 * The names a class `definition` may gain without a change to the page: every name of the page's `<code>` spans and every
 * member the definition has at the check, or none when the definition is no class or the page names fewer than two of its
 * members. A `path::name` ref to a class follows the class without a field added with a default that the page does not name
 * (`knownMembers`). On 2026-10-31 dc9b5aca13 added `connect_floor: float | None = None` to `Fingerprint` in
 * packages/sirocco/src/sirocco/surfaces.py, which flagged all 5 pages citing it, and all 5 rechecks changed only `last_verified`.
 * On a replay of the 7 days to 2026-10-31 11:43Z, 119 dream rechecks had a flagged class ref, 59 with a page body change and 60
 * with `last_verified` only; the rule drops 12 of the 60 and none of the 59. Without the two-member floor it dropped 19 and
 * lost apps/crawler-v3/configuration/index.html, which names one `RuntimeProfile` field and describes the rest in prose, and skipping
 * any added member lost 6, such as `FleetPool.render_fresh`, which the pages listing its methods added.
 * @param {string} source
 * @param {string} definition
 * @returns {string[]}
 */
export function memberKeys(source, definition) {
	const members = classMembers(definition);
	if (!members) return [];
	/** @type {Set<string>} */
	const cited = new Set();
	for (const text of codeSpans(source)) for (const name of text.match(/[A-Za-z_$#][\w$]*/g) ?? []) cited.add(name);
	const known = members.map(({ name }) => name);
	if (known.filter((name) => cited.has(name)).length < 2) return [];
	return [...new Set([...known, ...cited])];
}

/** `definition` without the fields added with a default whose names `keys` lacks, or null for a null definition.
 * @param {string | null} definition
 * @param {readonly string[]} keys
 * @returns {string | null}
 */
export function knownMembers(definition, keys) {
	if (definition === null) return null;
	const lines = definition.split('\n');
	const known = new Set(keys);
	const dropped = new Set();
	for (const { name, start, end } of classMembers(definition) ?? []) {
		const head = lines.slice(start, end).find((line) => !/^\s*@/.test(line)) ?? '';
		if (!known.has(name) && DEFAULTED.test(head)) for (let at = start; at < end; at += 1) dropped.add(at);
	}
	return lines.filter((_, at) => !dropped.has(at)).join('\n');
}

/**
 * What a page's `path::name` ref follows of a version of the definition, given its text at the page's check: for a table
 * only the entries the page names (`entryKeys`), for a class all but a field added with a default the page does not name
 * (`memberKeys`), else the whole text.
 * @param {string} source
 * @param {string | null} atCheck
 * @returns {(definition: string | null) => string | null}
 */
export function followed(source, atCheck) {
	const keys = atCheck === null ? [] : entryKeys(source, atCheck);
	if (keys.length) return (definition) => namedEntries(definition, keys);
	const members = atCheck === null ? [] : memberKeys(source, atCheck);
	return members.length ? (definition) => knownMembers(definition, members) : (definition) => definition;
}

/** Whether the page states line numbers or a line count of `ref`, such as `fast.py:380` or `convex/crons.ts at lines 120, 126`, which any edit can move.
 * @param {string} source
 * @param {string} ref
 * @returns {boolean}
 */
export function citesLines(source, ref) {
	const base = (ref.replace(/\/+$/, '').split('/').pop() ?? '')
		.replace(/[$.*+?^()[\]{}|\\-]/g, '\\$&');
	const text = pageBody(source).replace(/<[^>]+>/g, ' ');
	return new RegExp(`${base}:\\d+|${base}[^.\\n]{0,80}\\blines? \\d|${base}[^.\\n]{0,40}\\bat [\\d,]+ lines`).test(
		text,
	);
}
