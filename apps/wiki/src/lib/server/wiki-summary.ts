import type { Stats } from 'node:fs';
import path from 'node:path';
import { deriveTitleFromPath } from './session-artifact-index';
import type { WikiPageSummary } from './wiki';
import { parseFrontmatter } from './wiki-frontmatter';
import {
	extractHtmlHeadings,
	extractHtmlHrefs,
	extractHtmlTitle,
	makeHtmlExcerpt,
	makeSearchText,
	parseHtmlMeta,
} from './wiki-html';

/**
 * The JSON round trip copies every string the summary keeps. V8 stores a substring of a long string
 * as a pointer into it, so one heading or excerpt kept the whole 64 KiB read alive: 28 KB per page
 * held, against 9 KB after the copy (4,071 sampled pages).
 */
export function summarize(content: string, wikiPath: string, fileStat: Stats): WikiPageSummary {
	const extension = path.extname(wikiPath).slice(1).toLowerCase() || 'text';
	const isHtml = extension === 'html';
	const meta = isHtml ? parseHtmlMeta(content) : parseFrontmatter(content);

	const summary: WikiPageSummary = {
		path: wikiPath,
		title: isHtml
			? (meta.title ?? extractHtmlTitle(content) ?? deriveTitleFromPath(wikiPath))
			: extractTitle(content, wikiPath),
		kind: extension,
		size: fileStat.size,
		updated: fileStat.mtime.toISOString(),
		headings: isHtml ? extractHtmlHeadings(content) : extractHeadings(content),
		links: isHtml
			? extractHtmlHrefs(content)
					.map((href) => normalizeLinkTarget(href, wikiPath))
					.filter((target): target is string => Boolean(target))
			: extractLinks(content, wikiPath),
		excerpt: isHtml ? makeHtmlExcerpt(content) : makeExcerpt(content),
		searchText: makeSearchText(content, isHtml),
		meta,
		firstH1Text: isHtml ? (extractHtmlTitle(content) ?? undefined) : undefined,
	};
	return JSON.parse(JSON.stringify(summary)) as WikiPageSummary;
}

function extractTitle(content: string, relativePath: string): string {
	const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	return deriveTitleFromPath(relativePath);
}

function extractHeadings(content: string): string[] {
	return Array.from(content.matchAll(/^#{1,4}\s+(.+)$/gm))
		.map((match) => match[1]?.trim())
		.filter((heading): heading is string => Boolean(heading))
		.slice(0, 20);
}

function extractLinks(content: string, sourcePath: string): string[] {
	const links = new Set<string>();
	// Strip code first: link syntax inside ``` fences ``` or `inline code` is documentation
	// (e.g. a page explaining `[[wikilinks]]`), not a navigational link — don't index it.
	const text = stripMarkdownCode(content);
	for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const normalized = normalizeLinkTarget(match[1] ?? '', sourcePath);
		if (normalized) links.add(normalized);
	}
	for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
		const normalized = normalizeLinkTarget(match[1] ?? '', sourcePath);
		if (normalized) links.add(normalized);
	}
	return Array.from(links);
}

function stripMarkdownCode(content: string): string {
	return content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
}

export function normalizeLinkTarget(rawTarget: string, sourcePath: string): string | null {
	let target = rawTarget.trim().replace(/^<|>$/g, '').split(/\s+/)[0] ?? '';
	if (!target || target.startsWith('#')) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
	// Absolute paths are app routes (e.g. /graph, /api, /lint), not content links —
	// leave them for the browser, don't resolve or rewrite them.
	if (target.startsWith('/')) return null;

	target = target.split('#')[0]?.split('?')[0] ?? '';
	try {
		target = decodeURIComponent(target);
	} catch {
		return null;
	}

	target = target.replace(/\\/g, '/').replace(/^\/+/, '');
	for (const prefix of ['apps/llm-wiki/content/']) {
		if (target.startsWith(prefix)) target = target.slice(prefix.length);
	}

	const sourceDir = path.posix.dirname(sourcePath);
	const joined = target.startsWith('/') ? target : path.posix.join(sourceDir === '.' ? '' : sourceDir, target);
	const normalized = path.posix.normalize(joined);
	if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;
	return normalized;
}

function makeExcerpt(content: string): string {
	return content
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 260);
}
