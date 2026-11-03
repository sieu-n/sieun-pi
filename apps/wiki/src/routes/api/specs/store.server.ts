// Server side of the /specs page: reads through apps/specs/lib/specs.mjs, writes one spec file, guards local-only routes.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestEvent } from '@sveltejs/kit';
import * as lib from '$lib/specs/specs.mjs';
import type { Criterion, Folder, Row, Spec, SpecPatch, SpecsPage } from '$lib/components/specs/types';

const run = promisify(execFile);
export const REPO: string = lib.REPO;
/** The specs folder as a path in REPO, such as apps/specs. */
export const SPECS_IN_REPO: string = relative(REPO, lib.SPECS_DIR).split('\\').join('/');
export const SPEC_ID = /^SPEC-[A-Za-z0-9]{1,12}$/;
/** The page's identity in the agent write journal: the same record .claude/hooks/record-file-write.mjs keeps for Claude writes. */
const JOURNAL_SESSION = 'specs-page';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

type ParsedCriterion = {
	index: number;
	env: Criterion['env'];
	text: string;
	check: string;
	params: Record<string, string | number>;
	hash: string;
};
type Parsed = {
	id: string;
	title: string;
	status: 'draft' | 'approved';
	every: Spec['every'];
	journey: string;
	notes: string;
	file: string;
	path: string;
	folder: string;
	criteria: ParsedCriterion[];
	cost: string;
	prodWrites: boolean;
};
type RowStore = {
	days: string[];
	rows: Row[];
	latest: (spec: string, hash: string, env: string, day: string) => Row | null;
	latestFor: (spec: string, hash: string, env: string) => Row | null;
};

export function localAccess(event: Pick<RequestEvent, 'url' | 'request'>): boolean {
	return dev && LOOPBACK.has(event.url.hostname) && event.request.headers.get('host') === event.url.host;
}

/** Play, edit and approve run shell commands and write files: loopback dev server, same origin, nothing else. */
export function requireLocal(event: Pick<RequestEvent, 'url' | 'request'>): void {
	if (!localAccess(event)) error(403, 'Editing and running specs needs the local dev server.');
	if (event.request.headers.get('sec-fetch-site') === 'cross-site') error(403, 'Same-origin request required.');
	const origin = event.request.headers.get('origin');
	if (origin && origin !== event.url.origin) error(403, 'Same-origin request required.');
}

export async function jsonBody(event: RequestEvent): Promise<Record<string, unknown>> {
	requireLocal(event);
	const text = await event.request.text();
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== 'object' || Array.isArray(value)) error(400, 'JSON object required.');
		return value as Record<string, unknown>;
	} catch (failure) {
		if (failure && typeof failure === 'object' && 'status' in failure) throw failure;
		error(400, 'JSON object required.');
	}
}

function loadAll(): { specs: Parsed[]; problems: string[] } {
	const problems: string[] = [];
	let specs: Parsed[] = [];
	try {
		specs = lib.loadSpecs() as Parsed[];
	} catch (failure) {
		problems.push(failure instanceof Error ? failure.message : String(failure));
	}
	const seen = new Map<string, string>();
	for (const spec of specs) {
		const first = seen.get(spec.id);
		if (first) problems.push(`${spec.file}: id ${spec.id} is also used by ${first}`);
		else seen.set(spec.id, spec.file);
	}
	return { specs, problems };
}

export function pageData(local: boolean): SpecsPage {
	const { specs, problems } = loadAll();
	const store = lib.loadRows({ days: 14 }) as RowStore;
	const folders = new Map<string, Spec[]>();
	for (const parsed of specs) {
		const spec: Spec = {
			id: parsed.id,
			title: parsed.title,
			status: parsed.status,
			every: parsed.every,
			journey: parsed.journey,
			notes: parsed.notes,
			file: parsed.file,
			folder: parsed.folder === '.' ? '' : parsed.folder,
			criteria: parsed.criteria.map((c) => ({
				index: c.index,
				env: c.env,
				text: c.text,
				check: c.check,
				params: c.params,
				hash: c.hash,
				cells: store.days.map((day) => store.latest(parsed.id, c.hash, c.env, day)?.pass ?? null),
				latest: store.latestFor(parsed.id, c.hash, c.env),
			})),
		};
		folders.set(spec.folder, [...(folders.get(spec.folder) ?? []), spec]);
	}
	const list: Folder[] = [...folders.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, items]) => ({ path, specs: items.sort((a, b) => specNumber(a.id) - specNumber(b.id)) }));
	return { local, days: store.days, folders: list, problems };
}

