/**
 * Wiki metadata (views, revisions, gaps, watches, favorites) in `content/.wiki/wiki.db` via `node:sqlite`; files stay
 * the source of truth for content. It degrades to a no-op when the DB cannot open, such as Vercel's read-only FS.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getContentRoot } from './wiki';

/** Mirror paths whose agent views count as skill reads; the activity endpoint and the read-skill helper's tests share it. */
export const SKILL_VIEW_PATH = /^@code\/(?:\.agents\/skills|\.claude\/skills-native)\/.+\.md$/;

export type Revision = {
	path: string;
	version: number;
	author: string;
	ts: string;
	summary: string;
	baseVersion: number | null;
	contentHash: string;
	diff: string;
	linesAdded: number;
	linesRemoved: number;
	bytesBefore: number;
	bytesAfter: number;
};
export type Gap = {
	id: string;
	title: string;
	app: string | null;
	project: string | null;
	pagePath: string | null;
	status: 'open' | 'resolved';
	createdBy: string;
	ts: string;
	resolvedRef: string | null;
};
export type PageStat = {
	path: string;
	views: number;
	viewsHuman: number;
	viewsAgent: number;
	lastViewedAt: string | null;
	edits: number;
};
export type ViewEvent = {
	path: string;
	viewerKind: 'human' | 'agent';
	agentId: string | null;
	sessionId: string | null;
	source: string | null;
	eventId: string | null;
	ts: string;
};
export type RecordViewResult = 'recorded' | 'duplicate' | 'unavailable';

let db: DatabaseSync | null = null;
let tried = false;
let initError: string | null = null;

/** Whether the metadata DB opened, and why not. Surfaced by /api/agent/health so a real failure isn't mistaken for "no data". */
export function storeStatus(): { ok: boolean; error: string | null } {
	getDb();
	return { ok: db !== null, error: initError };
}

