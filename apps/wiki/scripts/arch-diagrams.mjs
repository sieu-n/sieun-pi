#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCH_DIR = 'apps/llm-wiki/content/domains/architecture';
const COMPOSE_FILE = /(^|\/)[\w.-]*compose[\w.-]*\.ya?ml$/;

export function composeNames(text) {
	const names = new Set();
	let inServices = false;
	let serviceIndent = null;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\s+#.*$/, '');
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			inServices = /^services:\s*$/.test(line);
			serviceIndent = null;
			continue;
		}
		if (!inServices) continue;
		const key = line.trim().match(/^["']?([\w.-]+)["']?:/);
		if (serviceIndent === null && key) serviceIndent = indent;
		if (indent === serviceIndent && key) names.add(key[1]);
		const container = line.match(/^\s+container_name:\s*["']?([\w.-]+)["']?\s*$/);
		if (container) names.add(container[1]);
	}
	return names;
}

function trackedComposeFiles(repo) {
	const { GIT_INDEX_FILE, ...env } = process.env;
	const out = execFileSync('git', ['ls-files', '-z', '--', '*compose*.yml', '*compose*.yaml'], {
		cwd: repo,
		encoding: 'utf8',
		env,
	});
	return out.split('\0').filter((path) => COMPOSE_FILE.test(path) && !path.startsWith('apps/llm-wiki/content/'));
}

export function knownNames(repo, composeFiles = trackedComposeFiles(repo)) {
	const names = new Map();
	const add = (name, source) => {
		const key = name.toLowerCase();
		if (!names.has(key)) names.set(key, source);
	};
	for (const file of composeFiles) {
		const path = join(repo, file);
		if (existsSync(path)) for (const name of composeNames(readFileSync(path, 'utf8'))) add(name, file);
	}
	const apps = join(repo, 'apps');
	for (const dir of existsSync(apps) ? readdirSync(apps) : []) {
		if (dir === 'node_modules' || dir.startsWith('.') || !statSync(join(apps, dir)).isDirectory()) continue;
		add(dir, `apps/${dir}`);
		const pkg = join(apps, dir, 'package.json');
		if (existsSync(pkg)) {
			const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
			if (name) add(name, `apps/${dir}/package.json`);
		}
	}
	return names;
}

const SHAPES = [
	['[(', ')]'],
	['([', '])'],
	['[[', ']]'],
	['((', '))'],
	['{{', '}}'],
	['[/', '/]'],
	['[\\', '\\]'],
	['[', ']'],
	['(', ')'],
	['{', '}'],
	['>', ']'],
];

function labelName(label) {
	const first = label.split(/<br\s*\/?>/i)[0];
	return first
		.replace(/<[^>]+>/g, '')
		.replace(/^["'`]|["'`]$/g, '')
		.split(/\s*[,·]\s*/)
		.map((name) => name.trim().replace(/^`|`$/g, ''))
		.filter(Boolean);
}

export function mermaidNodes(source) {
	const nodes = new Map();
	const classLines = [];
	const nodeStart = /(^|[\s;&>|-])([A-Za-z_][\w]*)(?=\s*(\[\(|\(\[|\[\[|\(\(|\{\{|\[\/|\[\\|\[|\(|\{|>))/g;
	for (const raw of source.split('\n')) {
		const line = raw.replace(/\|[^|]*\|/g, ' ');
		const trimmed = line.trim();
		const cls = trimmed.match(/^class\s+([\w,\s]+?)\s+([\w-]+)\s*;?$/);
		if (cls) {
			classLines.push({ ids: cls[1].split(/\s*,\s*/), name: cls[2] });
			continue;
		}
		if (/^(classDef|style|linkStyle|subgraph|end|flowchart|graph|direction|%%)\b/.test(trimmed)) continue;
		let match;
		nodeStart.lastIndex = 0;
		while ((match = nodeStart.exec(line))) {
			const id = match[2];
			let at = match.index + match[0].length;
			while (line[at] === ' ') at++;
			const pair = SHAPES.find(([open]) => line.startsWith(open, at));
			if (!pair) continue;
			at += pair[0].length;
			let label;
			let end;
			if (line[at] === '"') {
				end = line.indexOf('"', at + 1);
				if (end < 0) continue;
				label = line.slice(at + 1, end);
				end = line.indexOf(pair[1], end);
			} else {
				end = line.indexOf(pair[1], at);
				if (end < 0) continue;
				label = line.slice(at, end);
			}
			if (end < 0) continue;
			const after = line.slice(end + pair[1].length).match(/^:::([\w-]+)/);
			const node = nodes.get(id) ?? { id, label, classes: new Set() };
			if (!nodes.has(id)) nodes.set(id, node);
			if (after) node.classes.add(after[1]);
			nodeStart.lastIndex = end + pair[1].length;
		}
	}
	for (const { ids, name } of classLines)
		for (const id of ids) {
			const node = nodes.get(id) ?? { id, label: id, classes: new Set() };
			nodes.set(id, node);
			node.classes.add(name);
		}
	return [...nodes.values()];
}

export function frontmatter(html) {
	const meta = html.match(/<!--wiki\s*([\s\S]*?)-->/);
	if (!meta) return null;
	try {
		return JSON.parse(meta[1]);
	} catch {
		return null;
	}
}

export function mermaidBlocks(html) {
	return [...html.matchAll(/<pre class="mermaid"[^>]*>([\s\S]*?)<\/pre>/g)].map((m) =>
		m[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'),
	);
}

export function checkPage(html, known) {
	const findings = [];
	const meta = frontmatter(html);
	if (!meta) findings.push({ kind: 'frontmatter', detail: 'no readable <!--wiki {json}--> frontmatter' });
	else
		for (const key of ['owner', 'last_checked'])
			if (!meta[key]) findings.push({ kind: 'frontmatter', detail: `frontmatter has no ${key}` });
	let checked = 0;
	for (const block of mermaidBlocks(html))
		for (const node of mermaidNodes(block)) {
			if (!node.classes.has('svc') || node.classes.has('planned')) continue;
			for (const name of labelName(node.label)) {
				checked++;
				if (!known.has(name.toLowerCase()))
					findings.push({
						kind: 'missing',
						node: node.id,
						name,
						detail: `node ${node.id} names ${name}, which no compose file or apps/ entry has`,
					});
			}
		}
	return { checked, findings };
}

export function archPages(repo, dir = ARCH_DIR) {
	const root = join(repo, dir);
	if (!existsSync(root)) return [];
	const pages = [];
	const walk = (folder) => {
		for (const name of readdirSync(folder)) {
			const path = join(folder, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.html')) pages.push(path);
		}
	};
	walk(root);
	return pages.sort();
}

export function checkRepo(repo, { dir = ARCH_DIR, composeFiles } = {}) {
	const known = knownNames(repo, composeFiles);
	const pages = archPages(repo, dir).map((path) => {
		const html = readFileSync(path, 'utf8');
		const isHub = path.endsWith(`${dir}/index.html`);
		const result = mermaidBlocks(html).length || !isHub ? checkPage(html, known) : { checked: 0, findings: [] };
		return { page: relative(repo, path), ...result };
	});
	return { known: known.size, pages, checked: pages.reduce((n, p) => n + p.checked, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const repo = process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : process.cwd();
	const report = checkRepo(repo);
	if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
	else {
		for (const page of report.pages) {
			console.log(`${page.page}: ${page.checked} names checked, ${page.findings.length} findings`);
			for (const finding of page.findings) console.log(`  ${finding.kind}: ${finding.detail}`);
		}
		console.log(`${report.pages.length} pages, ${report.checked} names checked against ${report.known} known names`);
	}
	const bad = report.pages.some((page) => page.findings.length) || report.pages.length === 0;
	process.exit(bad ? 1 : 0);
}