const specNumber = (id: string) => Number(id.replace(/\D/g, '')) || 0;

export function findSpec(id: string): Parsed {
	const spec = (lib.loadSpecs() as Parsed[]).find((s) => s.id === id);
	if (!spec) error(404, `${id} is not a spec.`);
	return spec;
}

/** Rewrites one spec file through formatSpec with the patch applied. Returns the file text written. */
export function writeSpec(id: string, patch: SpecPatch): Parsed {
	const spec = findSpec(id);
	if (patch.title !== undefined) spec.title = oneLine(patch.title, 'title');
	if (patch.journey !== undefined) spec.journey = oneLine(patch.journey, 'journey');
	if (patch.notes !== undefined) {
		const lines = patch.notes
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length > 3) error(400, 'Notes are at most 3 lines.');
		spec.notes = lines.join('\n');
	}
	for (const change of patch.criteria ?? []) {
		const target = spec.criteria[change.index];
		if (!target) error(400, `Criterion ${change.index} does not exist.`);
		target.text = oneLine(change.text, 'criterion');
	}
	if (patch.status) spec.status = patch.status;
	if (!spec.title) error(400, 'A spec needs a title.');
	const text = lib.formatSpec(spec);
	const check = lib.parseSpec(text, spec.path);
	if (!check || check.criteria.length !== spec.criteria.length) error(400, 'The edited text does not parse as a spec.');
	writeFileSync(spec.path, text);
	journalWrite(`${SPECS_IN_REPO}/${spec.file}`);
	return lib.parseSpec(readFileSync(spec.path, 'utf8'), spec.path) as Parsed;
}

/** Records the write under the page's own identity so commit.mjs can attribute the file. A lost record only degrades attribution. */
function journalWrite(rel: string): void {
	try {
		const dir = join(
			process.env.AGENT_WRITES_ROOT ?? join(REPO, '.cache', 'agent-writes'),
			new Date().toISOString().slice(0, 10),
		);
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, `${JOURNAL_SESSION}.jsonl`),
			JSON.stringify({
				session_id: JOURNAL_SESSION,
				path: rel,
				tool: 'specs-page',
				ts: Date.now(),
				tool_use_id: null,
			}) + '\n',
		);
	} catch (failure) {
		console.error(`[specs] journal write failed: ${failure instanceof Error ? failure.message : String(failure)}`);
	}
}

function oneLine(value: string, name: string): string {
	const text = value.replace(/\s+/g, ' ').trim();
	if (/^(Journey|Notes?):/i.test(text) && name !== 'title')
		error(400, `Write the ${name} without the "${name}:" label.`);
	if (name === 'criterion' && !text) error(400, 'A criterion cannot be empty.');
	return text;
}

/** The repo's only way to write git history. A refusal comes back as the tool's own words. */
export async function commitSpec(spec: Parsed, message: string): Promise<{ ok: boolean; output: string }> {
	try {
		const { stdout, stderr } = await run(
			'node',
			[
				'scripts/repo/agent/commit.mjs',
				'-m',
				message,
				'--session',
				JOURNAL_SESSION,
				`${SPECS_IN_REPO}/${spec.file}`,
			],
			{
				cwd: REPO,
				maxBuffer: Infinity,
			},
		);
		return { ok: true, output: `${stdout}${stderr}`.trim() };
	} catch (failure) {
		const f = failure as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, output: `${f.stdout ?? ''}${f.stderr ?? ''}`.trim() || f.message || 'commit.mjs failed' };
	}
}
