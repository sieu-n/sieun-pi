import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { rootOf } from './wiki-mounts';
import { note, renderChildren } from './wiki-children';
import { decodeHtmlEntities, escapeAttr, escapeHtml } from './wiki-html';

/**
 * Expand `<wiki-*>` tags into sanitizable HTML. Asset paths are page-relative and confined under the content root;
 * interactivity hydrates client-side from `data-*` hooks, never inline script, so the output survives DOMPurify.
 *
 *   <wiki-figure src="assets/x.png" caption="…">
 *   <wiki-gallery dir="assets/screens">
 *   <wiki-table src="data/results.csv" sortable filterable>
 *   <wiki-children path="…">   (see wiki-children.ts)
 *   <wiki-cite src="…" note="…">number</wiki-cite>
 */

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

export async function expandWikiComponents(html: string, sourcePath: string): Promise<string> {
	let out = await replaceTag(html, 'wiki-figure', async (attrs) => renderFigure(attrs));
	out = await replaceTag(out, 'wiki-gallery', (attrs) => renderGallery(attrs, sourcePath));
	out = await replaceTag(out, 'wiki-table', (attrs) => renderTable(attrs, sourcePath));
	out = await replaceTag(out, 'wiki-children', (attrs) => renderChildren(attrs, sourcePath));
	return expandCites(out);
}

/**
 * `<wiki-cite src="data/run.json" note="what the number is and how it was read">$594</wiki-cite>` shows the number
 * with its source on hover or keyboard focus. A cite with a note and no src marks an assumption or an unknown.
 */
function expandCites(html: string): string {
	return html.replace(/<wiki-cite\b([^>]*)>([\s\S]*?)<\/wiki-cite>/gi, (_whole, raw: string, inner: string) => {
		const attrs = parseAttrs(raw);
		const src = decodeHtmlEntities(attrs.src ?? '');
		const text = decodeHtmlEntities(attrs.note ?? '');
		const label = decodeHtmlEntities(attrs.label ?? '') || citeLabel(src);
		const link = src ? `<a href="${escapeAttr(src)}">${escapeHtml(label)}</a>` : '';
		const tip = `<span class="wiki-cite-tip" role="tooltip">${escapeHtml(text)}${text && link ? ' ' : ''}${link}</span>`;
		const kind = src ? 'wiki-cite' : 'wiki-cite wiki-cite-assumed';
		return `<span class="${kind}" tabindex="0">${inner}${text || link ? tip : ''}</span>`;
	});
}

/** A short link label: the host and last path segment of a URL, or the file name of a page-relative path. */
function citeLabel(src: string): string {
	if (!src) return '';
	try {
		const url = new URL(src);
		const last = url.pathname.split('/').filter(Boolean).pop();
		return last ? `${url.hostname} · ${last}` : url.hostname;
	} catch {
		return src.split('/').filter(Boolean).pop() ?? src;
	}
}

function renderFigure(attrs: Record<string, string>): string {
	const src = attrs.src ?? '';
	if (!src) return note('figure: missing src');
	const caption = attrs.caption ?? '';
	const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
	return `<figure class="wiki-figure"><img src="${escapeAttr(src)}" alt="${escapeAttr(caption)}" data-wiki-zoom>${cap}</figure>`;
}

async function renderGallery(attrs: Record<string, string>, sourcePath: string): Promise<string> {
	const dir = attrs.dir ?? '';
	if (!dir) return note('gallery: missing dir');
	let files: string[];
	try {
		const resolved = confine(sourcePath, dir);
		files = (await readdir(resolved)).filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())).sort();
	} catch {
		return note(`gallery: "${dir}" not found`);
	}
	if (files.length === 0) return note(`gallery: no images in "${dir}"`);
	const figures = files
		.map((file) => {
			const rel = `${dir.replace(/\/$/, '')}/${file}`;
			return `<figure><img src="${escapeAttr(rel)}" alt="${escapeAttr(file)}" data-wiki-zoom><figcaption>${escapeHtml(file)}</figcaption></figure>`;
		})
		.join('');
	return `<div class="wiki-gallery">${figures}</div>`;
}

async function renderTable(attrs: Record<string, string>, sourcePath: string): Promise<string> {
	const src = attrs.src ?? '';
	if (!src) return note('table: missing src');
	let rows: string[][];
	try {
		rows = parseCsv(await readFile(confine(sourcePath, src), 'utf8'));
	} catch {
		return note(`table: "${src}" not found`);
	}
	if (rows.length === 0) return note(`table: "${src}" is empty`);
	const [header, ...body] = rows;
	const flags = ['sortable' in attrs ? 'data-wiki-sortable' : '', 'filterable' in attrs ? 'data-wiki-filterable' : '']
		.filter(Boolean)
		.join(' ');
	const thead = `<thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>`;
	const tbody = `<tbody>${body
		.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
		.join('')}</tbody>`;
	return `<table class="wiki-table"${flags ? ` ${flags}` : ''}>${thead}${tbody}</table>`;
}

/** Parse `key="value"` attributes and bare boolean flags (`sortable`) from a tag's attribute string. */
function parseAttrs(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of raw.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) {
		const key = match[1];
		if (!key) continue;
		attrs[key] = match[2] ?? '';
	}
	return attrs;
}

async function replaceTag(
	html: string,
	tag: string,
	render: (attrs: Record<string, string>) => Promise<string>,
): Promise<string> {
	const re = new RegExp(`<${tag}\\b([^>]*?)\\s*/?>(?:</${tag}>)?`, 'gi');
	const matches = Array.from(html.matchAll(re));
	if (matches.length === 0) return html;
	let result = '';
	let last = 0;
	for (const match of matches) {
		result += html.slice(last, match.index);
		result += await render(parseAttrs(match[1] ?? ''));
		last = (match.index ?? 0) + match[0].length;
	}
	return result + html.slice(last);
}

/** Resolve a page-relative asset path to a confined absolute path under the content root. */
function confine(sourcePath: string, relative: string): string {
	const pageDir = path.posix.dirname(sourcePath);
	const joined = path.posix.normalize(path.posix.join(pageDir === '.' ? '' : pageDir, relative));
	if (joined.startsWith('../') || joined.includes('/../')) throw new Error('Path escapes content root');
	const target = rootOf(joined);
	const root = target.root;
	const full = path.resolve(root, target.relative);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error('Path escapes content root');
	return full;
}

/** Minimal RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i += 1;
				} else quoted = false;
			} else cell += char;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(cell);
			cell = '';
		} else if (char === '\n') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else if (char !== '\r') cell += char;
	}
	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}
