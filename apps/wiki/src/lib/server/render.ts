import { base as appBase } from '$app/paths';
import { getWikiIndex, normalizeLinkTarget, type WikiPageSummary } from './wiki';
import { resolveLink } from './wiki-index';
import { expandWikiComponents } from './wiki-components';
import { escapeHtml, stripHtmlMeta, stripHtmlTags } from './wiki-html';
import { filterLogs, getLogIndex, type LogQuery } from './wiki-logs';
import { markdownToHtml } from './markdown-html.mjs';
import { sanitizeHtml } from './sanitize-html.mjs';

export type TocEntry = { depth: number; text: string; id: string };
export type RenderedPage = { html: string; toc: TocEntry[] };

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Pages written while each Mac ran its own wiki link to it absolutely; this server answers those paths itself. */
const LOCAL_WIKI_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1):5176(?=\/)/i;

/** A root-relative href written in a page, such as /raw/x or /timeline, under the app's base path (/wiki). */
function routed(href: string): string {
	if (!href.startsWith('/') || href.startsWith('//') || href === appBase || href.startsWith(`${appBase}/`)) return href;
	return `${appBase}${href}`;
}

/**
 * Render a wiki page to sanitized HTML. HTML is the only authored format; `md` pages (the `@code/` mirror) convert to HTML
 * for display, and data files render as escaped source in a `<pre>`.
 */
export async function renderWikiPage(content: string, page: WikiPageSummary): Promise<RenderedPage> {
	if (page.kind === 'html') return renderHtmlPage(content, page.path);
	if (page.kind === 'md' || page.kind === 'markdown') return renderMarkdownPage(content, page.path);
	return renderSource(content);
}

/** Markdown for the `@code/` mirror: strip YAML frontmatter, convert with marked, then reuse `renderHtmlPage`. */
async function renderMarkdownPage(content: string, sourcePath: string): Promise<RenderedPage> {
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
	const rendered = await renderHtmlPage(await markdownToHtml(body), sourcePath);
	// md is display-only: strip data-* so raw HTML inside markdown can never reach
	// the trusted page hydration hooks (data-wiki-echart, data-src, …).
	return { ...rendered, html: rendered.html.replace(/\sdata-[a-z0-9-]+="[^"]*"/gi, '') };
}

/** Raw source (data files like `.yaml`/`.json`/`.txt`) shown as an escaped `<pre>`. */
function renderSource(content: string): RenderedPage {
	const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return { html: sanitizeHtml(`<pre class="wiki-source"><code>${escaped}</code></pre>`), toc: [] };
}

/** Remove the first `<h1>` by document position; the page shell renders the canonical title instead. */
export function stripFirstH1(html: string): string {
	return html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, '');
}

/**
 * Render an HTML wiki page, rewriting links and heading IDs through the same `normalizeLinkTarget` / `resolveLink` /
 * `slugify` the index uses, so rendered links and the backlink graph agree, then sanitize.
 */
export async function renderHtmlPage(content: string, sourcePath: string): Promise<RenderedPage> {
	const index = await getWikiIndex();
	const stripped = stripFirstH1(stripHtmlMeta(content));
	const expanded = await expandLogsDirectives(await expandWikiComponents(stripped, sourcePath));
	const toc: TocEntry[] = [];
	const usedIds = new Map<string, number>();
	const withHeadings = injectHeadingIds(expanded, toc, usedIds);
	const withLinks = rewriteHtmlAnchors(withHeadings, sourcePath, index.byPath);
	const rewritten = rewriteHtmlImages(withLinks, sourcePath);
	return { html: sanitizeHtml(rewritten, ['target']), toc };
}

