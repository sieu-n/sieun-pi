/**
 * Search over one box's index and its durable thread indexes. Newest-first walks FTS5 rowids backwards, which are entry times
 * (docs.id = at * 1024 + seq), so it stops after a page. "Relevant" ranks with bm25 times a kind weight within the newest 2,000 hits, in the
 * rowid-floor form search.md section 4 measured at 12 ms p50 on the family index; the same window as `rowid IN (subquery)` took 3.9 s.
 * Every total is an exact count over the same filters (owner rule c191).
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { Filters, Kind, Query } from "./query.ts";

export interface Hit {
  ref: string;
  box: string;
  source: "prime" | "durable";
  session: string;
  root: string;
  parent?: string;
  depth: number;
  thread: string;
  rootName?: string;
  kind: Kind;
  tool?: string;
  toolCallId?: string;
  author: string;
  at: number;
  snippet: string;
  isError?: boolean;
}

/** A hit with the keys a merge across sources sorts by: `key` orders newest first, `score` orders relevant (lower is better). */
export interface Ranked { hit: Hit; key: number; score: number }
/** One source's hits for a page, one more than the page holds when more exist, so the merge knows to hand out a cursor. */
export interface Page { hits: Ranked[]; total: number }

export type PageAsk =
  | { sort: "newest"; limit: number; before?: { k: number; seen: string[] } }
  | { sort: "relevant"; limit: number; offset: number };

/** Relevance ranks only the newest hits, measured in search.md section 4 (12 ms p50 at 2,000 on the family index). */
export const RANK_WINDOW = 2000;

/** Kind weights after bm25 (search.md section 5, a first guess to tune on real queries). bm25 is negative, so a lower weight ranks lower. */
export const KIND_WEIGHT: Record<Kind, number> = {
  user: 1, agent_message: 1, assistant: 0.9, summary: 0.8, tool_call: 0.6, thinking: 0.5, notice: 0.5, tool_result: 0.4,
};

const OPEN = "\u0002";
const CLOSE = "\u0003";
const SNIPPET_TOKENS = 32;
const SNIPPET_CHARS = 200;

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** FTS5 snippet text with the match markers as <mark>, everything else HTML-escaped. */
export function markSnippet(raw: string): string {
  return escapeHtml(raw.replace(/\s+/g, " ").trim()).replaceAll(OPEN, "<mark>").replaceAll(CLOSE, "</mark>");
}

/** The start of a text no FTS match marks, for a hit found by its session id alone. */
function plainSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return escapeHtml(flat.length > SNIPPET_CHARS ? flat.slice(0, SNIPPET_CHARS) + "…" : flat);
}

const weightCase = (column: string): string =>
  `CASE ${column} ${Object.entries(KIND_WEIGHT).map(([kind, weight]) => `WHEN '${kind}' THEN ${weight}`).join(" ")} ELSE 1 END`;

const like = (text: string): string => text.replace(/[\\%_]/g, char => "\\" + char);

type Row = Record<string, SQLInputValue>;

/** Prepared statements per database, since every request builds one of a few shapes. */
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function prepare(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, cache = new Map());
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, statement = db.prepare(sql));
  return statement;
}

/** WHERE terms, and whether any of them reads the docs or files row (a count with none of those reads fts alone). */
interface Clause { sql: string[]; values: SQLInputValue[]; rows: boolean }
const clause = (): Clause => ({ sql: [], values: [], rows: false });

const metaIndex = new WeakMap<DatabaseSync, boolean>();
/**
 * Whether docs has the covering index docs_meta(id, file, kind, is_error, author). A count with a row filter then reads that index per hit
 * instead of each docs row, measured on a 1.5M-doc copy of the live index on 10-28: board.wake 3,736 to 269 ms cold, "the" 33.4 s to 0.9 s.
 */
