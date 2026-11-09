import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { json, text } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { base } from '$app/paths';
import { env } from '$env/dynamic/private';
import type { AgentVerb } from '../../params/agentVerb';
import { isLintedPath, ratchet, savedLintAnswer, STANDARD_FILE } from '$lib/prose-lint.mjs';
import { heldByWrite, type HeldRow } from '../../../scripts/dup-held.mjs';
import { codeRepoDir } from '../wiki-config.mjs';
import { isSessionPath } from './session-artifact-index';
import { rootOf } from './wiki-mounts';
import { scanWikiFiles } from './wiki-secrets.mjs';
import { renderWikiPage } from './render';
import { sharedRuns } from './shared-runs';
import { loadSkillMetrics, SKILL_METRICS_ENABLED } from './skill-metrics';
import {
	authorityOptsFrom,
	getBacklinks,
	getContentRoot,
	getContextPack,
	getGraph,
	getHealth,
	getManifest,
	getRecent,
	getWikiIndex,
	normalizeRequestedPath,
	PAGE_READ_LIMIT,
	readPage,
	readRawContent,
	searchPages,
} from './wiki';
import { getMirrorHistory } from './wiki-git-history';
import { getLintReport } from './wiki-lint';
import { facetMatch, find, grep, sliceLines, sliceSection } from './wiki-query';
import { rowFor, rowsFor } from './wiki-results';
import { appendEvent, closeSession, openSession } from './wiki-sessions';
import { getStaleReport } from './wiki-stale';
import { getSubtree } from './wiki-tree';
import * as store from './wiki-store';
import {
	applyEdits,
	assertContentRelative,
	assertSessionWorkspaceWritable,
	commitPage,
	readForEdit,
	supersedePage,
	withPageLock,
	WriteError,
	type Edit,
} from './wiki-write';

/**
 * The agent API: one table of verbs, served by src/routes/api/agent/[...verb=agentVerb]/+server.ts. Each method of a
 * verb has its handler and, when it is documented, its OpenAPI operation, so GET /api/agent/openapi is built from the
 * same table that answers the calls.
 */
type Ctx = { url: URL; request: Request; verb: string };
type Op = { run: (c: Ctx) => Response | Promise<Response>; doc?: Record<string, unknown> };
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
type Verb = Partial<Record<Method, Op>>;

const EDITABLE = dev || env.WIKI_EDITABLE === 'true';
const SESSION_VERB = 'sessions/{id}/events';
const ENDPOINT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const COVERAGE =
	'Tracked views include wiki opens, agent API reads, Claude Skill loads, and Codex wrapper reads. Direct Codex filesystem reads outside the wrapper are not observable.';
/** Page formats go through POST /api/agent/page, which runs the prose lint; every other file a page co-locates is an asset. */
const PAGE_EXTENSIONS = /\.(html?|md)$/i;

const fail = (error: string, status: number, extra: Record<string, unknown> = {}) =>
	json({ error, ...extra }, { status });
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const param = (c: Ctx, name: string) => c.url.searchParams.get(name);
const optional = (c: Ctx, name: string) => param(c, name) ?? undefined;
const facets = (c: Ctx) => ({
	kind: optional(c, 'kind'),
	app: optional(c, 'app'),
	project: optional(c, 'project'),
	status: optional(c, 'status'),
	tag: optional(c, 'tag'),
});
const limit = (c: Ctx) => Number(param(c, 'limit') ?? Infinity);
const readJson = (c: Ctx) => c.request.json().catch(() => null);
const readBody = (c: Ctx) => c.request.json().catch(() => ({}));

/** A write verb: 403 on a read-only instance, and a WriteError answers with its own status. */
function write(fallback: string, run: (c: Ctx) => Promise<Response>): (c: Ctx) => Promise<Response> {
	return async (c) => {
		if (!EDITABLE) return fail('read-only wiki instance (set WIKI_EDITABLE=true)', 403);
		try {
			return await run(c);
		} catch (error) {
			if (error instanceof WriteError) return fail(error.message, error.status);
			return fail(message(error, fallback), 400);
		}
	};
}

/** A store write: 503 when the metadata DB is unavailable, because a write that can't persist must fail loudly. */
function stored(run: (c: Ctx) => Promise<Response>): (c: Ctx) => Promise<Response> {
	return async (c) => {
		const status = store.storeStatus();
		if (!status.ok) return fail('metadata store unavailable', 503, { detail: status.error });
		return run(c);
	};
}

/** A GET that needs `path`, and answers 400 with the error message when the path is invalid. */
function withPath(run: (c: Ctx, path: string) => Promise<Response> | Response): (c: Ctx) => Promise<Response> {
	return async (c) => {
		const path = param(c, 'path');
		if (!path) return fail('Missing path', 400);
		try {
			return await run(c, path);
		} catch (error) {
			return fail(message(error, 'Invalid path'), 400);
		}
	};
}

