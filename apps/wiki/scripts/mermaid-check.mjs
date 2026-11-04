#!/usr/bin/env node
/**
 * Mermaid check: a page write may not add a mermaid block that mermaid cannot parse, because the page script draws
 * `pre.mermaid` with suppressErrors and a block that fails shows its raw source with no error anyone sees.
 * The blocks are each `<pre class="mermaid">` and `<wiki-mermaid>` outside an HTML comment. Each is read as mermaid.run
 * reads it in the browser (innerHTML, entities decoded, dedented, trimmed, `<br>` made `<br/>`) and parsed with the
 * mermaid that apps/wiki ships to the page. The parse runs in a child node process, because mermaid's DOMPurify needs a
 * global `window` (jsdom here) that must not leak into the server. On us-metal02 on 2026-11-04, at load average 284, the
 * child loaded jsdom and mermaid in 3.5 s, its first flowchart took 0.5 s and each later block 18 to 43 ms, and one child
 * parsed all 3114 blocks of the 353 curated pages that hold one in 87 s. The server keeps each block's result, so a write
 * that only keeps blocks it has checked spawns nothing, and no child stays up between writes.
 * A write that keeps a block that already failed saves with a warning, so an old break never blocks a writer.
 *
 *   node apps/wiki/scripts/mermaid-check.mjs <page.html>...   print each block that fails; exit 1 when one does
 *   node apps/wiki/scripts/mermaid-check.mjs --scan <content root> <out.json>   every curated page and the home page
 *
 * Why: on 2026-11-04 apps/crawler-v3/architecture/docker-and-containers/index.html held a decision node that had lost its
 * `{"` and `"}`, and 27 wiki-dream revisions in 7 days saved it while prose-lint read 0 errors.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRE = /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi;
const WIKI_MERMAID = /<wiki-mermaid\b[^>]*>([\s\S]*?)<\/wiki-mermaid\s*>/gi;
const MERMAID_CLASS = /\bclass\s*=\s*(?:"[^"]*\bmermaid\b[^"]*"|'[^']*\bmermaid\b[^']*'|mermaid\b)/i;
const COMMENT = /<!--[\s\S]*?-->/g;

/** Each mermaid block of `html` outside a comment, in page order: `{ line, raw }`, raw being the block's inner HTML. */
export function mermaidBlocks(html) {
	const comments = [...html.matchAll(COMMENT)].map((m) => [m.index, m.index + m[0].length]);
	const inComment = (at) => comments.some(([from, to]) => at >= from && at < to);
	const found = [];
	for (const m of html.matchAll(PRE)) if (MERMAID_CLASS.test(m[1]) && !inComment(m.index)) found.push([m.index, m[2]]);
	for (const m of html.matchAll(WIKI_MERMAID)) if (!inComment(m.index)) found.push([m.index, m[1]]);
	return found
		.sort((a, b) => a[0] - b[0])
		.map(([at, raw]) => ({ line: html.slice(0, at).split('\n').length, raw }));
}

const SELF = (() => {
	const here = fileURLToPath(import.meta.url);
	return path.basename(here) === 'mermaid-check.mjs' ? here : path.resolve(process.cwd(), 'scripts/mermaid-check.mjs');
})();
const known = new Map();

/** Run the parser child over `raws` and give one error text or null per raw. */
function parseInChild(raws) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [SELF, '--child'], { cwd: path.dirname(path.dirname(SELF)), stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) return reject(new Error(`mermaid parser exited ${code}: ${err.slice(-500)}`));
			try {
				resolve(JSON.parse(out));
			} catch (error) {
				reject(new Error(`mermaid parser gave no JSON: ${error}; ${err.slice(-500)}`));
			}
		});
		child.stdin.end(JSON.stringify(raws));
	});
}

/** The parse error of each raw block, or null when it parses; a raw seen before reuses its result. */
export async function parseMermaid(raws) {
	const fresh = [...new Set(raws.filter((raw) => !known.has(raw)))];
	if (fresh.length) {
		const errors = await parseInChild(fresh);
		fresh.forEach((raw, i) => known.set(raw, errors[i]));
	}
	return raws.map((raw) => known.get(raw));
}

const firstLine = (raw) => raw.replace(/<[^>]*>/g, ' ').trim().split('\n')[0].trim().slice(0, 60);
const shortError = (error) => error.split('\n').slice(0, 4).join(' | ');