function hasMetaIndex(db: DatabaseSync): boolean {
  let has = metaIndex.get(db);
  if (has === undefined) metaIndex.set(db, has = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'docs_meta'").get());
  return has;
}

const kindColumn = new WeakMap<DatabaseSync, boolean>();
/**
 * Whether fts indexes `kind` beside `text`. Then "everything but thinking" is a MATCH term and an exact count needs no docs join, which
 * measured 4 to 10x faster on a 400,000-doc copy of the live index on 10-28 (board.wake 47 to 10 ms, "the" 592 to 60 ms).
 */
function ftsHasKind(db: DatabaseSync): boolean {
  let has = kindColumn.get(db);
  if (has === undefined) kindColumn.set(db, has = (db.prepare("PRAGMA table_info(fts)").all() as Row[]).some(row => row.name === "kind"));
  return has;
}

/** The WHERE terms every prime query shares: kinds, error flag, time, chat, author and the scope's roots. */
function primeFilters(filters: Filters, thinking: boolean, roots: string[] | null, idColumn: string, kindsInMatch: boolean): Clause {
  const out = clause();
  if (filters.kinds && !kindsInMatch) { out.sql.push(`d.kind IN (SELECT value FROM json_each(?))`); out.values.push(JSON.stringify(filters.kinds)); }
  if (!thinking && !kindsInMatch) out.sql.push(`d.kind != 'thinking'`);
  if (filters.isError) out.sql.push("d.is_error = 1");
  if (filters.since !== undefined) { out.sql.push(`${idColumn} >= ?`); out.values.push(filters.since * 1024); }
  if (filters.until !== undefined) { out.sql.push(`${idColumn} < ?`); out.values.push(filters.until * 1024); }
  if (filters.in.length) {
    out.sql.push(`d.file IN (SELECT id FROM files WHERE ${filters.in.map(() => `(session LIKE ? ESCAPE '\\' OR root LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
      OR root IN (SELECT session FROM files WHERE depth = 0 AND name LIKE ? ESCAPE '\\'))`).join(" OR ")})`);
    for (const value of filters.in) out.values.push(like(value) + "%", like(value) + "%", "%" + like(value) + "%", "%" + like(value) + "%");
  }
  if (filters.from.length) {
    out.sql.push("(" + filters.from.map(value => {
      const who = value.toLowerCase();
      if (who === "owner") return "d.author = 'owner'";
      if (who === "tool") return "d.kind IN ('tool_call', 'tool_result')";
      out.values.push("%" + like(value) + "%");
      return "d.author LIKE ? ESCAPE '\\'";
    }).join(" OR ") + ")");
  }
  if (roots) { out.sql.push("d.file IN (SELECT id FROM files WHERE root IN (SELECT value FROM json_each(?)))"); out.values.push(JSON.stringify(roots)); }
  out.rows = out.sql.some(term => term.startsWith("d.") || term.startsWith("(d."));
  return out;
}

const HIT_COLUMNS = `d.id AS id, d.at AS at, d.kind AS kind, d.tool AS tool, d.tool_call_id AS tool_call_id, d.author AS author, d.is_error AS is_error,
  f.session AS session, f.root AS root, f.parent AS parent, f.depth AS depth, f.name AS name,
  (SELECT r.name FROM files r WHERE r.session = f.root AND r.depth = 0 LIMIT 1) AS root_name`;

function primeHit(row: Row, box: string, snippet: string): Hit {
  const session = String(row.session);
  const thread = row.name ? String(row.name) : session;
  const rootName = row.root_name ? String(row.root_name) : undefined;
  return {
    ref: `${box}:${session}@${Number(row.at)}#${Number(row.id)}`, box, source: "prime", session, root: String(row.root),
    ...row.parent ? { parent: String(row.parent) } : {}, depth: Number(row.depth), thread,
    ...rootName && rootName !== thread ? { rootName } : {}, kind: String(row.kind) as Kind,
    ...row.tool ? { tool: String(row.tool) } : {}, ...row.tool_call_id ? { toolCallId: String(row.tool_call_id) } : {},
    author: String(row.author ?? ""), at: Number(row.at), snippet, ...Number(row.is_error) ? { isError: true } : {},
  };
}

/** One way to find prime hits: by MATCH text, by session id (with or without other terms), or by filters alone. */
interface Branch { match: string | null; sessions: string[] }

function branches(query: Query): Branch[] {
  const match = query.match && query.exclude ? `(${query.match}) NOT (${query.exclude})` : query.match;
  const out: Branch[] = [{ match, sessions: [] }];
  if (query.sessionIds.length) {
    const rest = query.rest && query.exclude ? `(${query.rest}) NOT (${query.exclude})` : query.rest;
    out.push({ match: rest, sessions: query.sessionIds });
  }
  return out;
}

/** MATCH text that also holds the kind filter, for an fts that indexes kind: the asked kinds, else every kind but thinking. */
function kindMatch(match: string, query: Query): string {
  const text = `{text} : (${match})`;
  if (query.filters.kinds) return `${text} AND kind : (${query.filters.kinds.map(kind => `"${kind}"`).join(" OR ")})`;
  return query.thinking ? text : `${text} NOT kind : "thinking"`;
}

/**
 * The SQL pieces of one branch: its FROM for hit rows, for the exact count and for the rank window, its WHERE, the rank window's WHERE and
 * its snippet MATCH text. The rank window filters kinds on the docs row, never in the MATCH: bm25 counts every phrase of the MATCH across the
 * whole index, and `kind : "thinking"` (720,000 docs) cost each relevant search about 105 ms, even one with 2 hits, on 10-28.
 */
interface BranchSql { from: string; countFrom: string; rankFrom: string; id: string; where: Clause; rankWhere: Clause; fts: boolean; match: string | null; sessions: string[] }

function branchWhere(branch: Branch, query: Query, roots: string[] | null, match: string | null, kindsInMatch: boolean): Clause {
  const fts = branch.match !== null;
  const id = fts ? "fts.rowid" : "d.id";
  const where = clause();
  if (fts) { where.sql.push("fts MATCH ?"); where.values.push(match); }
  else if (query.exclude) { where.sql.push("d.id NOT IN (SELECT rowid FROM fts WHERE fts MATCH ?)"); where.values.push(query.exclude); where.rows = true; }
  if (branch.sessions.length) {
    where.sql.push(`d.file IN (SELECT id FROM files WHERE ${branch.sessions.map(() => "session LIKE ?").join(" OR ")})`);
    where.values.push(...branch.sessions.map(sessionId => sessionId + "%"));
    where.rows = true;
  }
  const filters = primeFilters(query.filters, query.thinking, roots, id, kindsInMatch);
  where.sql.push(...filters.sql);
  where.values.push(...filters.values);
  where.rows ||= filters.rows || !fts;
  return where;
}

function branchFrom(db: DatabaseSync, branch: Branch, query: Query, roots: string[] | null): BranchSql {
  const fts = branch.match !== null;
  const kinds = fts && ftsHasKind(db);
  const text = !fts ? null : kinds ? `{text} : (${branch.match})` : branch.match;
  const where = branchWhere(branch, query, roots, kinds ? kindMatch(branch.match!, query) : branch.match, kinds);
  const from = fts ? "fts JOIN docs d ON d.id = fts.rowid JOIN files f ON f.id = d.file" : "docs d JOIN files f ON f.id = d.file";
  const docs = hasMetaIndex(db) ? "docs d INDEXED BY docs_meta" : "docs d";
  const countFrom = !where.rows ? "fts" : fts ? `fts JOIN ${docs} ON d.id = fts.rowid` : "docs d";
  return { from, countFrom, rankFrom: `fts JOIN ${docs} ON d.id = fts.rowid`, id: fts ? "fts.rowid" : "d.id", where,
    rankWhere: branchWhere(branch, query, roots, text, false), fts, match: text, sessions: branch.sessions };
}

const whereSql = (where: Clause, extra: string[] = []): string => {
  const parts = [...where.sql, ...extra];
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
};

/** A query with no text, no session id and no filter would list every row; it answers nothing instead. */
function empty(query: Query): boolean {
  const f = query.filters;
  return !query.match && !query.sessionIds.length && !f.in.length && !f.from.length && !f.kinds && !f.isError && f.since === undefined && f.until === undefined;
}

/** One page of hits from one box's prime index, without the total (`countPrime` counts it, so the two can run side by side). */
export function primeHits(db: DatabaseSync, box: string, query: Query, ask: PageAsk, roots: string[] | null): Ranked[] {
  if (empty(query)) return [];
  const parts = branches(query).map(branch => branchFrom(db, branch, query, roots));
  const hits = new Map<number, Ranked>();
  const add = (row: Row, fts: boolean, score: number) => {
    const id = Number(row.id);
    if (hits.has(id)) return;
    const text = String(row.snippet ?? "");
    hits.set(id, { hit: primeHit(row, box, fts ? markSnippet(text) : plainSnippet(text)), key: id, score });
  };
  const want = ask.sort === "newest" ? ask.limit + (ask.before?.seen.length ?? 0) + 1 : ask.offset + ask.limit + 1;
  for (const part of parts) {
    if (!part.fts) {
      for (const row of plainRows(db, part, ask, want)) add(row, false, 0);
      continue;
    }
    const snippet = `snippet(fts, 0, '${OPEN}', '${CLOSE}', '…', ${SNIPPET_TOKENS}) AS snippet`;
    if (ask.sort === "newest") {
      const before = ask.before ? [`${part.id} <= ?`] : [];
      const sql = `SELECT ${HIT_COLUMNS}, ${snippet} FROM ${part.from} ${whereSql(part.where, before)} ORDER BY ${part.id} DESC LIMIT ?`;
      for (const row of prepare(db, sql).all(...part.where.values, ...ask.before ? [ask.before.k] : [], want) as Row[]) add(row, true, 0);
      continue;
    }
    // Scores the newest RANK_WINDOW hits in one pass and sorts them here, then builds hit rows and snippets for the page's ids only. On 10-28
    // a snippet in the ranking query was made for all 2,000 rows before the sort kept 21, and the window's floor as a subquery ran the MATCH
    // a second time: "did not answer in" took 660 ms to rank that way.
    const scored = (prepare(db, `SELECT fts.rowid AS id, bm25(fts) * ${weightCase("d.kind")} AS score FROM ${part.rankFrom}
      ${whereSql(part.rankWhere)} ORDER BY fts.rowid DESC LIMIT ${RANK_WINDOW}`).all(...part.rankWhere.values) as Row[])
      .sort((a, b) => Number(a.score) - Number(b.score) || Number(b.id) - Number(a.id)).slice(0, want);
    if (!scored.length) continue;
    const scores = new Map(scored.map(row => [Number(row.id), Number(row.score)]));
    const rows = prepare(db, `SELECT ${HIT_COLUMNS}, ${snippet} FROM fts JOIN docs d ON d.id = fts.rowid JOIN files f ON f.id = d.file
      WHERE fts MATCH ? AND fts.rowid IN (SELECT value FROM json_each(?))`).all(part.match, JSON.stringify([...scores.keys()])) as Row[];
    for (const row of rows) add(row, true, scores.get(Number(row.id)) ?? 0);
  }
  const out = [...hits.values()];
  return ask.sort === "relevant" ? out.sort((a, b) => a.score - b.score || b.key - a.key) : out;
}

/**
 * Newest rows for a branch with no MATCH text. With session ids it reads each named file through docs_file_at, newest first: the plain
 * `ORDER BY d.id DESC` walked every newer doc of the whole index to find one session's rows (3.8 s cold for 01a1164b on 10-28).
 */
function plainRows(db: DatabaseSync, part: BranchSql, ask: PageAsk, want: number): Row[] {
  const before = ask.sort === "newest" && ask.before ? ask.before.k : null;
  const bound = before === null ? [] : ["d.at <= ?", "d.id <= ?"];
  const boundValues = before === null ? [] : [Math.floor(before / 1024), before];
  const snippet = "substr(d.text, 1, 400) AS snippet";
  if (!part.sessions.length) {
    const sql = `SELECT ${HIT_COLUMNS}, ${snippet} FROM ${part.from} ${whereSql(part.where, bound.slice(1))} ORDER BY d.id DESC LIMIT ?`;
    return prepare(db, sql).all(...part.where.values, ...boundValues.slice(1), want) as Row[];
  }
  const files = prepare(db, `SELECT id FROM files WHERE ${part.sessions.map(() => "session LIKE ?").join(" OR ")}`).all(...part.sessions.map(id => id + "%")) as Row[];
  const sql = `SELECT ${HIT_COLUMNS}, ${snippet} FROM ${part.from} ${whereSql(part.where, ["d.file = ?", ...bound])} ORDER BY d.at DESC, d.id DESC LIMIT ?`;
  return files.flatMap(file => prepare(db, sql).all(...part.where.values, Number(file.id), ...boundValues, want) as Row[])
    .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, want);
}

