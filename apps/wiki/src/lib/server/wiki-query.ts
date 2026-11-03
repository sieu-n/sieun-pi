/** grep (content regex), find (path glob) and section or line slicing over the wiki index. */
import { authorityAllows, getWikiIndex, readRawContent, type AuthorityOpts, type WikiPageSummary } from './wiki';
import { rowFor, rowsFor, type ResultRow } from './wiki-results';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Glob → RegExp: `**` any depth, `*` within a segment. */
function globToRe(glob: string): RegExp {
	const re = glob
		.split(/(\*\*|\*)/)
		.map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : escapeRe(part)))
		.join('');
	return new RegExp(`^${re}$`);
}

export function facetMatch(
	page: WikiPageSummary,
	f: { kind?: string; app?: string; project?: string; status?: string; tag?: string },
): boolean {
	if (f.kind && (page.meta.kind ?? page.kind) !== f.kind) return false;
	if (f.app && !page.meta.apps.includes(f.app)) return false;
	if (f.project && !(page.meta.projects ?? []).includes(f.project)) return false;
	if (f.status && page.meta.status !== f.status) return false;
	if (f.tag && !page.meta.tags.includes(f.tag)) return false;
	return true;
}

/** find — locate pages by path glob (+ facets); no content scan. */
export async function find(
	glob: string | null,
	facets: { kind?: string; app?: string; project?: string; status?: string; tag?: string } = {},
	limit: number,
	authority: AuthorityOpts = {},
): Promise<ResultRow[]> {
	const index = await getWikiIndex();
	const re = glob ? globToRe(glob) : null;
	const hits = index.pages
		.filter((p) => (re ? re.test(p.path) : true) && facetMatch(p, facets) && authorityAllows(p.path, authority))
		.slice(0, limit);
	return rowsFor(hits);
}

/** grep — content regex across content pages (skips the @code mirror). Returns one row per matching line. */
export async function grep(
	pattern: string,
	opts: { flags?: string; glob?: string; context?: number; max?: number } & AuthorityOpts = {},
): Promise<ResultRow[]> {
	const index = await getWikiIndex();
	const flags = `${(opts.flags ?? '').replace(/[^gimsuy]/g, '')}`.includes('i') ? 'i' : '';
	let re: RegExp;
	try {
		re = new RegExp(pattern, flags);
	} catch {
		throw new Error(`invalid regex: ${pattern}`);
	}
	const ctx = opts.context ?? 2;
	const max = opts.max ?? Infinity;
	const globRe = opts.glob ? globToRe(opts.glob) : null;
	const out: ResultRow[] = [];
	for (const page of index.pages) {
		if (page.path.startsWith('@code/')) continue; // grep your wiki, not the read-only mirror
		if (!authorityAllows(page.path, opts)) continue;
		if (globRe && !globRe.test(page.path)) continue;
		const content = await readRawContent(page.path);
		if (!content) continue;
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			if (!re.test(lines[i])) continue;
			out.push(
				rowFor(page, {
					match: {
						line: i + 1,
						text: lines[i].trim(),
						context: lines.slice(Math.max(0, i - ctx), i + ctx + 1),
					},
				}),
			);
			if (out.length >= max) return out;
		}
	}
	return out;
}

/** Slice one section of a page by heading anchor (HTML `<h* id>` or markdown slug). */
export function sliceSection(content: string, anchor: string): string | null {
	const htmlRe = new RegExp(`<h([1-6])[^>]*id="${escapeRe(anchor)}"[^>]*>`, 'i');
	const hm = content.match(htmlRe);
	if (hm && hm.index !== undefined) {
		const level = Number(hm[1]);
		const after = hm.index + hm[0].length;
		const nextRe = new RegExp(`<h[1-${level}][^>]*>`, 'i');
		const nm = content.slice(after).match(nextRe);
		return content.slice(hm.index, nm && nm.index !== undefined ? after + nm.index : undefined);
	}
	const lines = content.split('\n');
	const slug = (s: string): string =>
		s
			.toLowerCase()
			.replace(/[^\w\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-');
	for (let i = 0; i < lines.length; i += 1) {
		const h = lines[i].match(/^(#{1,6})\s+(.+)$/);
		if (!h || slug(h[2]) !== anchor) continue;
		const level = h[1].length;
		let end = lines.length;
		for (let j = i + 1; j < lines.length; j += 1) {
			const hj = lines[j].match(/^(#{1,6})\s+/);
			if (hj && hj[1].length <= level) {
				end = j;
				break;
			}
		}
		return lines.slice(i, end).join('\n');
	}
	return null;
}

/** Slice a 1-based inclusive line range "10-40" (or "10" for a single line). */
export function sliceLines(content: string, range: string): string | null {
	const m = range.match(/^(\d+)(?:-(\d+))?$/);
	if (!m) return null;
	const start = Math.max(1, Number(m[1]));
	const end = m[2] ? Number(m[2]) : start;
	return content
		.split('\n')
		.slice(start - 1, end)
		.join('\n');
}
