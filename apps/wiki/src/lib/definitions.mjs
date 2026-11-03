/**
 * How a wiki page's `source_refs` entry `path::name` resolves to one definition in a file. wiki-stale.ts dates the
 * definition by the commits that changed its code (code-text.mjs), and follow-gate.mjs refuses a commit that makes it resolve nowhere.
 */
import { codeText } from './code-text.mjs';

/**
 * A `source_refs` entry `path::name` cites one definition in a file; the name is what wiki-health.mjs citedRefs strips. A name
 * may be a route key such as `convex/http.ts::/api/search-admin/access` or a Markdown heading such as
 * `ops/runbooks/dev-boxes.md::When an alert fires`.
 * @param {string} ref
 * @returns {{ file: string; name: string } | null}
 */
export function symbolRef(ref) {
	const match = /^(.+?)::(\S(?:.*\S)?)$/.exec(ref);
	return match ? { file: match[1], name: match[2] } : null;
}

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
/** @param {string} line */
const indent = (line) => line.length - line.trimStart().length;
/**
 * Whether a line closes every bracket it opens, quoted text aside, as a one-line array or tuple row does.
 * @param {string} line
 */
const closes = (line) => {
	const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '');
	return (code.match(/[([{]/g) ?? []).length === (code.match(/[)\]}]/g) ?? []).length;
};

/**
 * The lines of each definition of `name` in `text`, joined, or null when the file defines no `name`. A definition is a
 * declaration (`def`, `class`, `function`, `const`, `type` and the like), else a key or assignment at the start of a line
 * (`name:`, `"name":`, `NAME =`), else a method head ending in `{`, else a call whose first argument is the string `name`,
 * such as `_bool("pause.crawl", ...)` in apps/crawler-v3/src/control/controls.py, where 24 of the last 40 tip commits
 * edited the one `_build_registry` function that holds every control, or a tuple or array row such as
 * `("engage.session_openings_per_10min", 90),` in `_PROD_CONTROL_DEFAULTS` of apps/crawler-v3/src/settings.py or
 * `['crawl.bluesky.profile', 'crawl', ...],` in `OPERATION_ROWS` of apps/api-portal/src/lib/server/operations.ts. A row on
 * one line is that line, and a string on its own line names a row only as the first item under its opener, because on
 * 2026-10-29 the `'POST'` column of two multi-line `OPERATION_ROWS` rows keyed them for every page that wrote
 * `POST /api/crawl/fetch`, while no single-line row resolved at all. Else a shell
 * function head `name() {`, as in `up_convex_native() { # <port> ...` in scripts/ci/services.sh, which the method head missed for its trailing comment, else a
 * YAML list item whose first key holds `name`, such as `- uid: vent-front-door-failing-prod` in
 * apps/infra/metal/config/obs/grafana/alerting/vent.yaml, where Grafana alert rules and many YAML lists name items. It runs
 * from that line through every deeper indented or blank line and every closing `)`, `]` or `}` line at its own depth, which
 * covers a Python block, a TypeScript function or object, a YAML job, a JSON value, a call and a shell function. A top-level
 * declaration wins over a local one of the same name, because on 2026-10-28 2a8c77c496 added `const refresh = ...` inside
 * storeCounts in convex/search/campaigns/screening/refresh.ts, and that edit flagged every page citing the exported
 * `refresh` action, which it never touched. Failing all of
 * those, a Markdown heading `## name` runs to the next heading of its level or higher, because on the 7 days to 2026-10-28
 * 10:28Z commits to other sections of ops/runbooks/dev-boxes.md and apps/infra/metal/README.md flagged
 * domains/devops/local-store-box/index.html and domains/devops/aws-estate.html 11 times and none of them changed the page.
 * @param {string} text
 * @param {string} name
 * @returns {string | null}
 */