/** The exact number of hits a query has in one box's prime index (owner rule c191). */
export function countPrime(db: DatabaseSync, query: Query, roots: string[] | null): number {
  if (empty(query)) return 0;
  const parts = branches(query).map(branch => branchFrom(db, branch, query, roots));
  const count = parts.length === 1
    ? `SELECT count(*) AS n FROM ${parts[0]!.countFrom} ${whereSql(parts[0]!.where)}`
    : `SELECT count(*) AS n FROM (${parts.map(part => `SELECT ${part.id} AS id FROM ${part.countFrom} ${whereSql(part.where)}`).join(" UNION ")})`;
  return Number((prepare(db, count).get(...parts.flatMap(part => part.where.values)) as Row).n);
}

/** Hits and the exact total from one box's prime index. */
export function searchPrime(db: DatabaseSync, box: string, query: Query, ask: PageAsk, roots: string[] | null): Page {
  return { hits: primeHits(db, box, query, ask, roots), total: countPrime(db, query, roots) };
}


/** pi-host's durable entry kinds (packages/pi-host/src/durable/import.ts) as this index's kinds. */
const DURABLE_KINDS: Record<string, Kind> = {
  "pi.user": "user", "pi.assistant": "assistant", "pi.tool-result": "tool_result", "agent.message": "agent_message",
  "pi.compaction": "summary", "prime.custom": "notice",
};
export const durableKind = (name: string): Kind => DURABLE_KINDS[name] ?? "notice";
const durableKinds = (kinds: readonly Kind[]): string[] => Object.entries(DURABLE_KINDS).filter(([, kind]) => kinds.includes(kind)).map(([name]) => name);