function getDb(): DatabaseSync | null {
	if (tried) return db;
	tried = true;
	try {
		const dir = path.join(getContentRoot(), '.wiki');
		mkdirSync(dir, { recursive: true });
		const handle = new DatabaseSync(path.join(dir, 'wiki.db'));
		handle.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS views (
				path TEXT NOT NULL, viewer_kind TEXT NOT NULL, agent_id TEXT, session_id TEXT,
				source TEXT, event_id TEXT, ts TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS views_path ON views(path);
			CREATE TABLE IF NOT EXISTS page_stats (path TEXT PRIMARY KEY, total_views INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT);
			CREATE TABLE IF NOT EXISTS revisions (
				path TEXT NOT NULL, version INTEGER NOT NULL, author TEXT NOT NULL, ts TEXT NOT NULL,
				summary TEXT NOT NULL DEFAULT '', base_version INTEGER, content_hash TEXT NOT NULL DEFAULT '', diff TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (path, version)
			);
			CREATE INDEX IF NOT EXISTS revisions_ts ON revisions(ts);
			CREATE TABLE IF NOT EXISTS gaps (
				id TEXT PRIMARY KEY, title TEXT NOT NULL, app TEXT, project TEXT, page_path TEXT,
				status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL DEFAULT 'agent', ts TEXT NOT NULL, resolved_ref TEXT
			);
			CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, watcher TEXT NOT NULL, scope TEXT NOT NULL, value TEXT NOT NULL, since TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS favorites (path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
		`);
		// Additive migration for DBs created before these columns.
		for (const col of ['lines_added', 'lines_removed', 'bytes_before', 'bytes_after']) {
			ensureColumn(handle, 'revisions', col, 'INTEGER NOT NULL DEFAULT 0');
		}
		ensureColumn(handle, 'views', 'session_id', 'TEXT');
		ensureColumn(handle, 'views', 'source', 'TEXT');
		ensureColumn(handle, 'views', 'event_id', 'TEXT');
		handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS views_event_id ON views(event_id) WHERE event_id IS NOT NULL');
		db = handle;
	} catch (error) {
		// Degrade so content reads still work — but never silently: a read-only FS (Vercel) is the
		// only *expected* cause; anything else is a real failure and is logged loudly + reported by /health.
		db = null;
		const code = (error as { code?: string }).code ?? '';
		initError = `${code || 'open failed'}: ${error instanceof Error ? error.message : String(error)}`;
		const expectedReadOnly = ['EROFS', 'EACCES', 'EPERM'].includes(code);
		console[expectedReadOnly ? 'warn' : 'error'](
			`[wiki-store] metadata DB unavailable (${expectedReadOnly ? 'expected: read-only FS' : 'UNEXPECTED'}) — views/edits/gaps disabled: ${initError}`,
		);
	}
	return db;
}

const now = (): string => new Date().toISOString();

/** Add a column iff it doesn't exist (PRAGMA-checked — no error swallowing). */
function ensureColumn(handle: DatabaseSync, table: string, column: string, type: string): void {
	const cols = handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
	if (cols.some((c) => c.name === column)) return;
	handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** The three statement shapes. Each answers the empty value when the DB is unavailable. */
const all = <T>(sql: string, ...args: SQLInputValue[]): T[] =>
	(
		getDb()
			?.prepare(sql)
			.all(...args) ?? []
	).map((row) => ({ ...row }) as T);
const get = <T>(sql: string, ...args: SQLInputValue[]): T | undefined =>
	getDb()
		?.prepare(sql)
		.get(...args) as T | undefined;
const run = (sql: string, ...args: SQLInputValue[]): number =>
	Number(
		getDb()
			?.prepare(sql)
			.run(...args).changes ?? 0,
	);

// SQL aliases give each row the field names and order of its type.
const REVISION_COLUMNS =
	'path, version, author, ts, summary, base_version AS baseVersion, content_hash AS contentHash, diff, lines_added AS linesAdded, lines_removed AS linesRemoved, bytes_before AS bytesBefore, bytes_after AS bytesAfter';
const GAP_COLUMNS =
	'id, title, app, project, page_path AS pagePath, status, created_by AS createdBy, ts, resolved_ref AS resolvedRef';

export function recordView(input: {
	path: string;
	viewerKind?: 'human' | 'agent';
	agentId?: string | null;
	sessionId?: string | null;
	source?: string | null;
	eventId?: string | null;
}): RecordViewResult {
	const handle = getDb();
	if (!handle) return 'unavailable';
	const ts = now();
	handle.exec('BEGIN IMMEDIATE');
	try {
		const inserted = run(
			'INSERT OR IGNORE INTO views (path, viewer_kind, agent_id, session_id, source, event_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
			input.path,
			input.viewerKind ?? 'agent',
			input.agentId ?? null,
			input.sessionId ?? null,
			input.source ?? null,
			input.eventId ?? null,
			ts,
		);
		if (inserted > 0)
			run(
				`INSERT INTO page_stats (path, total_views, last_viewed_at) VALUES (?, 1, ?)
				 ON CONFLICT(path) DO UPDATE SET total_views = total_views + 1, last_viewed_at = excluded.last_viewed_at`,
				input.path,
				ts,
			);
		handle.exec('COMMIT');
		return inserted > 0 ? 'recorded' : 'duplicate';
	} catch (error) {
		handle.exec('ROLLBACK');
		throw error;
	}
}

export function listViews(pagePath: string, limit?: number): ViewEvent[] {
	// SQLite reads a negative LIMIT as no limit
	return all(
		'SELECT path, viewer_kind AS viewerKind, agent_id AS agentId, session_id AS sessionId, source, event_id AS eventId, ts FROM views WHERE path = ? ORDER BY ts DESC LIMIT ?',
		pagePath,
		limit === undefined ? -1 : Math.floor(limit),
	);
}

/** Per-page {views, lastViewedAt, edits} for a set of paths. Empty when the metadata DB is unavailable. */
export function statsFor(paths: string[]): Map<string, PageStat> {
	const out = new Map<string, PageStat>();
	if (!getDb()) return out;
	for (const p of paths) {
		const s = get<{ total_views: number; last_viewed_at: string | null }>(
			'SELECT total_views, last_viewed_at FROM page_stats WHERE path = ?',
			p,
		);
		const kinds = all<{ viewer_kind: string; n: number }>(
			'SELECT viewer_kind, COUNT(*) AS n FROM views WHERE path = ? GROUP BY viewer_kind',
			p,
		);
		out.set(p, {
			path: p,
			views: s?.total_views ?? 0,
			viewsHuman: kinds.find((k) => k.viewer_kind === 'human')?.n ?? 0,
			viewsAgent: kinds.find((k) => k.viewer_kind === 'agent')?.n ?? 0,
			lastViewedAt: s?.last_viewed_at ?? null,
			edits: get<{ n: number }>('SELECT COUNT(*) AS n FROM revisions WHERE path = ?', p)?.n ?? 0,
		});
	}
	return out;
}

export function statOne(pagePath: string): PageStat {
	return (
		statsFor([pagePath]).get(pagePath) ?? {
			path: pagePath,
			views: 0,
			viewsHuman: 0,
			viewsAgent: 0,
			lastViewedAt: null,
			edits: 0,
		}
	);
}

export function addRevision(input: Omit<Revision, 'version' | 'ts'> & { ts?: string }): number {
	if (!getDb()) return 0;
	const version = currentVersion(input.path) + 1;
	run(
		`INSERT INTO revisions (path, version, author, ts, summary, base_version, content_hash, diff, lines_added, lines_removed, bytes_before, bytes_after)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		input.path,
		version,
		input.author,
		input.ts ?? now(),
		input.summary,
		input.baseVersion,
		input.contentHash,
		input.diff,
		input.linesAdded,
		input.linesRemoved,
		input.bytesBefore,
		input.bytesAfter,
	);
	return version;
}

export function listRevisions(pagePath: string): Revision[] {
	return all(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE path = ? ORDER BY version DESC`, pagePath);
}

/** Revisions in the half-open version range (from, to], which /diff serves. */
export function revisionRange(pagePath: string, from: number, to: number): Revision[] {
	return all(
		`SELECT ${REVISION_COLUMNS} FROM revisions WHERE path = ? AND version > ? AND version <= ? ORDER BY version ASC`,
		pagePath,
		from,
		to,
	);
}

export function currentVersion(pagePath: string): number {
	return get<{ v: number | null }>('SELECT MAX(version) AS v FROM revisions WHERE path = ?', pagePath)?.v ?? 0;
}

/** Revisions across the whole wiki since an ISO timestamp, which /changes serves. */
export function changesSince(sinceIso: string): Revision[] {
	return all(`SELECT ${REVISION_COLUMNS} FROM revisions WHERE ts > ? ORDER BY ts DESC`, sinceIso);
}

export function addGap(input: Omit<Gap, 'ts' | 'status'> & { status?: 'open' | 'resolved' }): Gap {
	const gap: Gap = { ...input, status: input.status ?? 'open', ts: now() };
	run(
		'INSERT INTO gaps (id, title, app, project, page_path, status, created_by, ts, resolved_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		gap.id,
		gap.title,
		gap.app,
		gap.project,
		gap.pagePath,
		gap.status,
		gap.createdBy,
		gap.ts,
		gap.resolvedRef,
	);
	return gap;
}

export function listGaps(filter: { status?: string; app?: string; project?: string } = {}): Gap[] {
	const used = (['status', 'app', 'project'] as const).filter((col) => filter[col]);
	const where = used.length ? `WHERE ${used.map((col) => `${col} = ?`).join(' AND ')}` : '';
	return all(`SELECT ${GAP_COLUMNS} FROM gaps ${where} ORDER BY ts DESC`, ...used.map((col) => filter[col]!));
}

export function resolveGap(id: string, resolvedRef: string): boolean {
	return run("UPDATE gaps SET status = 'resolved', resolved_ref = ? WHERE id = ?", resolvedRef, id) > 0;
}

export function addWatch(input: { id: string; watcher: string; scope: string; value: string }): void {
	run(
		'INSERT OR REPLACE INTO watches (id, watcher, scope, value, since) VALUES (?, ?, ?, ?, ?)',
		input.id,
		input.watcher,
		input.scope,
		input.value,
		now(),
	);
}

export function listWatches(): { id: string; watcher: string; scope: string; value: string; since: string }[] {
	return all('SELECT * FROM watches ORDER BY since DESC');
}

// Machine-local page bookmarks shared by every browser on this wiki, keyed by canonical page path (…/index.html).

/** Favorite page paths, newest-first. Empty when the metadata DB is unavailable. */
export function listFavorites(): string[] {
	return all<{ path: string }>('SELECT path FROM favorites ORDER BY created_at DESC').map((r) => r.path);
}

/** Idempotent add: re-adding an existing favorite is a no-op and keeps its original position. */
export function addFavorite(pagePath: string): void {
	run('INSERT OR IGNORE INTO favorites (path, created_at) VALUES (?, ?)', pagePath, now());
}

/** Remove a favorite. Returns false when nothing was removed (unknown path or DB unavailable). */
export function removeFavorite(pagePath: string): boolean {
	return run('DELETE FROM favorites WHERE path = ?', pagePath) > 0;
}