export function definitionText(text, name) {
	const id = escape(name);
	const patterns = [
		new RegExp(
			`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:def|class|function\\*?|const|let|var|type|interface|enum)\\s+${id}(?![\\w$-])`,
		),
		new RegExp(`^\\s*(?:readonly\\s+)?(?:["']${id}["']|${id})\\s*(?:\\??:|=)(?!=)`),
		new RegExp(`^\\s*(?:(?:public|private|protected|static|async|get|set)\\s+)*${id}\\s*(?:<[^>]*>)?\\(.*\\{\\s*$`),
		new RegExp(`^\\s*(?:[\\w$.]*\\(\\s*|\\[\\s*)?["']${id}["']\\s*[,)\\]]`),
		new RegExp(`^\\s*${id}\\s*\\(\\s*\\)\\s*\\{`),
		new RegExp(`^\\s*-\\s+[\\w-]+:\\s*["']?${id}["']?\\s*$`),
	];
	const lines = text.split('\n');
	for (const pattern of patterns) {
		/** @type {{ top: boolean; text: string }[]} */
		const blocks = [];
		for (let start = 0; start < lines.length; start += 1) {
			if (!lines[start].includes(name) || !pattern.test(lines[start])) continue;
			let head = start;
			if (pattern === patterns[3] && /^\s*["']/.test(lines[start])) {
				while (head > 0 && (!lines[head].trim() || indent(lines[head]) >= indent(lines[start]))) head -= 1;
				if (lines.slice(head + 1, start).some((line) => line.trim() && !/^\s*(?:#|\/\/)/.test(line))) continue;
			}
			const depth = indent(lines[head]);
			const row = pattern === patterns[3] && head === start && /^\s*[[(]/.test(lines[start]) && closes(lines[start]);
			let end = start + 1;
			while (!row && end < lines.length) {
				const line = lines[end];
				if (line.trim() && (indent(line) < depth || (indent(line) === depth && !/^\s*[)\]}]/.test(line)))) break;
				end += 1;
			}
			blocks.push({ top: indent(lines[head]) === 0, text: lines.slice(head, end).join('\n').trimEnd() });
		}
		const top = pattern === patterns[0] ? blocks.filter((block) => block.top) : [];
		if (blocks.length) return (top.length ? top : blocks).map((block) => block.text).join('\n');
	}
	const heading = new RegExp(`^(#{1,6})\\s+${id}\\s*#*\\s*$`);
	/** @type {string[]} */
	const sections = [];
	for (let start = 0; start < lines.length; start += 1) {
		const level = heading.exec(lines[start])?.[1].length;
		if (!level) continue;
		let end = start + 1;
		while (end < lines.length && (/^(#{1,6})\s/.exec(lines[end])?.[1].length ?? 7) > level) end += 1;
		sections.push(lines.slice(start, end).join('\n').trimEnd());
	}
	return sections.length ? sections.join('\n') : null;
}

/**
 * The code (`codeText`) of the definition `name` in `text`, a version of `file`, or null when there is no text or no such definition.
 * @param {string | null} text
 * @param {string} name
 * @param {string} file
 * @returns {string | null}
 */
export function definitionCode(text, name, file) {
	const definition = text === null || !text.includes(name) ? null : definitionText(text, name);
	return definition === null ? null : codeText(definition, file);
}

/**
 * The rows of an array or tuple table `text` that hold the quoted string `value` as an item or a field value, joined, or
 * null when none does. A row opens with `[`, `(` or `{` at the start of a line and runs to its closing line at the same
 * depth. entryKeys (stale-rules.mjs) keys a row by a route it holds, because the youtube, xiaohongshu and contact-benchmark
 * pages name `OPERATION_ROWS` rows in apps/api-portal/src/lib/server/operations.ts by path, such as `/v1/youtube/videos`,
 * never by id, and by a distinctive word, because apps/search/onboarding-orgs.html names `CASCADE_TABLES` rows in
 * convex/search/orgCascade.ts by table, such as `{ table: 'searchContactFindRequests' },`.
 * @param {string} text
 * @param {string} value
 * @returns {string | null}
 */
export function rowsHolding(text, value) {
	const item = new RegExp(`(?:^|[[({,:])\\s*["']${escape(value)}["']\\s*(?=[,)\\]}]|$)`, 'm');
	const lines = text.split('\n');
	/** @type {string[]} */
	const rows = [];
	for (let start = 0; start < lines.length; start += 1) {
		if (!/^\s*[[({]/.test(lines[start])) continue;
		let end = start + 1;
		if (!closes(lines[start]))
			while (end < lines.length && !(indent(lines[end]) === indent(lines[start]) && /^\s*[)\]}]/.test(lines[end]))) end += 1;
		const row = lines.slice(start, Math.min(end + (closes(lines[start]) ? 0 : 1), lines.length)).join('\n');
		if (item.test(row)) rows.push(row.trimEnd());
		start = Math.max(start, end - 1);
	}
	return rows.length ? rows.join('\n') : null;
}