/** Expand a fenced `language-logs` directive (`app:` / `tags:` / `status:` / `since:` / `limit:`) into a live session-log list. */
async function expandLogsDirectives(html: string): Promise<string> {
	if (!html.includes('language-logs')) return html;
	const logs = await getLogIndex();
	return html.replace(/<pre>\s*<code class="language-logs">([\s\S]*?)<\/code>\s*<\/pre>/gi, (_whole, body: string) => {
		const query = parseLogsDirective(body);
		const entries = filterLogs(logs, query);
		if (entries.length === 0) return '<p class="logs-empty">No session logs match this filter yet.</p>';
		const items = entries
			.map(
				(e) =>
					`<li><time>${e.date}</time> <a href="${appBase}/page/${e.path}">${escapeHtml(e.title)}</a>` +
					(e.status ? ` <span class="log-status">${escapeHtml(e.status)}</span>` : '') +
					'</li>',
			)
			.join('');
		return `<ul class="logs-embed">${items}</ul>`;
	});
}

function parseLogsDirective(body: string): LogQuery {
	const query: LogQuery = {};
	for (const line of body.split('\n')) {
		const m = /^\s*(app|tags|status|since|until|limit)\s*:\s*(.+?)\s*$/.exec(line.replace(/&amp;/g, '&'));
		if (!m) continue;
		const value = m[2];
		if (m[1] === 'limit') query.limit = Number.parseInt(value, 10);
		else if (m[1] === 'tags')
			query.tags = value
				.replace(/^\[|\]$/g, '')
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
		else query[m[1] as 'app' | 'status' | 'since' | 'until'] = value;
	}
	return query;
}

function injectHeadingIds(html: string, toc: TocEntry[], usedIds: Map<string, number>): string {
	return html.replace(
		/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi,
		(match, level: string, attrs: string, inner: string) => {
			const text = stripHtmlTags(inner).trim();
			if (!text) return match;
			const existing = attrs.match(/\bid\s*=\s*"([^"]+)"/i)?.[1];
			const base = slugify(text);
			const seen = usedIds.get(base) ?? 0;
			usedIds.set(base, seen + 1);
			const id = existing ?? (seen === 0 ? base : `${base}-${seen}`);
			if (Number(level) <= 3) toc.push({ depth: Number(level), text, id });
			return `<h${level}${existing ? attrs : `${attrs} id="${id}"`}>${inner}</h${level}>`;
		},
	);
}

function rewriteHtmlAnchors(html: string, sourcePath: string, byPath: Map<string, WikiPageSummary>): string {
	return html.replace(/<a\b([^>]*?)\bhref="([^"]+)"([^>]*)>/gi, (match, pre: string, written: string, post: string) => {
		if (written.startsWith('#')) return match;
		const href = written.replace(LOCAL_WIKI_ORIGIN, '');
		const lead = pre.trim() ? ` ${pre.trim()}` : '';
		if (EXTERNAL_SCHEME.test(href)) {
			return `<a${lead} href="${href}"${post} target="_blank" rel="noopener noreferrer" class="external">`;
		}
		const normalized = normalizeLinkTarget(href, sourcePath);
		if (!normalized) return routed(href) === written ? match : `<a${lead} href="${routed(href)}"${post}>`;
		const resolved = resolveLink(normalized, byPath);
		if (byPath.has(resolved)) return `<a${lead} href="${appBase}/page/${encodeURI(resolved)}"${post}>`;
		return `<a${lead} href="${appBase}/page/${encodeURI(normalized)}"${post} class="wikilink-missing" data-missing="true">`;
	});
}

function rewriteHtmlImages(html: string, sourcePath: string): string {
	return html.replace(
		/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*?)\s*\/?>/gi,
		(match, pre: string, written: string, post: string) => {
			const src = written.replace(LOCAL_WIKI_ORIGIN, '');
			const lead = pre.trim() ? ` ${pre.trim()}` : '';
			if (src !== written || (src.startsWith('/') && routed(src) !== src))
				return `<img${lead} src="${routed(src)}"${post} loading="lazy">`;
			if (EXTERNAL_SCHEME.test(src) || src.startsWith('/')) return match;
			const normalized = normalizeLinkTarget(src, sourcePath);
			if (!normalized) return match;
			return `<img${lead} src="${appBase}/raw/${encodeURI(normalized)}"${post} loading="lazy">`;
		},
	);
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}
