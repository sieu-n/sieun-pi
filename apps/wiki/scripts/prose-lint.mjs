#!/usr/bin/env node
// Prose lint CLI for llm-wiki pages. The rules live in src/lib/prose-lint.mjs.
//
//   node apps/wiki/scripts/prose-lint.mjs <file|dir|wiki path>...  lint pages, exit 1 on any error; a target that is
//        not an existing path is read from the content root (wikiConfig().contentRoot), so apps/search/campaigns.html works
//   node apps/wiki/scripts/prose-lint.mjs --recent 20              the 20 newest session pages of the newest month folder
//   node apps/llm-wiki/scripts/prose-lint.mjs --json ...           JSON instead of text
//   node apps/llm-wiki/scripts/prose-lint.mjs --ratchet <before|-> <file>
//        exit 1 only if <file> has more errors of some rule than <before>; "-" reads before from stdin,
//        a missing before file counts as a new page with 0 errors
//   node apps/llm-wiki/scripts/prose-lint.mjs --ratchet-git <rev> <file>...
//        ratchet every file against its blob at <rev> in one process (commit.mjs uses this), and refuse a curated
//        page that newly looks like another page with no `distinct_from` line (dup-gate.mjs), and a page that adds a
//        title/h1 mismatch or a current hub link to a retired page (page-gate.mjs)
//
// Exit codes: 0 clean or no growth, 1 errors (or errors grew), 2 usage or read failure.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_FILE, isLintedPath, lintHtml, ratchet } from '../src/lib/prose-lint.mjs';
import { gateRefusal } from './dup-gate.mjs';
import { pageGateRefusal, pageGateWarnings, warningText } from './page-gate.mjs';
import { wikiConfig } from '../src/lib/wiki-config.mjs';

const CONTENT = wikiConfig().contentRoot;
/** The newest folder by name under dir, such as sessions/2026 under sessions, or null. */
const newest = (dir) =>
	existsSync(dir) ? (readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().map((n) => path.join(dir, n)).pop() ?? null) : null;
const RECENT_ROOT = newest(newest(path.join(CONTENT, 'sessions')) ?? '') ?? '';
const SKIP_DIRS = new Set(['data', 'assets', 'node_modules', '.git']);

function usage(msg) {
	process.stderr.write(`prose-lint: ${msg}\nsee the header of apps/wiki/scripts/prose-lint.mjs for usage\n`);
	process.exit(2);
}

const argv = process.argv.slice(2);
let json = false;
let recent = 0;
let ratchetBefore = null;
let ratchetRev = null;
const targets = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--json') json = true;
	else if (a === '--recent') recent = Number(argv[++i]);
	else if (a === '--ratchet') ratchetBefore = argv[++i];
	else if (a === '--ratchet-git') ratchetRev = argv[++i];
	else if (a === '-h' || a === '--help') usage('help');
	else if (a.startsWith('--')) usage(`unknown option ${a}`);
	else targets.push(a);
}
if (argv.includes('--recent') && !(recent > 0)) usage('--recent needs a positive number');
if (argv.includes('--ratchet') && !ratchetBefore) usage('--ratchet needs <before-file|->');
if (argv.includes('--ratchet-git') && !ratchetRev) usage('--ratchet-git needs <rev>');

/** Content-relative path when the file sits under the content root, else the path as given. */
function relOf(file) {
	const abs = path.resolve(file);
	return abs.startsWith(CONTENT + path.sep) ? path.relative(CONTENT, abs) : file;
}

/** A wiki page opens with `<!--wiki {json}-->`; copied repo files and exports do not. */
function isWikiPage(file) {
	return readFileSync(file, 'utf8').slice(0, 400).trimStart().startsWith('<!--wiki');
}

function walkHtml(dir, out) {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (!SKIP_DIRS.has(ent.name)) walkHtml(full, out);
		} else if (ent.name.endsWith('.html') && isLintedPath(relOf(full)) && isWikiPage(full)) out.push(full);
	}
	return out;
}

/** Newest session pages: sessions/2026/10/<day>/<session>/**.html, never the whole content tree. */
function recentPages(n) {
	const files = [];
	if (!existsSync(RECENT_ROOT)) return files;
	for (const day of readdirSync(RECENT_ROOT)) {
		const dayDir = path.join(RECENT_ROOT, day);
		if (!statSync(dayDir).isDirectory()) continue;
		for (const session of readdirSync(dayDir)) {
			const dir = path.join(dayDir, session);
			if (statSync(dir).isDirectory()) walkHtml(dir, files);
		}
	}
	return files
		.map((f) => ({ f, t: statSync(f).mtimeMs }))
		.sort((a, b) => b.t - a.t)
		.slice(0, n)
		.map((x) => x.f);
}

const show = (p) => path.relative(process.cwd(), path.resolve(p)) || p;

function printFindings(file, findings) {
	const errors = findings.filter((f) => f.severity === 'error').length;
	process.stdout.write(`\n${show(file)}  ${errors} errors, ${findings.length - errors} warnings\n`);
	for (const f of findings) {
		process.stdout.write(
			`  L${f.line}  ${f.severity}  ${f.rule} [unslop ${f.unslop}]  ${f.excerpt}\n        fix: ${f.fix}\n`,
		);
	}
}

function table(rows, head) {
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
	const line = (r) => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
	return [line(head), '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|', ...rows.map(line)].join('\n') + '\n';
}