/**
 * `{ reasons, warnings }` for a write of `after` over `before` (null for a new page). A block that fails to parse is a
 * reason, which refuses the write, unless `before` held the same block, which makes it a warning.
 */
export async function mermaidWriteCheck(before, after) {
	const blocks = mermaidBlocks(after);
	if (!blocks.length) return { reasons: [], warnings: [] };
	const errors = await parseMermaid(blocks.map((b) => b.raw));
	const had = new Set(mermaidBlocks(before ?? '').map((b) => b.raw.trim()));
	const reasons = [];
	const warnings = [];
	blocks.forEach((block, i) => {
		if (errors[i] === null) return;
		const what = `the mermaid block at line ${block.line} ("${firstLine(block.raw)}") does not parse: ${shortError(errors[i])}`;
		if (had.has(block.raw.trim())) warnings.push(`${what}. The page held this block before the write, so it saved; fix the diagram`);
		else reasons.push(what);
	});
	return { reasons, warnings };
}

/** The child: read a JSON array of raw blocks on stdin and print a JSON array of error texts or nulls. */
async function child() {
	let input = '';
	for await (const chunk of process.stdin) input += chunk;
	const raws = JSON.parse(input);
	const { JSDOM } = await import('jsdom');
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	const { default: mermaid } = await import('mermaid');
	const { dedent } = await import('ts-dedent');
	mermaid.initialize({ startOnLoad: false });
	const holder = document.createElement('pre');
	const decoder = document.createElement('div');
	const entityDecode = (html) => {
		decoder.innerHTML = escape(html).replace(/%26/g, '&').replace(/%23/g, '#').replace(/%3B/g, ';');
		return unescape(decoder.textContent);
	};
	const errors = [];
	for (const raw of raws) {
		holder.innerHTML = raw;
		const text = dedent(entityDecode(holder.innerHTML)).trim().replace(/<br\s*\/?>/gi, '<br/>');
		try {
			await mermaid.parse(text);
			errors.push(null);
		} catch (error) {
			errors.push(String(error?.message ?? error));
		}
	}
	process.stdout.write(JSON.stringify(errors));
}

const SPACES = ['apps', 'domains', 'projects', 'experiments'];

/** Content paths of every curated page (the dup-gate isCuratedPath rule) and the home page under `root`. */
function curatedPages(root) {
	const pages = existsSync(path.join(root, 'index.html')) ? ['index.html'] : [];
	const walk = (dir) => {
		for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const rel = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== 'data' && entry.name !== 'assets') walk(rel);
			} else if (entry.name.endsWith('.html')) pages.push(rel);
		}
	};
	for (const space of SPACES) if (existsSync(path.join(root, space))) walk(space);
	return pages.sort();
}

/** Parse every block of `pages` ([rel, html]) in one child and give the rows of the blocks that fail. */
async function failingRows(pages) {
	const blocks = pages.flatMap(([rel, html]) => mermaidBlocks(html).map((b) => ({ path: rel, ...b })));
	const errors = await parseMermaid(blocks.map((b) => b.raw));
	return {
		blocks: blocks.length,
		failing: blocks.flatMap((b, i) => (errors[i] === null ? [] : [{ path: b.path, line: b.line, first: firstLine(b.raw), error: errors[i] }])),
	};
}

async function main(argv) {
	if (argv[0] === '--child') return child();
	if (argv[0] === '--scan') {
		const [root, out] = argv.slice(1);
		const started = Date.now();
		const rels = curatedPages(root);
		const pages = rels.map((rel) => [rel, readFileSync(path.join(root, rel), 'utf8')]);
		const { blocks, failing } = await failingRows(pages);
		const withBlocks = pages.filter(([, html]) => mermaidBlocks(html).length).length;
		const report = {
			scannedAt: new Date().toISOString(),
			root,
			pages: rels.length,
			pagesWithBlocks: withBlocks,
			blocks,
			failingBlocks: failing.length,
			failingPages: new Set(failing.map((f) => f.path)).size,
			ms: Date.now() - started,
			failing,
		};
		writeFileSync(out, JSON.stringify(report, null, 2));
		console.log(`${report.failingBlocks} of ${blocks} blocks on ${report.failingPages} of ${withBlocks} pages fail (${rels.length} pages, ${report.ms} ms)`);
		return;
	}
	const { failing } = await failingRows(argv.map((file) => [file, readFileSync(file, 'utf8')]));
	for (const f of failing) console.log(`${f.path}:${f.line}: ${shortError(f.error)}`);
	process.exitCode = failing.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
