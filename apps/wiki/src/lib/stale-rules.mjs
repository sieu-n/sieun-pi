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
 * The commit trailer by which a code commit vouches for a curated page: `Wiki-Checked: <page>` says its writer read the page
 * against this commit and every older commit the follow gate named, and the page states what the code does after it. The stale
 * report and the follow gate read such a commit as the page's check of each cited file it changes, the way they read a commit
 * that changed the page with its code while the pages sat in git. Since 2026-11-03 the pages live outside git, so no code commit
 * can carry one, and a page that a commit put behind waited for a later write: in the 7 days to 2026-11-14 23:13Z, 1,231 page
 * flags ended with a page write, 1,036 of them by the wiki dream, 27 by the session that made the commit, and 93% of the 1,420
 * counted page-hours waited on the dream (`~/work/wiki-pages-follow-commit-1115/`).
 */
export const CHECKED_TRAILER = 'Wiki-Checked';

/**
 * The `git log --format` field that holds a commit's whole message between %x02 and %x03, for checkedPages. Git's
 * `%(trailers)` reads only the last paragraph, so a CHECKED_TRAILER line in an earlier paragraph or above a Session-Id block
 * was lost: of the 12 auto-sns-agent first-parent commits since 2026-11-07 with such lines, git read 1 of 2 in 402a6b2851, 0 of
 * 5 in 81457681d0 and 0 of 1 in 4a4278b3d7, and apps/crawler-v3/identity-model.html read as behind 402a6b2851 on 2026-11-21.
 */
export const CHECKED_FORMAT = '%x02%B%x03';

/**
 * The content paths of the pages that the CHECKED_TRAILER lines of `message` name, one or more messages in CHECKED_FORMAT or as
 * written. A line counts wherever it stands in the message, and its key matches in any case, as git reads a trailer key. Its
 * value is the page's wiki path, with or without a leading `/wiki/`, `wiki:` or the old `apps/llm-wiki/content/`, and may go
 * on with a note after a space.
 * @param {string} message
 * @returns {string[]}
 */