/** Hits and the exact total from one pi-host durable index (packages/pi-host/src/durable/index-db.ts), opened read-only. */
export function searchDurable(db: DatabaseSync, index: number, box: string, query: Query, ask: PageAsk, roots: string[] | null): Page {
  const f = query.filters;
  // A durable entry has no session id file and no error flag, so a query that needs either finds nothing there.
  if (!query.match || query.sessionIds.length || f.isError) return { hits: [], total: 0 };
  const where = clause();
  where.sql.push("entries MATCH ?");
  where.values.push(query.exclude ? `(${query.match}) NOT (${query.exclude})` : query.match);
  const kinds = f.kinds ?? Object.values(DURABLE_KINDS).filter(kind => kind !== "thinking");
  where.sql.push("e.kind IN (SELECT value FROM json_each(?))");
  where.values.push(JSON.stringify(durableKinds(kinds)));
  if (f.since !== undefined) { where.sql.push("CAST(e.at AS INTEGER) >= ?"); where.values.push(f.since); }
  if (f.until !== undefined) { where.sql.push("CAST(e.at AS INTEGER) < ?"); where.values.push(f.until); }
  if (f.in.length) {
    where.sql.push("(" + f.in.map(() => "e.thread LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\'").join(" OR ") + ")");
    for (const value of f.in) where.values.push(like(value) + "%", "%" + like(value) + "%");
  }
  if (f.from.length) {
    const named = f.from.filter(value => !["owner", "tool"].includes(value.toLowerCase()));
    const terms = [
      ...f.from.some(value => value.toLowerCase() === "owner") ? ["e.kind = 'pi.user'"] : [],
      ...f.from.some(value => value.toLowerCase() === "tool") ? ["e.kind = 'pi.tool-result'"] : [],
      ...named.map(() => "e.author LIKE ? ESCAPE '\\'"),
    ];
    where.sql.push("(" + terms.join(" OR ") + ")");
    where.values.push(...named.map(value => "%" + like(value) + "%"));
  }
  if (roots) { where.sql.push("e.thread IN (SELECT value FROM json_each(?))"); where.values.push(JSON.stringify(roots)); }
  const from = "entries e LEFT JOIN threads t ON t.id = e.thread";
  const key = "(CAST(e.at AS INTEGER) * 1024 + e.rowid % 1024)";
  const columns = `e.rowid AS id, e.thread AS thread, e.kind AS kind, e.author AS author, CAST(e.at AS INTEGER) AS at, t.name AS name,
    snippet(entries, 0, '${OPEN}', '${CLOSE}', '…', ${SNIPPET_TOKENS}) AS snippet, ${key} AS k`;
  let sql: string;
  let values: SQLInputValue[];
  if (ask.sort === "newest") {
    sql = `SELECT ${columns}, 0 AS score FROM ${from} ${whereSql(where, ask.before ? [`${key} <= ?`] : [])} ORDER BY k DESC LIMIT ?`;
    values = [...where.values, ...ask.before ? [ask.before.k] : [], ask.limit + (ask.before?.seen.length ?? 0) + 1];
  } else {
    const floor = `SELECT min(r) FROM (SELECT e.rowid AS r FROM ${from} ${whereSql(where)} ORDER BY e.rowid DESC LIMIT ${RANK_WINDOW})`;
    const weight = `CASE e.kind ${Object.entries(DURABLE_KINDS).map(([name, kind]) => `WHEN '${name}' THEN ${KIND_WEIGHT[kind]}`).join(" ")} ELSE 1 END`;
    sql = `SELECT ${columns}, bm25(entries) * ${weight} AS score FROM ${from} ${whereSql(where, [`e.rowid >= (${floor})`])} ORDER BY score LIMIT ?`;
    values = [...where.values, ...where.values, ask.offset + ask.limit + 1];
  }
  const hits = (prepare(db, sql).all(...values) as Row[]).map((row): Ranked => {
    const thread = String(row.thread);
    const at = Number(row.at);
    return {
      key: Number(row.k), score: Number(row.score),
      hit: {
        ref: `${box}:${thread}@${at}#d${index}.${Number(row.id)}`, box, source: "durable", session: thread, root: thread, depth: 0,
        thread: row.name ? String(row.name) : thread, kind: durableKind(String(row.kind)), author: String(row.author ?? ""), at,
        snippet: markSnippet(String(row.snippet ?? "")),
      },
    };
  });
  const total = Number((prepare(db, `SELECT count(*) AS n FROM ${from} ${whereSql(where)}`).get(...where.values) as Row).n);
  return { hits, total };
}