/** Strip HTML to plain text for `?render=text`. A dumb tag/entity strip, deliberately not a markdown engine. */
function toPlainText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
		.replace(/<\/(p|div|h[1-6]|li|tr|section|figure|pre|table)>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

async function readPageVerb(c: Ctx): Promise<Response> {
	const pagePath = param(c, 'path');
	if (!pagePath) return fail('Missing path', 400);
	try {
		const page = await readPage(pagePath);
		if (!page) return fail('Page not found', 404);
		store.recordView({ path: page.path, viewerKind: 'agent', source: 'wiki-agent-page' });
		const section = param(c, 'section');
		const lines = param(c, 'lines');
		const render = param(c, 'render') === 'text' ? 'text' : 'html';
		let content = page.content;
		let found: boolean | undefined;
		if (section || lines) {
			// A section or a line range past the read cap is still a real one, so slice every stored byte.
			content = (await readRawContent(page.path)) ?? page.content;
		} else if (page.truncated) {
			// Answering with the prefix cost a page its closing section once (crawler-v3/fleet-findings.html).
			return fail(
				`page is ${page.size} bytes and the whole-page read cap is ${PAGE_READ_LIMIT} bytes. ` +
					`Returning it would hand you a silent prefix. Read every byte at /raw/${page.path}, or ` +
					`slice it with ?section=<anchor> or ?lines=<from-to>, which read the whole file.`,
				413,
				{ path: page.path, bytes: page.size, readLimit: PAGE_READ_LIMIT },
			);
		}
		if (section || lines) {
			const slice = section ? sliceSection(content, section) : sliceLines(content, lines!);
			content = slice ?? '';
			found = slice !== null;
		}
		if (render === 'text') content = toPlainText(content);
		const stat = store.statOne(page.path);
		return json({
			...rowFor(page, { views: stat.views, edits: stat.edits }),
			version: store.currentVersion(page.path),
			stats: {
				views: stat.views,
				viewsHuman: stat.viewsHuman,
				viewsAgent: stat.viewsAgent,
				lastViewedAt: stat.lastViewedAt,
			},
			headings: page.headings,
			sections: page.headings,
			backlinks: page.backlinks.map((b) => ({ path: b.path, title: b.title })),
			render,
			...(section ? { section, found } : {}),
			...(lines ? { lines, found } : {}),
			content,
		});
	} catch (error) {
		return fail(message(error, 'Invalid path'), 400);
	}
}

const looksLike = (rows: HeldRow[]) => rows.map((r) => `${r.other} (score ${r.score}, the bar is 0.35)`).join(', ');
const distinctFromLine = (rows: HeldRow[]) =>
	`"distinct_from": {${rows.map((r) => `"${r.other}": "<one sentence on how they differ>"`).join(', ')}}`;

/**
 * The checks a page write passes before it is saved, in order. The prose lint refuses a write that adds errors (old
 * debt stays editable). The secret scan refuses a write that the wiki host's commit would refuse, because commit.mjs
 * runs the same scan (scripts/repo/agent/wiki-secrets.mjs, one betterleaks spawn, a median 163 ms on us-metal02). The
 * duplicate check refuses a write that starts a held pair, because wiki-box-commit.mjs never commits a held page and
 * writers do not read a held note on a 200; a write that only keeps a pair from before saves with the held note.
 * A write the prose lint lets through carries its leftover findings in `lint` (savedLintAnswer).
 */
type Checked = { held: Record<string, unknown>; lint: ReturnType<typeof savedLintAnswer> };

async function checkWrite(
	rawPath: string,
	before: string | null,
	after: string,
): Promise<{ rejected: Response } | Checked> {
	let rel: string;
	try {
		rel = normalizeRequestedPath(rawPath);
	} catch {
		return { held: {}, lint: null }; // commitPage reports the bad path
	}
	let lint: Checked['lint'] = null;
	if (isLintedPath(rel)) {
		const result = ratchet(before, after, { path: rel });
		lint = savedLintAnswer(result.findings);
		if (!result.ok) {
			const grown = Object.entries(result.grown).map(([rule, g]) => `${rule} ${g.before} -> ${g.after}`);
			return {
				rejected: fail(
					`prose lint: this write adds errors (${grown.join(', ')}). Fix each finding below and write again. ` +
						`The standard is ${STANDARD_FILE}; run node apps/wiki/scripts/prose-lint.mjs <file> to check a draft.`,
					422,
					{
						standard: STANDARD_FILE,
						grown: result.grown,
						findings: result.newFindings.map((f) => ({
							line: f.line,
							rule: f.rule,
							unslop: f.unslop,
							excerpt: f.excerpt,
							fix: f.fix,
						})),
					},
				),
			};
		}
	}
	const secrets = await secretFindings(rel, after);
	if (secrets.length) {
		return {
			rejected: fail(
				`secret scan: this write holds ${secrets.length} secret finding(s) ` +
					`(${secrets.map((f) => `line ${f.line} ${f.rule}`).join(', ')}), and the wiki host never commits a page ` +
					`that holds one. Mask each value, for example by piping the draft through node scripts/redact.mjs, ` +
					`and write again.`,
				422,
				{ findings: secrets.map((f) => ({ line: f.line, rule: f.rule })) },
			),
		};
	}
	let rows: { added: HeldRow[]; kept: HeldRow[] };
	try {
		rows = heldByWrite(getContentRoot(), rel, after);
	} catch (error) {
		console.error(`page API: the duplicate check of ${rel} could not run: ${error}`);
		return { held: {}, lint };
	}
	if (rows.added.length) {
		return {
			rejected: fail(
				`dup gate: refusing ${rel}, because the wiki host would never commit it while it looks like ` +
					`${looksLike(rows.added)}. Add ${distinctFromLine(rows.added)} to its meta block, or merge the pages ` +
					`with POST /api/agent/supersede, and write again.`,
				422,
				{ heldBy: rows.added.map((r) => r.other) },
			),
		};
	}
	if (!rows.kept.length) return { held: {}, lint };
	return {
		lint,
		held: {
			held:
				`The page is saved, but the wiki host still will not commit it to git while it looks like ${looksLike(rows.kept)}. ` +
				`Add ${distinctFromLine(rows.kept)} to its meta block, or merge the pages with POST /api/agent/supersede, and write it again.`,
			heldBy: rows.kept.map((r) => r.other),
		},
	};
}

/** The page API's answer to a saved write: commitPage's result, the held note, and the lint findings the write kept. */
function writeAnswer(result: { warnings?: string[] } & Record<string, unknown>, checked: Checked): Record<string, unknown> {
	const warnings = [...(result.warnings ?? []), ...(checked.lint ? [checked.lint.warning] : [])];
	return {
		...result,
		revisionLogged: store.storeStatus().ok,
		...checked.held,
		...(checked.lint ? { lint: checked.lint.lint } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

async function secretFindings(rel: string, content: string): Promise<{ line: number; rule: string }[]> {
	try {
		return scanWikiFiles([{ path: rel, bytes: Buffer.from(content) }]).findings;
	} catch (error) {
		console.error(`page API: the secret scan of ${rel} could not run: ${error}`);
		return [];
	}
}

async function uploadAsset(c: Ctx): Promise<Response> {
	if (!EDITABLE) return fail('read-only wiki instance (set WIKI_EDITABLE=true)', 403);
	let form: FormData;
	try {
		form = await c.request.formData();
	} catch {
		return fail('multipart/form-data required with fields "path" + "file"', 400);
	}
	const rawPath = form.get('path');
	const file = form.get('file');
	if (typeof rawPath !== 'string' || !(file instanceof File))
		return fail('fields required: "path" (string) + "file" (file)', 400);
	let rel: string;
	try {
		rel = normalizeRequestedPath(rawPath);
	} catch {
		return fail('invalid path', 400);
	}
	try {
		assertContentRelative(rel);
		if (rel.startsWith('@code/')) return fail('@code/ is read-only', 403);
		if (rel.startsWith('archive/')) return fail('archive/ is frozen — no new assets', 403);
		// Session folders take assets only while the session is open, frozen after close.
		if (isSessionPath(rel)) await assertSessionWorkspaceWritable(rel);
	} catch (error) {
		if (error instanceof WriteError) return fail(error.message, error.status);
		throw error;
	}
	if (PAGE_EXTENSIONS.test(rel)) return fail('a page (.html, .md) is written with POST /api/agent/page', 400);
	const { root, relative } = rootOf(rel);
	const full = path.resolve(root, relative);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) return fail('path escapes content root', 400);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, Buffer.from(await file.arrayBuffer()));
	return json({ path: rel, bytes: file.size, rawUrl: `${base}/raw/${rel}` }, { status: 201 });
}

/** Machine layers of the verification gate: L1 schema, L2 links, L3 render. L4 and L5 are a review pass the agent runs. */
async function verify(pagePath: string | null): Promise<Response> {
	if (!pagePath) return fail('Missing path', 400);
	const page = await readPage(pagePath);
	if (!page) return fail('Page not found', 404);
	const index = await getWikiIndex();
	const broken = page.links.filter((link) => !index.byPath.has(link));
	const inbound = page.backlinks.length;
	let rendered = false;
	let htmlLen = 0;
	let renderError: string | null = null;
	try {
		htmlLen = (await renderWikiPage(page.content, page)).html.length;
		rendered = true;
	} catch (error) {
		renderError = error instanceof Error ? error.message : String(error);
	}
	const checks = {
		L1_schema: {
			ok: Boolean(page.title) && Boolean(page.meta.kind) && Boolean(page.meta.date),
			title: page.title,
			kind: page.meta.kind ?? null,
			date: page.meta.date ?? null,
		},
		L2_links: { ok: broken.length === 0 && inbound > 0, broken, inbound },
		L3_render: { ok: rendered && htmlLen > 0, htmlLen, error: renderError },
	};
	return json({ path: page.path, pass: checks.L1_schema.ok && checks.L2_links.ok && checks.L3_render.ok, checks });
}

function optionalString(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

async function recordSkillRead(c: Ctx): Promise<Response> {
	if (!dev) return fail('skill activity ingestion is local-only', 403);
	const body = await readJson(c);
	if (!body || typeof body.path !== 'string' || !store.SKILL_VIEW_PATH.test(body.path))
		return fail('Body needs an @code skill path', 400);
	const { eventId, source } = body;
	if (
		typeof eventId !== 'string' ||
		!eventId.length ||
		eventId.length > 512 ||
		typeof source !== 'string' ||
		!source.length ||
		source.length > 128 ||
		body.viewerKind !== 'agent'
	)
		return fail('Body needs eventId, source, and viewerKind="agent"', 400);
	const agentId = optionalString(body.agentId);
	const sessionId = optionalString(body.sessionId);
	if (agentId === undefined || sessionId === undefined) return fail('agentId/sessionId must be strings or null', 400);
	const page = await readPage(body.path);
	if (!page) return fail('Skill not found', 404);
	const result = store.recordView({ path: page.path, viewerKind: 'agent', agentId, sessionId, source, eventId });
	if (result === 'unavailable')
		return fail(store.storeStatus().error ?? 'view store unavailable', 503, { coverage: COVERAGE });
	return json({ path: page.path, result, stats: store.statOne(page.path), coverage: COVERAGE });
}

/**
 * POST /api/agent/sessions/{id}/events and /close. {id} is the session folder, with or without its sessions/ prefix, or
 * a job folder `agents/<agent>/jobs/...`.
 */
const sessionVerb = write('session write failed', async (c) => {
	const rest = c.verb.slice('sessions/'.length).replace(/^sessions\//, '');
	const body = await readJson(c);
	if (!body) return fail('JSON body required', 400);
	const id = (folder: string) => (folder.startsWith('agents/') ? folder : `sessions/${folder}`);
	if (rest.endsWith('/events'))
		return json(await appendEvent(id(rest.slice(0, -'/events'.length)), body), { status: 201 });
	if (rest.endsWith('/close')) return json(await closeSession(id(rest.slice(0, -'/close'.length)), body));
	return fail('unknown session verb — use …/events or …/close', 404);
});

/**
 * One report takes 53 to 83 s of git reads on the dev server's one thread. On 2026-10-24 GET / on us-metal02 took up to
 * 2.8 s with 3 reports at once and 4.8 s with 6 (devbox-wiki-public-down), so callers share one report per app filter.
 */
const staleReport = sharedRuns(async (app) => {
	const code = codeRepoDir();
	if (!code) throw new Error('no code repo is configured (codeRepo in the wiki config), so no stale report');
	return getStaleReport(code, app || null);
});

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const q = (name: string, description: string, required = false, type = 'string') => ({
	name,
	in: 'query',
	required,
	schema: { type },
	description,
});
const authorityParams = [
	{
		name: 'includeSessions',
		in: 'query',
		schema: { type: 'boolean' },
		description: 'Include session logs (excluded by default)',
	},
	{
		name: 'includeArchive',
		in: 'query',
		schema: { type: 'boolean' },
		description: 'Include archived pages (excluded by default)',
	},
];
const facetParams = ['app', 'project', 'kind', 'tag', 'status'].map((name) => q(name, 'facet'));
const idParam = { name: 'id', in: 'path', required: true, schema: str };
const body = (required: string[], properties: Record<string, unknown>, type = 'application/json') => ({
	content: { [type]: { schema: { type: 'object', required, properties } } },
});
const doc = (summary: string, extra: Record<string, unknown> = {}) => ({ summary, ...extra });

const API = {
	search: {
		GET: {
			doc: doc('Ranked search + facets', {
				parameters: [
					q('q', 'query terms', true),
					...facetParams,
					q('limit', 'max rows', false, 'integer'),
					...authorityParams,
				],
			}),
			run: async (c) => {
				const query = param(c, 'q') ?? '';
				const ranked = await searchPages(query, undefined, authorityOptsFrom(c.url));
				const filtered = ranked.filter((p) => facetMatch(p, facets(c))).slice(0, limit(c));
				return json({ query, count: filtered.length, results: rowsFor(filtered) });
			},
		},
	},
	grep: {
		GET: {
			doc: doc('Content regex across pages (matching lines + context)', {
				parameters: [
					q('pattern', 'regex', true),
					q('flags', 'only i is effective'),
					q('glob', 'path glob'),
					q('context', 'context lines, default 2', false, 'integer'),
					q('max', 'max matches, default all', false, 'integer'),
					...authorityParams,
				],
			}),
			run: async (c) => {
				const pattern = param(c, 'pattern');
				if (!pattern) return fail('Missing pattern', 400);
				const has = (name: string) => c.url.searchParams.has(name);
				try {
					const results = await grep(pattern, {
						flags: param(c, 'flags') ?? '',
						glob: optional(c, 'glob'),
						context: has('context') ? Number(param(c, 'context')) : undefined,
						max: has('max') ? Number(param(c, 'max')) : undefined,
						...authorityOptsFrom(c.url),
					});
					return json({ pattern, count: results.length, results });
				} catch (error) {
					return fail(message(error, 'grep failed'), 400);
				}
			},
		},
	},
	find: {
		GET: {
			doc: doc('Locate pages by path glob (no content scan)', {
				parameters: [
					q('glob', 'path glob, ** any depth'),
					...facetParams,
					q('limit', 'max rows', false, 'integer'),
					...authorityParams,
				],
			}),
			run: async (c) => {
				const glob = param(c, 'glob');
				const results = await find(glob, facets(c), limit(c), authorityOptsFrom(c.url));
				return json({ glob, count: results.length, results });
			},
		},
	},
	tree: {
		GET: {
			doc: doc('Generated folder tree (ls) — replaces SITEMAP files', {
				parameters: [q('path', 'subtree root'), q('depth', 'default 3', false, 'integer')],
			}),
			// Folders at the depth limit come back with empty `children` and their `childCount`.
			run: async (c) => {
				const base = (param(c, 'path') ?? '').replace(/^\/+|\/+$/g, '');
				const depth = Number(param(c, 'depth') ?? 3);
				const tree = await getSubtree(base, depth);
				if (!tree) return fail(`no folder "${base}"`, 404);
				return json({ path: base, depth, tree });
			},
		},
	},
	page: {
		GET: {
			doc: doc(
				'Page object: metadata row + version + stats (views split human/agent) + headings + backlinks + content',
				{
					parameters: [
						q('path', 'page or folder path', true),
						q('section', 'one section by anchor'),
						q('lines', 'line range e.g. 10-40'),
						q('render', '"text" for tag-stripped plain text'),
					],
				},
			),
			run: readPageVerb,
		},
		PATCH: {
			doc: doc(
				'str_replace diff edits; an edit that leaves the page as it was answers changed: false with the current version and logs no revision — 422 ambiguous or meta title apart from the first <h1>, 409 stale baseVersion, a retired status while a current hub links the page, or a new hub link to a retired page; logs a revision with summary + lines/bytes changed',
				{
					requestBody: body(['path', 'edits'], {
						path: str,
						edits: {
							type: 'array',
							items: {
								type: 'object',
								required: ['old_string', 'new_string'],
								properties: { old_string: str, new_string: str, replace_all: { type: 'boolean' } },
							},
						},
						author: str,
						summary: str,
						baseVersion: { type: 'integer' },
					}),
				},
			),
			run: write('patch failed', async (c) => {
				const b = await readJson(c);
				if (!b || typeof b.path !== 'string' || !Array.isArray(b.edits))
					return fail('Body needs string "path" + "edits" array of {old_string,new_string}', 400);
				// The lock holds the read the edits apply to, so an edit lands on the page as the write before it left it.
				return withPageLock(b.path, async () => {
					const before = await readForEdit(b.path);
					if (before === null) return fail('page not found — PATCH edits an existing page; POST to create', 404);
					const { content, applied } = applyEdits(before, b.edits as Edit[]);
					const checked = await checkWrite(b.path, before, content);
					if ('rejected' in checked) return checked.rejected;
					// PATCH builds on a full disk read, so a shorter result is a real edit, never a read-cap truncation.
					const result = await commitPage({
						rawPath: b.path,
						content,
						author: b.author,
						summary: b.summary,
						baseVersion: b.baseVersion,
						allowTruncate: true,
					});
					return json({ ...writeAnswer(result, checked), applied });
				});
			}),
		},
		POST: {
			doc: doc(
				'Create/replace a page with full content (201, or 200 with changed: false when the content equals the stored page); a saved write lists the prose-lint findings it kept in lint and warnings; same guards + revision log; 409 when the content is an edit of an older committed copy and sends no baseVersion',
				{
					requestBody: body(['path', 'content'], {
						path: str,
						content: str,
						author: str,
						summary: str,
						baseVersion: { type: 'integer' },
					}),
				},
			),
			run: write('write failed', async (c) => {
				const b = await readJson(c);
				if (!b || typeof b.path !== 'string' || typeof b.content !== 'string')
					return fail('Body needs string "path" + "content"', 400);
				return withPageLock(b.path, async () => {
					const checked = await checkWrite(b.path, await readForEdit(b.path), b.content);
					if ('rejected' in checked) return checked.rejected;
					const result = await commitPage({
						rawPath: b.path,
						content: b.content,
						author: b.author,
						summary: b.summary,
						baseVersion: b.baseVersion,
						allowTruncate: b.allowTruncate === true,
						refuseStaleCopy: true,
					});
					// An identical write saves nothing, so it answers 200 with changed: false and the current version.
					return json(writeAnswer(result, checked), { status: result.changed ? 201 : 200 });
				});
			}),
		},
	},
	backlinks: {
		GET: {
			doc: doc('Inbound links to a page (folder paths resolve)', { parameters: [q('path', 'page path', true)] }),
			run: withPath(async (_c, path) => json({ path, backlinks: await getBacklinks(path) })),
		},
	},
	graph: {
		GET: {
			doc: doc('Link graph (nodes + edges)', { parameters: [...authorityParams] }),
			run: async (c) => json(await getGraph(authorityOptsFrom(c.url))),
		},
	},
	recent: {
		GET: {
			doc: doc('Recently updated pages', {
				parameters: [
					q('category', 'top-level space filter'),
					q('limit', 'max rows', false, 'integer'),
					...authorityParams,
				],
			}),
			run: async (c) => {
				const category = param(c, 'category');
				return json({ category, results: await getRecent(category, limit(c), authorityOptsFrom(c.url)) });
			},
		},
	},
	'context-pack': {
		GET: {
			doc: doc('Budgeted context bundle from top search hits', {
				parameters: [q('q', 'query', true), q('budget', 'chars, default 8000', false, 'integer'), ...authorityParams],
			}),
			run: async (c) => {
				const budget = param(c, 'budget');
				return json(
					await getContextPack(
						param(c, 'q') ?? '',
						budget === null ? undefined : Number(budget),
						authorityOptsFrom(c.url),
					),
				);
			},
		},
	},
	verify: {
		GET: {
			doc: doc('Machine gate L1 schema · L2 links · L3 render (also POST {path})', {
				parameters: [q('path', 'page path', true)],
			}),
			run: (c) => verify(param(c, 'path')),
		},
		POST: {
			run: async (c) => {
				const b = await readBody(c);
				return verify(typeof b.path === 'string' ? b.path : null);
			},
		},
	},
	history: {
		GET: {
			doc: doc('Per-page revision log; @code skill paths project committed edits from Git with rename following', {
				parameters: [q('path', 'page path', true)],
			}),
			run: async (c) => {
				const path = param(c, 'path');
				if (!path) return fail('Missing path', 400);
				if (path.startsWith('@code/')) return json({ path, origin: 'git', ...(await getMirrorHistory(path)) });
				const revisions = store.listRevisions(path);
				return json({
					path,
					origin: 'wiki-revisions',
					available: true,
					count: revisions.length,
					revisions,
					error: null,
				});
			},
		},
	},
	activity: {
		GET: {
			doc: doc('Tracked skill views, attribution, and explicit coverage limits', {
				parameters: [q('path', '@code skill path', true), q('limit', 'recent event rows', false, 'integer')],
			}),
			run: async (c) => {
				const pagePath = param(c, 'path');
				if (!pagePath || !store.SKILL_VIEW_PATH.test(pagePath)) return fail('Missing @code skill path', 400);
				const page = await readPage(pagePath);
				if (!page) return fail('Skill not found', 404);
				return json({
					path: page.path,
					store: store.storeStatus(),
					stats: store.statOne(page.path),
					events: store.listViews(page.path, Number(param(c, 'limit') ?? 50)),
					coverage: COVERAGE,
				});
			},
		},
		POST: {
			doc: doc('Idempotently record a local agent skill-read event', {
				requestBody: body(['path', 'eventId', 'source', 'viewerKind'], {
					path: str,
					eventId: str,
					source: str,
					viewerKind: { type: 'string', const: 'agent' },
					agentId: { type: ['string', 'null'] },
					sessionId: { type: ['string', 'null'] },
				}),
			}),
			run: recordSkillRead,
		},
	},
	diff: {
		GET: {
			doc: doc('Revision diffs — latest, or every diff in (from, to] with aggregate line counts', {
				parameters: [
					q('path', 'page path', true),
					q('from', 'base version', false, 'integer'),
					q('to', 'target version', false, 'integer'),
				],
			}),
			run: async (c) => {
				const pagePath = param(c, 'path');
				if (!pagePath) return fail('Missing path', 400);
				const current = store.currentVersion(pagePath);
				if (current === 0) return fail(`no revisions for ${pagePath}`, 404);
				const ranged = c.url.searchParams.has('from') || c.url.searchParams.has('to');
				const to = c.url.searchParams.has('to') ? Number(param(c, 'to')) : current;
				const from = c.url.searchParams.has('from') ? Number(param(c, 'from')) : to - 1;
				if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > current)
					return fail(`need 0 <= from < to <= ${current}`, 400);
				const revisions = ranged ? store.revisionRange(pagePath, from, to) : store.listRevisions(pagePath).slice(0, 1);
				return json({
					path: pagePath,
					from,
					to,
					current,
					linesAdded: revisions.reduce((n, r) => n + r.linesAdded, 0),
					linesRemoved: revisions.reduce((n, r) => n + r.linesRemoved, 0),
					revisions: revisions.map((r) => ({
						version: r.version,
						author: r.author,
						ts: r.ts,
						summary: r.summary,
						linesAdded: r.linesAdded,
						linesRemoved: r.linesRemoved,
						bytesBefore: r.bytesBefore,
						bytesAfter: r.bytesAfter,
						diff: r.diff,
					})),
				});
			},
		},
	},
	changes: {
		GET: {
			doc: doc('Revisions across the wiki since a timestamp', {
				parameters: [q('since', 'ISO timestamp, default 7d ago'), q('path', 'path prefix filter')],
			}),
			run: (c) => {
				const since = param(c, 'since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
				const prefix = param(c, 'path');
				const changes = store.changesSince(since).filter((r) => !prefix || r.path.startsWith(prefix));
				return json({ since, count: changes.length, changes });
			},
		},
	},
	stale: {
		GET: {
			doc: doc('Pages whose source_refs changed after last_verified', { parameters: [q('app', 'facet')] }),
			run: async (c) => json(await staleReport(param(c, 'app') ?? '')),
		},
	},
	supersede: {
		POST: {
			doc: doc(
				'Set superseded_by on an old page (frontmatter only, revision logged); allowed in closed session folders. 404 missing page or target, 400 self, 403 session log/archive/@code',
				{
					requestBody: body(['path', 'by'], {
						path: { type: 'string', description: 'old page' },
						by: { type: 'string', description: 'new page, content-root or relative to the old page' },
						author: str,
						summary: str,
					}),
				},
			),
			// The one write a closed session folder accepts, so a stale page links to the rewrite in a newer session.
			run: write('supersede failed', async (c) => {
				const b = await readJson(c);
				if (!b || typeof b.path !== 'string' || typeof b.by !== 'string')
					return fail('Body needs string "path" (old page) + "by" (new page)', 400);
				const result = await supersedePage({ rawPath: b.path, by: b.by, author: b.author, summary: b.summary });
				return json({ ...result, revisionLogged: store.storeStatus().ok });
			}),
		},
	},
	sessions: {
		GET: {
			doc: doc('List session logs (sessions/ and agents/<agent>/jobs/)', {
				parameters: [
					q('status', 'open (default) | closed | all'),
					q('agent', 'only logs whose frontmatter agent is this'),
					q('conversation', 'only logs whose frontmatter conversation is this'),
				],
			}),
			// history/ logs are listed by /timeline, not here.
			run: async (c) => {
				const status = param(c, 'status') ?? 'open';
				const agent = param(c, 'agent');
				const conversation = param(c, 'conversation');
				const sessions = (await getWikiIndex()).sessionLogs
					.filter(
						(p) =>
							(status === 'all' || (p.meta.status ?? '') === status) &&
							(!agent || p.meta.agent === agent) &&
							(!conversation || p.meta.conversation === conversation),
					)
					.map((p) => ({
						id: p.path.replace(/\/index\.html$/, ''),
						path: p.path,
						title: p.title,
						status: p.meta.status ?? null,
						goal: p.meta.goal ?? null,
						apps: p.meta.apps,
						agent: p.meta.agent ?? null,
						conversation: p.meta.conversation ?? null,
						parent: p.meta.parent ?? null,
						host: p.meta.host ?? null,
						updated: p.meta.updated ?? p.updated,
					}));
				return json({ status, count: sessions.length, sessions });
			},
		},
		POST: {
			doc: doc('Open a session (201) — the only way to create a sessions/ page', {
				requestBody: body(['slug', 'goal'], {
					slug: str,
					goal: str,
					agent: str,
					conversation: str,
					parent: str,
					host: str,
					root: { type: 'string', description: 'sessions (default) or agents/<agent>/jobs' },
					title: str,
					description: str,
					apps: strs,
					projects: strs,
					domains: strs,
					tags: strs,
				}),
			}),
			run: write('open failed', async (c) => {
				const b = await readJson(c);
				if (!b) return fail('JSON body required: {slug, goal, apps?, tags?, …}', 400);
				return json(await openSession(b), { status: 201 });
			}),
		},
	},
	[SESSION_VERB]: {
		POST: {
			doc: doc('Append an event to an open session (409 if closed)', {
				parameters: [idParam],
				requestBody: body(['summary'], { summary: str, html: str, author: str }),
			}),
			run: sessionVerb,
		},
	},
	'sessions/{id}/close': {
		POST: {
			doc: doc('Close a session — must graduate, open a gap, or state no_durable_knowledge', {
				parameters: [idParam],
				requestBody: body(['outcome'], {
					outcome: str,
					graduated_to: strs,
					gaps_created: strs,
					no_durable_knowledge: { type: 'boolean' },
					author: str,
				}),
			}),
			run: sessionVerb,
		},
	},
	assets: {
		POST: {
			doc: doc('Multipart asset upload (screenshots/diagrams/data) into a page folder → /raw URL', {
				requestBody: body(
					['path', 'file'],
					{ path: str, file: { type: 'string', format: 'binary' } },
					'multipart/form-data',
				),
			}),
			run: uploadAsset,
		},
	},
	gaps: {
		GET: {
			doc: doc('List knowledge gaps', {
				parameters: [q('status', 'open | resolved'), q('app', 'facet'), q('project', 'facet')],
			}),
			run: (c) => {
				const gaps = store.listGaps({
					status: optional(c, 'status'),
					app: optional(c, 'app'),
					project: optional(c, 'project'),
				});
				return json({ count: gaps.length, gaps });
			},
		},
		POST: {
			doc: doc('File a gap'),
			run: stored(async (c) => {
				const b = await readBody(c);
				if (!b.title) return fail('Missing title', 400);
				const gap = store.addGap({
					id: `g_${Math.random().toString(36).slice(2, 10)}`,
					title: String(b.title),
					app: b.app ?? null,
					project: b.project ?? null,
					pagePath: b.path ?? null,
					createdBy: b.createdBy ?? 'agent',
					resolvedRef: null,
				});
				return json(gap, { status: 201 });
			}),
		},
		PATCH: {
			doc: doc('Resolve a gap'),
			run: stored(async (c) => {
				const b = await readBody(c);
				if (!b.id || !b.resolvedRef) return fail('Need id + resolvedRef', 400);
				const ok = store.resolveGap(String(b.id), String(b.resolvedRef));
				return json({ ok }, { status: ok ? 200 : 404 });
			}),
		},
	},
	watches: {
		GET: { doc: doc('List watches'), run: () => json({ watches: store.listWatches() }) },
		POST: {
			doc: doc('Subscribe to app/project/tag/path changes'),
			run: stored(async (c) => {
				const b = await readBody(c);
				if (!b.watcher || !b.scope || !b.value) return fail('Need watcher + scope + value', 400);
				const id = `w_${Math.random().toString(36).slice(2, 10)}`;
				store.addWatch({ id, watcher: String(b.watcher), scope: String(b.scope), value: String(b.value) });
				return json({ id }, { status: 201 });
			}),
		},
	},
	lint: {
		GET: {
			doc: doc(
				'Health: broken links · orphans · stale · untitled + style tiers (missingDescription · underLinked · duplicateCanonical)',
			),
			run: async () => json(await getLintReport()),
		},
	},
	health: {
		GET: {
			doc: doc('Index + metadata-store status'),
			run: async () => json({ ...(await getHealth()), store: store.storeStatus() }),
		},
	},
	manifest: { GET: { doc: doc('Endpoint listing + page count'), run: async () => json(await getManifest()) } },
	/** Machine-local page favorites (SQLite `content/.wiki/favorites`), shared across every browser on this machine. */
	favorites: {
		GET: { run: () => json({ favorites: store.listFavorites() }) },
		POST: {
			run: stored(async (c) => {
				const b = await readBody(c);
				const raw = typeof b.path === 'string' ? b.path.trim() : '';
				if (raw === '') return fail('Need path', 400);
				// The canonical page path, so a folder URL and its index page favorite the same row.
				const page = await readPage(raw);
				if (!page) return fail('Unknown page', 404, { path: raw });
				store.addFavorite(page.path);
				return json({ path: page.path, favorites: store.listFavorites() }, { status: 201 });
			}),
		},
		DELETE: {
			run: stored(async (c) => {
				const b = await readBody(c);
				const raw = typeof b.path === 'string' ? b.path.trim() : '';
				if (raw === '') return fail('Need path', 400);
				// The raw path is the fallback, so a favorite whose page is gone can still be pruned.
				const target = (await readPage(raw))?.path ?? raw;
				const removed = store.removeFavorite(target);
				return json({ removed, path: target, favorites: store.listFavorites() });
			}),
		},
	},
	'skill-metrics': {
		GET: {
			run: async (c) => {
				if (!SKILL_METRICS_ENABLED) return fail('skill metrics are local-dev only (WIKI_EDITABLE)', 403);
				const days = Number(param(c, 'days') ?? 30);
				try {
					return json(await loadSkillMetrics(Number.isFinite(days) && days > 0 ? days : 30));
				} catch (error) {
					return fail(
						`skill metrics failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 800)}`,
						500,
					);
				}
			},
		},
	},
	openapi: { GET: { run: () => json(openApiDocument()) } },
} satisfies Record<AgentVerb | typeof SESSION_VERB | 'sessions/{id}/close', Verb>;

/** The wiki's own API spec (OpenAPI 3.1), built from the table. */
function openApiDocument(): Record<string, unknown> {
	return {
		openapi: '3.1.0',
		info: {
			title: 'llm-wiki agent API',
			version: '2026-07-20',
			description:
				'Terminal-grade wiki access: search/grep/find/tree discovery, page object reads (section/line granular), str_replace diff writes with a revision log (summary + lines/bytes changed), verification gate, sessions (append-only work stream), gaps, watches, freshness. Result rows always carry description/kind/status/created/updated/last_verified/views/edits.',
		},
		paths: Object.fromEntries(
			Object.entries(API as Record<string, Verb>).flatMap(([verb, ops]) => {
				const documented = Object.entries(ops).filter(([, op]) => op.doc);
				return documented.length
					? [
							[
								`/api/agent/${verb}`,
								Object.fromEntries(documented.map(([method, op]) => [method.toLowerCase(), op.doc])),
							],
						]
					: [];
			}),
		),
	};
}

/** Answer one call. A method the verb lacks gets the 405 SvelteKit gives an endpoint that does not export it. */
export async function serveAgent(method: Method, verb: string, url: URL, request: Request): Promise<Response> {
	const ops: Verb = (API as Record<string, Verb>)[verb] ?? API[SESSION_VERB];
	const op = ops[method];
	if (op) return op.run({ url, request, verb });
	const allowed: string[] = ENDPOINT_METHODS.filter((m) => m in ops);
	if ('GET' in ops) allowed.push('HEAD');
	return text(`${method} method not allowed`, { status: 405, headers: { allow: allowed.join(', ') } });
}