export const checkedPages = (message) =>
	message
		.split(/[\n\x02\x03]/)
		.filter((line) => line.toLowerCase().startsWith(`${CHECKED_TRAILER.toLowerCase()}:`))
		.map((line) => line.slice(CHECKED_TRAILER.length + 1).trim().split(/\s+/)[0] ?? '')
		.map((page) => page.replace(/^(?:wiki:|\/?wiki\/|\/)/, '').replace(/^apps\/llm-wiki\/content\//, ''))
		.filter((page) => page.endsWith('.html'));

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
 * A route the table holds behind its HTTP method, such as `"POST /api/watch-targets/monitor-range"` in `_CRAWLER_CONVEX` of
 * apps/vent/src/vent/tables.py, keys those rows, and by method and route when the page writes both (`methodRows`), because
 * auto-sns-agent 256d507bac dropped only `"GET /api/enrich/columns/runs/*"` there and flagged
 * apps/search/brand-tracking-watches.html, which names only the monitor-range row. On a replay of the 1,989 dream rechecks
 * in the 7 days to 2026-11-21 18:08Z this drops 3 flags of that page, all `last_verified` only, and none of the body changes,
 * and adds 3 flags on `INTEGRATIONS` for 76000addb1 and 86038f4e2e, whose facts those rechecks wrote
 * (~/work/wiki-stale-method-routes/).
 * @param {string} source
 * @param {string} definition
 * @returns {string[]}
 */
export function entryKeys(source, definition) {
	const head = definition.split('\n')[0] ?? '';
	if (KWARG_CALL.test(head)) return kwargKeys(source, definition);
	if (!/=\s*[({[]\s*$/.test(head)) return [];
	/** @type {Set<string>} */
	const keys = new Set();
	for (const text of codeSpans(source)) {
		const spanWords = text.split(/[\s=]+/).map((word) => word.replace(/^[`'"(]+|[`'",.;:)]+$/g, ''));
		spanWords.forEach((key, at) => {
			const route = /^\/[^\s/]/.test(key);
			const withMethod = `${spanWords[at - 1]} ${key}`;
			const quoted = definition.includes(`'${key}'`) || definition.includes(`"${key}"`);
			if (route && METHOD_ROUTE.test(withMethod) && methodRows(definition, withMethod) !== null) keys.add(withMethod);
			else if (!route && !/^\w+(?:\.\w+)+$/.test(key) && !distinctive(key)) return;
			else if ((quoted || (route && methodRows(definition, key) !== null)) && entry(definition, key) !== null) keys.add(key);
		});
	}
	return [...keys];
}

/** A route behind its HTTP method, as the row `"POST /api/watch-targets/monitor-range",` of `_CRAWLER_CONVEX` in apps/vent/src/vent/tables.py holds it. */
const METHOD_ROUTE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^\s/]/;

/** The lines of a table that hold a method route such as `POST /api/x` quoted whole, or for a bare route `/api/x` the lines that hold it quoted behind any method, or null when none does.
 * @param {string} definition
 * @param {string} key
 * @returns {string | null}
 */
function methodRows(definition, key) {
	const id = key.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');
	const quoted = new RegExp(`["'](?:${METHOD_ROUTE.test(key) ? '' : '(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) '})${id}["']`);
	const lines = definition.split('\n').filter((line) => quoted.test(line));
	return lines.length ? lines.join('\n') : null;
}

/** The head of a call that a definition assigns, as `_PROD_PROFILE = RuntimeProfile(` or `LIMITS = dict(`. */
const KWARG_CALL = /=\s*[A-Za-z_][\w.]*\(\s*$/;

/**
 * The keyword argument of a call definition (`KWARG_CALL`) that the page names in `<code>`, a `name=` line at the call's
 * first depth, which `definitionText` finds as a key, or none when the page names none or two or more. On 2026-11-20
 * auto-sns-agent 1202c1dff0 dropped `box_proxy_ports=` from `apps/crawler-v3/src/settings.py::_PROD_PROFILE` and flagged
 * all 8 pages citing it, and 5 of their rechecks changed only `last_verified`, because they name `parent_evidence` or
 * another argument the commit left alone. On a replay of the 7 days to 2026-11-20 08:15Z this drops 11 of the 1,233
 * flagged dream rechecks and none of the 749 that changed a page body. Keying a page that names two or more arguments too
 * would have dropped 15, with 2 body changes, because apps/crawler-v3/workers.html names `role_processes` and
 * `mode_processes` and its writer added the `parent_evidence` and `watch-scheduler` pool facts of 3b70dc9955 and
 * c9a1a1159c (~/work/wiki-stale-yaml-key-depth/).
 * @param {string} source
 * @param {string} definition
 * @returns {string[]}
 */
function kwargKeys(source, definition) {
	const lines = definition.split('\n');
	const first = lines.slice(1).find((line) => line.trim() && !/^\s*#/.test(line));
	if (first === undefined) return [];
	const args = new Set(
		lines.flatMap((line) => (depthOf(line) === depthOf(first) ? (/^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(line)?.[1] ?? []) : [])),
	);
	const named = [...codeNames(source)].filter((name) => args.has(name));
	return named.length === 1 ? named : [];
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
 * A method route such as `POST /api/x`, and a bare route that no row holds, key the lines that hold it quoted (`methodRows`).
 * An ALLCAPS word keys no row, because `'POST'` is a column of `OPERATION_ROWS` that every POST row holds.
 * @param {string} definition
 * @param {string} key
 * @returns {string | null}
 */
const entry = (definition, key) =>
	METHOD_ROUTE.test(key)
		? methodRows(definition, key)
		: (definitionText(definition, key) ??
			(/^\/[^\s/]/.test(key)
				? (rowsHolding(definition, key) ?? methodRows(definition, key))
				: distinctive(key) && key !== key.toUpperCase()
					? rowsHolding(definition, key)
					: null));

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
	const cited = codeNames(source);
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

/** The head of a YAML env map: `env:` of a GitHub Actions workflow, job or step, or `environment:` of a compose service. */
const ENV_HEAD = /^(\s*)(?:env|environment):\s*$/;
/** The key of an env map entry, `KEY: value` or the compose list forms `- KEY=value` and `- KEY`. */
const ENV_KEY = /^\s*(?:-\s*)?["']?([A-Za-z_][\w.-]*)["']?\s*(?:[:=]|$)/;

/** Every identifier of the page's `<code>` spans.
 * @param {string} source
 */
const codeNames = (source) => {
	/** @type {Set<string>} */
	const names = new Set();
	for (const text of codeSpans(source)) for (const name of text.match(/[A-Za-z_$#][\w$]*/g) ?? []) names.add(name);
	return names;
};

/**
 * The entries of each env map of `definition`, as `{ key, start, end }` line ranges: an entry is a line at the map's first
 * depth and every deeper or blank line under it, such as a block scalar value.
 * @param {readonly string[]} lines
 * @returns {{ key: string; start: number; end: number }[]}
 */
function envEntries(lines) {
	/** @type {{ key: string; start: number; end: number }[]} */
	const entries = [];
	for (let at = 0; at < lines.length; at += 1) {
		const head = ENV_HEAD.exec(lines[at]);
		if (!head) continue;
		let line = at + 1;
		while (line < lines.length && (!lines[line].trim() || depthOf(lines[line]) > head[1].length)) {
			if (!lines[line].trim()) {
				line += 1;
				continue;
			}
			const start = line;
			for (line += 1; line < lines.length && (!lines[line].trim() || depthOf(lines[line]) > depthOf(lines[start])); ) line += 1;
			entries.push({ key: ENV_KEY.exec(lines[start])?.[1] ?? '', start, end: line });
		}
		at = line - 1;
	}
	return entries;
}

/**
 * The env keys a page follows in a YAML `path::name` definition: every identifier of its `<code>` spans, or null to follow
 * the whole definition when it holds no env map or the page names two or more of its env keys at the check, since such a
 * page lists the map. On 2026-11-17 auto-sns-agent 3be3b8bb5a added only `ISOLATE_MAX_USER_HEAP_SIZE` to the
 * `environment` of `convex-backend` in apps/infra/metal/compose.convex-prod.yml and compose.staging.yml, and fedf54d3a3
 * added only `CONVEX_SELF_HOSTED_ADMIN_KEY_STAGING` to the `CI_ENV` value of the golden step's `env` in
 * .github/workflows/promote.yml, and the two flagged 21 pages in the dream run at 20:07Z, of which this rule clears 18:
 * 17 rechecks that changed only `last_verified` and one that only named a staging land. On a replay of the 1,123 dream rechecks in the 7 days to 2026-11-17 20:17Z, 989 behind a flag, the rule drops
 * 42 of the 461 `last_verified`-only rechecks and 3 of the 528 that changed the body, none of those 3 for a fact the env
 * change made: two named a staging land and one added a function from a commit no ref of the page covered
 * (~/work/wiki-stale-env-keys/). Without the two-key floor it also dropped domains/devops/convex-release-path.html, which
 * lists the `convex-backend` knobs and added `ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS` when 99609c20ab set it.
 * @param {string} source
 * @param {string} definition
 * @returns {string[] | null}
 */
export function envKeys(source, definition) {
	const entries = envEntries(definition.split('\n'));
	if (!entries.length) return null;
	const cited = codeNames(source);
	if (entries.filter(({ key }) => cited.has(key)).length >= 2) return null;
	return [...cited];
}

/** `definition` without the env map entries whose key `keys` lacks, or null for a null definition.
 * @param {string | null} definition
 * @param {readonly string[]} keys
 * @returns {string | null}
 */
export function namedEnv(definition, keys) {
	if (definition === null) return null;
	const lines = definition.split('\n');
	const known = new Set(keys);
	const dropped = new Set();
	for (const { key, start, end } of envEntries(lines))
		if (!known.has(key)) for (let at = start; at < end; at += 1) dropped.add(at);
	return lines.filter((_, at) => !dropped.has(at)).join('\n');
}

/**
 * What a page's `path::name` ref follows of a version of the definition, given its text at the page's check: for a table
 * only the entries the page names and for a keyword call the one argument it names (`entryKeys`), for a class all but a field added with a default the page does not name
 * (`memberKeys`), for a YAML block with an env map all but the entries whose key the page does not name (`envKeys`), else
 * the whole text.
 * @param {string} source
 * @param {string | null} atCheck
 * @returns {(definition: string | null) => string | null}
 */
export function followed(source, atCheck) {
	const keys = atCheck === null ? [] : entryKeys(source, atCheck);
	if (keys.length) return (definition) => namedEntries(definition, keys);
	const members = atCheck === null ? [] : memberKeys(source, atCheck);
	if (members.length) return (definition) => knownMembers(definition, members);
	const env = atCheck === null ? null : envKeys(source, atCheck);
	return env ? (definition) => namedEnv(definition, env) : (definition) => definition;
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