function readOrNull(file) {
	try {
		return readFileSync(file, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw e;
	}
}

function printRatchet(file, r) {
	const grown = Object.entries(r.grown).map(([rule, g]) => `${rule} ${g.before} -> ${g.after}`);
	process.stdout.write(
		`\n${show(file)}  errors ${r.before.errors} -> ${r.after.errors}  ${r.ok ? 'ok, no rule grew' : `GREW: ${grown.join(', ')}`}\n`,
	);
	if (!r.ok) {
		for (const f of r.newFindings)
			process.stdout.write(`  L${f.line}  ${f.rule} [unslop ${f.unslop}]  ${f.excerpt}\n        fix: ${f.fix}\n`);
	}
}

if (ratchetBefore !== null || ratchetRev !== null) {
	if (ratchetBefore !== null && targets.length !== 1) usage('--ratchet takes exactly one <file>');
	const results = [];
	for (const file of targets) {
		const rel = relOf(file);
		if (!isLintedPath(rel)) continue;
		const after = readOrNull(file);
		if (after === null) continue; // a deleted page adds nothing
		let before;
		if (ratchetBefore === '-') before = readFileSync(0, 'utf8');
		else if (ratchetBefore !== null) before = readOrNull(ratchetBefore);
		else {
			const repoRel = path.relative(
				execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
				path.resolve(file),
			);
			try {
				before = execFileSync('git', ['show', `${ratchetRev}:${repoRel.split(path.sep).join('/')}`], {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'ignore'],
					maxBuffer: Infinity,
				});
			} catch {
				before = null; // not in <rev>: a new page
			}
		}
		results.push({ file, ...ratchet(before, after, { path: rel }) });
	}
	let dup = null;
	let page = null;
	if (ratchetRev !== null) {
		try {
			dup = gateRefusal(ratchetRev, targets);
		} catch (error) {
			process.stderr.write(`prose-lint: the dup gate did not run: ${error.message}\n`);
		}
		try {
			page = pageGateRefusal(ratchetRev, targets);
		} catch (error) {
			process.stderr.write(`prose-lint: the page gate did not run: ${error.message}\n`);
		}
		try {
			const warned = pageGateWarnings(ratchetRev, targets);
			if (warned.length) process.stdout.write(`${warningText(warned)}\n`);
		} catch (error) {
			process.stderr.write(`prose-lint: the page gate warnings did not run: ${error.message}\n`);
		}
	}
	if (json) process.stdout.write(JSON.stringify({ standard: STANDARD_FILE, results, dup, page }, null, 2) + '\n');
	else {
		for (const r of results) printRatchet(r.file, r);
		if (results.some((r) => !r.ok))
			process.stdout.write(`\nA write may not add prose-lint errors. Standard: ${STANDARD_FILE}\n`);
		if (dup) process.stdout.write(`\n${dup}\n`);
		if (page) process.stdout.write(`\n${page}\n`);
	}
	process.exit(results.some((r) => !r.ok) || dup || page ? 1 : 0);
}

let files = [];
if (recent) files.push(...recentPages(recent));
for (let t of targets) {
	if (!existsSync(t) && existsSync(path.join(CONTENT, t))) t = path.join(CONTENT, t);
	if (!existsSync(t)) usage(`no such file or directory: ${t} (also looked under ${CONTENT})`);
	if (statSync(t).isDirectory()) files.push(...walkHtml(path.resolve(t), []));
	else files.push(t);
}
if (!files.length) usage('nothing to lint; pass files, directories or --recent N');

const results = [];
for (const file of files) {
	const rel = relOf(file);
	if (!isLintedPath(rel)) {
		results.push({ file, skipped: true, findings: [], counts: { errors: 0, warns: 0, byRule: {} } });
		continue;
	}
	results.push({ file, skipped: false, ...lintHtml(readFileSync(file, 'utf8'), { path: rel }) });
}

if (json) {
	process.stdout.write(JSON.stringify({ standard: STANDARD_FILE, results }, null, 2) + '\n');
} else {
	for (const r of results) {
		if (r.skipped) process.stdout.write(`\n${show(r.file)}  skipped (session log, requests.html or archive)\n`);
		else printFindings(r.file, r.findings);
	}
	const byRule = new Map();
	for (const r of results) {
		for (const [rule, c] of Object.entries(r.counts.byRule)) {
			const row = byRule.get(rule) ?? { errors: 0, warns: 0, files: 0 };
			row.errors += c.errors;
			row.warns += c.warns;
			row.files += 1;
			byRule.set(rule, row);
		}
	}
	const linted = results.filter((r) => !r.skipped);
	if (linted.length > 1) {
		process.stdout.write(
			'\nPer file\n' +
				table(
					linted.map((r) => [show(r.file), r.counts.errors, r.counts.warns]),
					['file', 'errors', 'warns'],
				),
		);
	}
	const rows = [...byRule.entries()]
		.sort((a, b) => b[1].errors - a[1].errors || b[1].warns - a[1].warns)
		.map(([rule, c]) => [rule, c.errors, c.warns, c.files]);
	const total = linted.reduce((n, r) => n + r.counts.errors, 0);
	const warns = linted.reduce((n, r) => n + r.counts.warns, 0);
	rows.push(['total', total, warns, linted.filter((r) => r.counts.errors + r.counts.warns > 0).length]);
	process.stdout.write('\nBy rule\n' + table(rows, ['rule', 'errors', 'warns', 'files']));
	process.stdout.write(`\nStandard: ${STANDARD_FILE}\n`);
}
process.exit(results.some((r) => r.counts.errors > 0) ? 1 : 0);