/** Merges pages from every source into one page and the cursor for the next one. */
export function mergePages(pages: Page[], ask: PageAsk): { hits: Hit[]; total: number; next?: string } {
  const total = pages.reduce((sum, page) => sum + page.total, 0);
  let all = pages.flatMap(page => page.hits);
  if (ask.sort === "newest") {
    const seen = new Set(ask.before?.seen ?? []);
    all = all.filter(item => !(ask.before && item.key === ask.before.k && seen.has(item.hit.ref)));
    all.sort((a, b) => b.key - a.key || (a.hit.ref < b.hit.ref ? -1 : 1));
    const hits = all.slice(0, ask.limit);
    if (all.length <= ask.limit || !hits.length) return { hits: hits.map(item => item.hit), total };
    const last = hits.at(-1)!.key;
    const tied = hits.filter(item => item.key === last).map(item => item.hit.ref);
    const carried = ask.before?.k === last ? ask.before.seen : [];
    return { hits: hits.map(item => item.hit), total, next: encodeCursor({ k: last, seen: [...carried, ...tied] }) };
  }
  all.sort((a, b) => a.score - b.score || b.key - a.key);
  const hits = all.slice(ask.offset, ask.offset + ask.limit);
  const more = all.length > ask.offset + ask.limit;
  return { hits: hits.map(item => item.hit), total, ...more ? { next: encodeCursor({ o: ask.offset + ask.limit }) } : {} };
}

type Cursor = { k: number; seen: string[] } | { o: number };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** The page a request asks for, from its sort, limit and opaque cursor. */
export function pageAsk(sort: "newest" | "relevant", limit: number, cursor: string | null | undefined): PageAsk {
  let parsed: unknown = null;
  if (cursor) {
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object") throw new RangeError("Bad cursor.");
  }
  const value = parsed as Partial<{ k: unknown; seen: unknown; o: unknown }> | null;
  if (sort === "newest") {
    if (!value) return { sort, limit };
    if (typeof value.k !== "number" || !Array.isArray(value.seen)) throw new RangeError("Bad cursor for sort=newest.");
    return { sort, limit, before: { k: value.k, seen: value.seen.map(String) } };
  }
  if (value && typeof value.o !== "number") throw new RangeError("Bad cursor for sort=relevant.");
  return { sort, limit, offset: value ? Number(value.o) : 0 };
}
