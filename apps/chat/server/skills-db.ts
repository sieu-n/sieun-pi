/**
 * The skills DB: sw factory's wanted state of every skill, in <data dir>/chat.sqlite, the sw factory DB. The owner asked for it in
 * #sw-factory-build on 11-22: "agent가 검증하는건 좋은데, DB에 저장되어있고 (same as the sw-factory db) should be checkable/installable by
 * command & api call" (msg mwqwfx5h) and "so idempotent, db owns ownership" (msg mwqwgfsi).
 *
 * The DB owns which skills exist, who owns each, its one source and where it is installed; the text stays in git or in its package.
 * scripts/skills-inventory.py stays the one fact scanner, and each scan's inventory.json is ingested here: the copies each box holds, the
 * use counts, and the settings that filter what a runtime lists. The first ingest seeds the rows from the disk as it is, so the first apply
 * changes nothing. Later scans only report drift, which a person or an agent settles with adopt or remove. Every change that touches the disk
 * goes through the skills review's backup and undo path (server/skills-review.ts `runSteps`), and every change is a move that undo reverses.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { listedEntries, type ListedEntry } from "./compress.ts";
import {
  COUNT_RULES, SKILL_RUNTIMES, type VerdictRule, type AdoptBody, type ApplyResult, type ApplyStep, type CopyRole, type InstallBody, type InstallState, type MergeBody, type MoveBody,
  type OwnBody, type RemoveBody, type SkillBoxState, type SkillCopy, type SkillCounts, type SkillEntry, type SkillMove, type SkillSight, type SkillOwner, type SkillRuntime,
  type SkillScan, type SkillSource, type SkillsChange, type SkillsCheck, type SkillsView, type SkillThresholds, type ThreadKind, type SkillVerdictRow, type UndoBody, skillTexts, toWire,
} from "../web/src/lib/api/shared/skills.ts";
import {
  canonical, changedLines, copyId, drift, extraCopies, goneSkills, identifyFolder, installState, ownerText, parseFacts, parseOwner, plan, roleOf, sameLink, seedOwner, sees, staleCheckouts, sumUse,
  thresholds, tree, verdicts, type BoxScan, type CopyFact, type FactCopy, type Facts, type FactUse, type InstallRecord, type PathUse, type SkillRecord,
} from "./skills-model.ts";

export type SkillsDbConfig = {
  /** The sw factory DB file, <data dir>/chat.sqlite. */
  file: string;
  /** The box this server runs on, whose files it reads and writes itself. */
  box: string;
  home: string;
  /** The installed pi-host release's chat-brief.ts, whose WRITING_SKILL names the skill every sw factory thread gets in full through prime-prompt.ts. */
  piHostPrompt: string | null;
};

/** One disk step the skills review runs with a backup: delete a copy, place a link or copy, or hand a merge to agent factory. */
export type DiskStep =
  | { kind: "delete"; box: string; path: string; name: string }
  | { kind: "place"; box: string; path: string; name: string; mode: "link" | "copy"; from: string }
  | { kind: "fold"; box: string; path: string; name: string; into: string; reason: string };

export type DiskResult = { box: string; path: string; state: "applied" | "queued" | "failed" | "undone" | "pending"; note: string | null };

/** The review's step runner (server/skills-review.ts), the one path that changes skill folders on disk. */
export interface DiskSteps {
  run(item: string, steps: DiskStep[]): Promise<DiskResult[]>;
  undo(item: string): Promise<DiskResult[]>;
}

/** A caller's mistake, such as an unknown skill or a path another skill holds; http.ts answers it 400. */
export class SkillsRefused extends Error {}

/** A write that found chat.sqlite's write lock held, mostly by a scan's ingest in the worker, for its whole wait (`SkillsDb.write`). */
export class SkillsBusy extends SkillsRefused {}

/** How long a skills change waits for chat.sqlite's write lock, off the event loop, before it answers busy: the ingest worker's own
 *  busy_timeout. An ingest holds the lock one `land` transaction at a time, so a change waits at most one of those behind it. */
const WRITE_WAIT_MS = 5_000;

/** A disk step that did not take effect; the change answers an error with the step's reason, and its move stays for undo. */
export class SkillsStepFailed extends Error {}

function failure(what: string, moveId: string, results: readonly { box: string; path: string; note: string | null; state: string }[]): SkillsStepFailed | null {
  const failed = results.filter(r => r.state === "failed");
  if (!failed.length) return null;
  return new SkillsStepFailed(`${what} failed on ${failed.length} of ${results.length} steps (move ${moveId}): ${failed.map(r => `${r.box}:${r.path}: ${r.note ?? "no reason given"}`).join("; ")}`);
}

/** How long one of an ingest's write transactions runs its statements before it commits (`land`): a room send waits for chat.sqlite's
 *  write lock at most one such transaction, and the target is a hold of about 50 ms at box load, commit included. */
const LAND_MS = 10;

/** The tables an ingest writes, in the order `land` writes them; meta goes last, so its `ingested` row lands with the last rows. */
const INGESTED = ["skill_copies", "skill_scans", "skills", "skill_installs", "skill_use_box", "skill_use", "skill_verdicts", "meta"] as const;
type IngestedTable = (typeof INGESTED)[number];
/** The tables a route writes besides skill_moves, which no ingest reads. */
const ROUTE_WRITTEN = ["skills", "skill_installs", "skill_copies"] as const;

/**
 * Each keyed table's key, by which a changed row is written alone. The other tables are read in rowid order with no ORDER BY, which
 * decides the order of a skill's verdicts and of the use summed over boxes, so a change there writes the whole table again in the
 * ingest's order.
 */
const KEYS: Partial<Record<IngestedTable, readonly string[]>> = { skill_copies: ["box", "path"], skill_scans: ["box"], skills: ["id"], skill_installs: ["id"], meta: ["key"] };

type TableRows = { columns: string[]; rows: Row[] };
type Statement = [sql: string, params: SQLInputValue[]];
/** Statements that land in one transaction, so no read sees part of them: one keyed row, or a whole table in rowid order. */
type Unit = Statement[];
type IngestPlan = { rev: number; seeded: boolean; units: Unit[] };

/** The writes that turn a table's rows `before` into its rows `after`, the ingest's. */
function changedRows(table: IngestedTable, before: TableRows, after: TableRows): Unit[] {
  const { columns } = after;
  const same = (a: Row, b: Row) => columns.every(c => a[c] === b[c]);
  const insert = `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const put = (row: Row): Statement => [insert, columns.map(c => row[c] as SQLInputValue)];
  const keys = KEYS[table];
  if (!keys) {
    if (before.rows.length === after.rows.length && before.rows.every((row, i) => same(row, after.rows[i]!))) return [];
    const batches: Statement[] = [];
    for (let at = 0; at < after.rows.length; at += 100) {
      const batch = after.rows.slice(at, at + 100);
      const values = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      batches.push([`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`, batch.flatMap(row => columns.map(c => row[c] as SQLInputValue))]);
    }
    return [[[`DELETE FROM ${table}`, []], ...batches]];
  }
  const keyOf = (row: Row) => JSON.stringify(keys.map(k => row[k]));
  const was = new Map(before.rows.map(row => [keyOf(row), row]));
  const kept = new Set(after.rows.map(keyOf));
  const remove = `DELETE FROM ${table} WHERE ${keys.map(k => `${k} = ?`).join(" AND ")}`;
  const gone = before.rows.filter(row => !kept.has(keyOf(row))).map((row): Unit => [[remove, keys.map(k => row[k] as SQLInputValue)]]);
  const changed = after.rows.filter(row => {
    const prior = was.get(keyOf(row));
    return !prior || !same(prior, row);
  });
  if (table === "meta") changed.sort((a, b) => Number(a.key === "ingested") - Number(b.key === "ingested"));
  return [...gone, ...changed.map((row): Unit => [put(row)])];
}

type StoredCopy = { box: string; path: string; fact: FactCopy; key: string; changed: number | null; stale: boolean };
type Snapshot = { skills: SkillRecord[]; installs: InstallRecord[]; copies: StoredCopy[] };
type Touched = { skills: string[]; installs: string[]; copies: string[] };
type MoveRow = SkillMove & { item: string | null; before: Snapshot; touched: Touched };

/**
 * skill_rev moves with each row change a route can make, by triggers, so an older server's routes move it too, and with each of an
 * ingest's write transactions (`land`). The tables only an ingest writes have no triggers: a trigger runs per row, and the whole-table
 * rewrite of skill_verdicts would run 1,800 of them inside one transaction.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_installs (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, box TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL, target TEXT NOT NULL, runtimes TEXT NOT NULL,
  agent TEXT, applied_hash TEXT, source_hash TEXT, pending TEXT, UNIQUE (box, path)
);
CREATE TABLE IF NOT EXISTS skill_copies (
  box TEXT NOT NULL, path TEXT NOT NULL, real_path TEXT NOT NULL, link_target TEXT, hash TEXT, lines INTEGER, bytes INTEGER, mtime TEXT,
  skill_key TEXT NOT NULL, changed_lines INTEGER, stale INTEGER NOT NULL, fact TEXT NOT NULL, PRIMARY KEY (box, path)
);
CREATE TABLE IF NOT EXISTS skill_scans (
  box TEXT PRIMARY KEY, attempted_at TEXT, ok INTEGER NOT NULL, error TEXT, seconds REAL, last_ok_at TEXT, since TEXT, settings TEXT
);
CREATE TABLE IF NOT EXISTS skill_verdicts (skill_id TEXT NOT NULL, rule TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, copy_id TEXT, other TEXT);
CREATE TABLE IF NOT EXISTS skill_use (name TEXT PRIMARY KEY, uses INTEGER NOT NULL, sessions INTEGER NOT NULL, last_use TEXT, by_kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_use_box (box TEXT NOT NULL, name TEXT NOT NULL, use TEXT NOT NULL, PRIMARY KEY (box, name));
CREATE TABLE IF NOT EXISTS skill_moves (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, item TEXT, before TEXT NOT NULL, touched TEXT NOT NULL, undone_at TEXT
);
CREATE TABLE IF NOT EXISTS skill_rev (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
${ROUTE_WRITTEN.flatMap(table => ["insert", "update", "delete"].map(op => `CREATE TRIGGER IF NOT EXISTS ${table}_rev_${op} AFTER ${op.toUpperCase()} ON ${table} BEGIN
  UPDATE skill_rev SET n = n + 1 WHERE id = 1;
END;`)).join("\n")}
`;

const now = (): string => new Date().toISOString();
const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);
const isRuntime = (value: string): value is SkillRuntime => (SKILL_RUNTIMES as readonly string[]).includes(value);
type Row = Record<string, unknown>;
const s = (value: unknown): string => String(value);
const sn = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const nn = (value: unknown): number | null => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null);

/** The folder a runtime reads on a box, under that box's home. */
function runtimeFolder(home: string, runtime: SkillRuntime): string {
  switch (runtime) {
    case "prime":
    case "pi-host":
      return `${home}/.prime/agent/skills`;
    case "claude":
      return `${home}/.claude/skills`;
    case "codex":
      return `${home}/.codex/skills`;
    case "pi":
      return `${home}/.pi/agent/skills`;
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

/** The runtimes whose skill folder is the folder a path sits in; an install outside every runtime's folder is read by none of them. */
function runtimesAt(home: string, path: string): SkillRuntime[] {
  return SKILL_RUNTIMES.filter(runtime => runtimeFolder(home, runtime) === dirname(path));
}

const SIGHT_RANK: Record<SkillSight["how"], number> = { inlined: 0, imported: 1, listed: 2, cwd: 3, hidden: 4 };

/**
 * Splits the use of a name that several skills share, because the use count is kept per name. A SKILL.md read whose transcript names a
 * path goes to the skill whose copy sits at that path (a link counts by its realPath); a `~/` path is read under the box's home, and a
 * relative one matches the copy whose path ends with it. The rest of each thread kind's tally, such as a Python call, goes to the skill
 * that kind loads (its best non-hidden sight), and a kind that loads none of them goes to the skill most kinds load.
 * On 11-22 agent-message, edit and agent-observe showed their full count twice, on Prime's bundled copy and on sieun-pi's pi-rlm copy,
 * and frontend-implementation credited auto-sns-agent's copy 0 though Prime threads open it by its path.
 */
export function creditUse(entries: SkillEntry[], byPath: ReadonlyMap<string, readonly PathUse[]> = new Map(), homeOf: (box: string) => string | null = () => null): void {
  const byName = new Map<string, SkillEntry[]>();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const [name, same] of byName) {
    if (same.length < 2) continue;
    const total = same[0]!.use;
    const seen = (e: SkillEntry, kind: string) => e.sees.find(x => x.kind === kind)?.how ?? "hidden";
    const reach = (e: SkillEntry) => e.sees.filter(x => x.how !== "hidden").length;
    const best = (from: SkillEntry[], kind: string) => [...from].sort((a, b) => SIGHT_RANK[seen(a, kind)] - SIGHT_RANK[seen(b, kind)])[0]!;
    const fallback = same.reduce((top, e) => (reach(e) > reach(top) ? e : top));
    const credit = new Map(same.map(e => [e, { uses: 0, sessions: 0, byKind: {} as typeof total.byKind }]));
    const give = (e: SkillEntry, kind: ThreadKind, uses: number, sessions: number) => {
      const to = credit.get(e)!;
      to.uses += uses;
      to.sessions += sessions;
      const cur = to.byKind[kind] ?? { uses: 0, sessions: 0 };
      to.byKind[kind] = { uses: cur.uses + uses, sessions: cur.sessions + sessions };
    };
    const left = new Map(Object.entries(total.byKind).map(([kind, tally]) => [kind as ThreadKind, { ...tally! }]));
    for (const use of byPath.get(name) ?? []) {
      const at = holder(same, use, homeOf(use.box));
      const rest = left.get(use.kind);
      if (!at.length || !rest) continue;
      const uses = Math.min(use.uses, rest.uses);
      const sessions = Math.min(use.sessions, rest.sessions);
      give(best(at, use.kind), use.kind, uses, sessions);
      rest.uses -= uses;
      rest.sessions -= sessions;
    }
    for (const [kind, rest] of left) {
      if (!rest.uses) continue;
      const loaders = same.filter(e => seen(e, kind) !== "hidden");
      give(loaders.length ? best(loaders, kind) : fallback, kind, rest.uses, rest.sessions);
    }
    const counted = [...credit.values()].reduce((n, c) => n + c.uses, 0);
    credit.get(fallback)!.uses += Math.max(0, total.uses - counted);
    for (const e of same) {
      const c = credit.get(e)!;
      e.use = { uses: c.uses, sessions: e === fallback && counted === 0 ? total.sessions : c.sessions, lastUse: c.uses ? total.lastUse : null, byKind: c.byKind };
    }
  }
}

/** The skills of one name whose copy sits at the path a use opened, on the use's box first. */
function holder(same: readonly SkillEntry[], use: PathUse, home: string | null): SkillEntry[] {
  let path = use.path.replace(/\/SKILL\.md$/, "");
  if (path.startsWith("~/") && home) path = `${home}${path.slice(1)}`;
  const rel = path.replace(/^(\.\/)+/, "");
  const repo = /^(\/.+?)\/\.(?:agents|claude|codex)\/skills\//.exec(path)?.[1] ?? null;
  const at = (c: SkillCopy) => path.startsWith("/")
    ? c.path === path || c.realPath === path || (repo !== null && c.checkout?.root === repo)
    : c.path.endsWith(`/${rel}`) || c.realPath.endsWith(`/${rel}`);
  const here = same.filter(e => e.copies.some(c => c.box === use.box && at(c)));
  return here.length ? here : same.filter(e => e.copies.some(at));
}

/**
 * The view without its scan as JSON texts: `plain` whole, and for a `?since=` read the rest without `skills` and each skill as a
 * `ListedEntry` (compress.ts), in the wire form of shared/skills.ts `toWire`; `texts` are the descriptions that form leaves out, which
 * GET /api/skills/text sends.
 */
export type ListedView = { plain: string; rest: string; entries: ListedEntry[]; texts: ListedEntry[] };

export function listedView(view: Omit<SkillsView, "scan">): ListedView {
  const { skills, ...rest } = toWire(view);
  return { plain: JSON.stringify(view), rest: JSON.stringify(rest), entries: listedEntries(skills), texts: listedEntries(skillTexts(view.skills)) };
}

export class SkillsDb {
  private readonly db: DatabaseSync;
  private version = 0;
  private cached: { version: number; view: Omit<SkillsView, "scan"> } | null = null;
  /** The view without its scan as `listedView` texts, by the DB version it was built at (`viewListed`). */
  private built: { version: number; listed: Promise<ListedView> } | null = null;
  /** Builds the view for GET /api/skills in a worker thread, as the serving process does; the fixture's small view stays inline for the specs. */
  viewsOffThread = false;
  /** LAND_MS; a test sets 0 to land one unit per transaction and read the view between them. */
  landMs = LAND_MS;

  /**
   * `busyMs` is how long a write waits for chat.sqlite's write lock inside the call. The serving process passes 0: node:sqlite waits on its
   * event loop, so a wait there stalls every call, and a write that finds the lock held answers that the DB is busy instead
   * (`SkillsRefused`). The ingest worker (`ingestOffThread`) waits 5 s.
   */
  constructor(private readonly config: SkillsDbConfig, private readonly disk: DiskSteps, private readonly log: (line: string) => void = () => {}, busyMs = 0) {
    mkdirSync(dirname(config.file), { recursive: true });
    this.db = new DatabaseSync(config.file);
    // A new table, column or trigger needs the write lock once, at the first start that has it, so that start waits for it.
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${WRITE_WAIT_MS};`);
    this.db.exec(SCHEMA);
    const useColumns = (this.db.prepare("PRAGMA table_info(skill_use)").all() as Row[]).map(r => s(r.name));
    if (!useColumns.includes("by_path")) this.db.exec("ALTER TABLE skill_use ADD COLUMN by_path TEXT NOT NULL DEFAULT '[]'");
    if (!this.db.prepare("SELECT 1 FROM skill_rev").get()) this.db.exec("INSERT OR IGNORE INTO skill_rev (id, n) VALUES (1, 0)");
    this.db.exec(`PRAGMA busy_timeout = ${busyMs};`);
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? s(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * One write transaction. node:sqlite waits for a held write lock inside the call (busy_timeout 5000), so that wait holds this process's
   * whole event loop; a wait or a hold over 200 ms is logged with the transaction's name, so a stall can be told apart from one here.
   */
  private tx<T>(fn: () => T, name = "write"): T {
    const asked = performance.now();
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (/SQLITE_BUSY|database is locked/i.test(String(error))) throw new SkillsBusy("The skills DB is busy taking a scan's inventory; try again in a few seconds.");
      throw error;
    }
    const began = performance.now();
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this.bump();
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      const waited = Math.round(began - asked), held = Math.round(performance.now() - began);
      if (waited > 200 || held > 200) this.log(`skills db: ${name} waited ${waited} ms for chat.sqlite's write lock and held it ${held} ms`);
    }
  }

  // Reads

  private skills(): SkillRecord[] {
    return (this.db.prepare("SELECT * FROM skills ORDER BY name, id").all() as Row[]).map(r => ({
      id: s(r.id), name: s(r.name), owner: parseOwner(s(r.owner)), source: JSON.parse(s(r.source)) as SkillSource, createdAt: s(r.created_at),
    }));
  }

  private installs(): InstallRecord[] {
    return (this.db.prepare("SELECT * FROM skill_installs ORDER BY box, path").all() as Row[]).map(r => ({
      id: s(r.id), skillId: s(r.skill_id), box: s(r.box), path: s(r.path), mode: s(r.mode) === "copy" ? "copy" : "link", target: s(r.target),
      runtimes: (JSON.parse(s(r.runtimes)) as string[]).filter(isRuntime), agent: sn(r.agent), appliedHash: sn(r.applied_hash), sourceHash: sn(r.source_hash),
      pending: sn(r.pending),
    }));
  }

  private storedCopies(): StoredCopy[] {
    return (this.db.prepare("SELECT box, path, skill_key, changed_lines, stale, fact FROM skill_copies ORDER BY box, path").all() as Row[]).map(r => ({
      box: s(r.box), path: s(r.path), fact: JSON.parse(s(r.fact)) as FactCopy, key: s(r.skill_key), changed: nn(r.changed_lines), stale: r.stale === 1 || r.stale === 1n,
    }));
  }

  private copies(): CopyFact[] {
    return this.storedCopies().map(c => ({ ...c.fact, key: c.key, changedLines: c.changed, stale: c.stale }));
  }

  private scans(): BoxScan[] {
    return (this.db.prepare("SELECT * FROM skill_scans ORDER BY box").all() as Row[]).map(r => ({
      box: s(r.box), attemptedAt: sn(r.attempted_at), ok: r.ok === 1 || r.ok === 1n, error: sn(r.error), seconds: nn(r.seconds), lastOkAt: sn(r.last_ok_at), since: sn(r.since),
      settings: r.settings ? JSON.parse(s(r.settings)) : null,
    }));
  }

  /** When the last scan of any box was tried, for the schedule. */
  /** Each box's install paths, for the scanner to read also where they sit outside every folder it walks. */
  installPaths(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const install of this.installs()) (out[install.box] ??= []).push(install.path);
    return out;
  }

    lastAttempt(): number | null {
    const row = this.db.prepare("SELECT max(attempted_at) AS at FROM skill_scans").get() as Row | undefined;
    return row?.at ? Date.parse(s(row.at)) : null;
  }

  /** The inventory a scan wrote that this DB already ingested, so a restart does not ingest the same file twice. */
  ingestedAt(): string | null {
    return this.meta("ingested");
  }

  // Ingest

  /**
   * Takes one scan's inventory.json: replaces the copies of each box that scanned, keeps the last good copies of a box that did not (an
   * asleep Mac), seeds the rows on the first ingest, and recomputes drift against the source, the verdicts and the use counts.
   *
   * Every room send waits for chat.sqlite's write lock, so the ingest does its work without it. `planIngest` reads the tables in one read
   * transaction, runs `take` on an in-memory copy of them and lists the rows that differ; `land` writes those rows in transactions of about
   * LAND_MS each. Taken in one transaction, the ingest held the lock 1.6 to 14.4 s on a copy of the live DB at box load about 600, and a
   * send waited up to 13.7 s (~/work/one-db/post-logs/NOTES.md, 11-23). A change a route makes meanwhile moves skill_rev, and the ingest
   * then plans again from the rows as they are, so it never writes over that change; its own rows landed so far plan to the same end,
   * because an inventory taken twice ends where one take ends.
   */
  ingest(raw: unknown): { seeded: boolean; copies: number } | null {
    const facts = parseFacts(raw);
    if (!facts) return null;
    // Each start takes the inventory again, and a hand-over's successor does it while the old server still serves from the same DB. An
    // inventory this DB took already changes nothing, so it is left out before any work.
    if (facts.generatedAt && this.meta("ingested") === facts.generatedAt) return { seeded: false, copies: facts.copies.length };
    let seeded = false;
    for (;;) {
      const plan = this.planIngest(facts);
      if (!plan) return { seeded, copies: facts.copies.length };
      seeded ||= plan.seeded;
      if (this.land(plan)) return { seeded, copies: facts.copies.length };
    }
  }

  /** The ingest's rows against the rows as they are, or null when another server took the same inventory meanwhile. */
  private planIngest(facts: Facts): IngestPlan | null {
    const before = new Map<IngestedTable, TableRows>();
    let rev: number;
    this.db.exec("BEGIN");
    try {
      rev = this.rev();
      for (const table of INGESTED) before.set(table, this.tableRows(table));
    } finally {
      this.db.exec("COMMIT");
    }
    const ingested = before.get("meta")!.rows.find(r => r.key === "ingested");
    if (facts.generatedAt && ingested?.value === facts.generatedAt) return null;
    const scratch = new SkillsDb({ ...this.config, file: ":memory:" }, this.disk);
    try {
      for (const [table, rows] of before) scratch.fill(table, rows);
      const seeded = scratch.take(facts);
      return { rev, seeded, units: INGESTED.flatMap(table => changedRows(table, before.get(table)!, scratch.tableRows(table))) };
    } finally {
      scratch.close();
    }
  }

  private rev(): number {
    return nn((this.db.prepare("SELECT n FROM skill_rev WHERE id = 1").get() as Row | undefined)?.n) ?? 0;
  }

  /** A table's rows in rowid order, the order its reads without ORDER BY see. */
  private tableRows(table: IngestedTable): TableRows {
    const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(r => s(r.name));
    return { columns, rows: this.db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all() as Row[] };
  }

  private fill(table: IngestedTable, { columns, rows }: TableRows): void {
    const insert = this.db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    this.db.exec("BEGIN");
    for (const row of rows) insert.run(...columns.map(c => row[c] as SQLInputValue));
    this.db.exec("COMMIT");
  }

  /**
   * Writes a plan's rows in transactions of about LAND_MS each, a send's longest wait for the lock. Each one first checks that skill_rev is
   * where the plan or this ingest's last transaction left it; false means another writer changed a table the plan read, so the plan is stale.
   *
   * Between two transactions it sleeps as long as the last one held the lock. A writer that finds the lock held sleeps in SQLite's busy handler
   * between tries, up to 100 ms a sleep, and back-to-back transactions left it no free moment: on a copy of the live DB at load 114, a
   * writer making 20 commits a second waited up to 333 ms behind transactions that each held the lock 71 ms or less.
   */
  private land(plan: IngestPlan): boolean {
    // In WAL mode synchronous NORMAL skips the fsync at each commit and keeps every commit whole; a power cut loses at most the last ones,
    // and the next start takes the inventory again, since meta's `ingested` row lands last. With the fsync, commits at load 200 to 260 took
    // up to 175 ms and one transaction held the lock 780 ms; without it the longest hold over 6 ingests was 102 ms.
    // A commit that grows the WAL past its limit copies it into the DB inside that commit, which took 670 to 780 ms in a seed at load 200
    // to 300. The ingest copies it once at its end instead, in a passive checkpoint that takes no write lock.
    const synchronous = nn((this.db.prepare("PRAGMA synchronous").get() as Row).synchronous);
    const autocheckpoint = nn((this.db.prepare("PRAGMA wal_autocheckpoint").get() as Row).wal_autocheckpoint);
    this.db.exec("PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0");
    try {
      return this.landAll(plan);
    } finally {
      this.db.exec(`PRAGMA synchronous = ${synchronous ?? 2}; PRAGMA wal_autocheckpoint = ${autocheckpoint ?? 1000}`);
      this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
  }

  private landAll(plan: IngestPlan): boolean {
    const statements = new Map<string, StatementSync>();
    let rev = plan.rev;
    let held = 0;
    for (let at = 0; at < plan.units.length; ) {
      if (at > 0) sleep(held);
      let locked = 0;
      const landed = this.tx(() => {
        locked = performance.now();
        if (this.rev() !== rev) return false;
        const began = performance.now();
        do {
          for (const [sql, params] of plan.units[at]!) {
            let statement = statements.get(sql);
            if (!statement) statements.set(sql, (statement = this.db.prepare(sql)));
            statement.run(...params);
          }
          at++;
        } while (at < plan.units.length && performance.now() - began < this.landMs);
        this.db.exec("UPDATE skill_rev SET n = n + 1 WHERE id = 1");
        rev = this.rev();
        return true;
      }, "ingest");
      held = performance.now() - locked;
      if (!landed) return false;
    }
    return true;
  }

  /** The ingest itself, on the in-memory copy `planIngest` made; true when it seeded a box. */
  private take(facts: Facts): boolean {
    const insertCopy = this.db.prepare(
      "INSERT OR REPLACE INTO skill_copies (box, path, real_path, link_target, hash, lines, bytes, mtime, skill_key, changed_lines, stale, fact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let seeded = false;
    this.tx(() => {
      const at = facts.generatedAt ?? now();
      for (const box of facts.boxes) {
        const prior = this.scans().find(scan => scan.box === box.box);
        if (box.ok) {
          this.db.prepare("DELETE FROM skill_copies WHERE box = ?").run(box.box);
          for (const c of facts.copies.filter(c => c.box === box.box)) {
            insertCopy.run(c.box, c.path, c.realPath, c.linkTarget, c.hash, c.lines, c.bytes, c.mtime, "", null, 0, JSON.stringify(c));
          }
          this.db.prepare("INSERT OR REPLACE INTO skill_scans (box, attempted_at, ok, error, seconds, last_ok_at, since, settings) VALUES (?, ?, 1, NULL, ?, ?, NULL, ?)")
            .run(box.box, box.scannedAt ?? at, box.seconds, box.scannedAt ?? at, JSON.stringify(box.settings));
        } else {
          this.db.prepare("INSERT OR REPLACE INTO skill_scans (box, attempted_at, ok, error, seconds, last_ok_at, since, settings) VALUES (?, ?, 0, ?, ?, ?, ?, ?)")
            .run(box.box, box.scannedAt ?? at, box.error, box.seconds, prior?.lastOkAt ?? null, prior?.ok === false ? prior.since ?? box.scannedAt ?? at : box.scannedAt ?? at, JSON.stringify(prior?.settings ?? null));
        }
      }
      this.derive();
      for (const box of facts.boxes.filter(b => b.ok && !this.meta(`seeded:${b.box}`))) {
        this.seed(box.box);
        this.setMeta(`seeded:${box.box}`, now());
        this.setMeta(`coverage:${box.box}`, String(facts.coverage));
        if (!this.meta("seeded")) this.setMeta("seeded", now());
        seeded = true;
      }
      for (const box of facts.boxes.filter(b => b.ok && Number(this.meta(`coverage:${b.box}`) ?? 1) < facts.coverage)) {
        this.seed(box.box);
        this.setMeta(`coverage:${box.box}`, String(facts.coverage));
      }
      for (const install of this.installs().filter(i => i.pending)) {
        if (facts.boxes.some(b => b.box === install.box && b.ok)) this.db.prepare("UPDATE skill_installs SET pending = NULL WHERE id = ?").run(install.id);
      }
      for (const install of this.installs().filter(i => i.mode === "link")) {
        const at = facts.copies.find(c => c.box === install.box && c.path === install.path);
        if (at?.linkTarget && at.linkTarget !== install.target && sameLink(at.linkTarget, install.target)) this.db.prepare("UPDATE skill_installs SET target = ? WHERE id = ?").run(at.linkTarget, install.id);
      }
      this.rules(this.storeUse(facts), facts.usageCounted);
      this.setMeta("ingested", facts.generatedAt ?? now());
    }, "ingest");
    return seeded;
  }

  /**
   * One write transaction for a change the owner asked for. It tries the lock and, while another connection holds it, tries again on a
   * timer for up to WRITE_WAIT_MS, so the wait never holds the event loop and a click during an ingest succeeds once the ingest ends.
   * A disk step a change ran before its write is not run again; only the transaction is retried.
   */
  private async write<T>(fn: () => T, name = "change"): Promise<T> {
    const until = performance.now() + WRITE_WAIT_MS;
    for (let pause = 50; ; pause = Math.min(pause * 2, 500)) {
      try {
        return this.tx(fn, name);
      } catch (error) {
        if (!(error instanceof SkillsBusy) || performance.now() + pause > until) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, pause));
    }
  }

  /**
   * `ingest` in a worker thread with its own connection to chat.sqlite, for the serving process: at box load 234 on 11-22 one ingest held
   * the thread that ran it 6.2 s (a copy of the live DB and inventory), and the old server's ingest after an hourly scan froze every call
   * for 7.2 s in a walk. Pages read the DB as before; WAL readers never wait for the worker's write.
   */
  ingestOffThread(raw: unknown): Promise<{ seeded: boolean; copies: number } | null> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./skills-db-worker.ts", import.meta.url), { workerData: { config: this.config, raw } });
      worker.on("message", (message: { log?: string; result?: { seeded: boolean; copies: number } | null; error?: string }) => {
        if (message.log !== undefined) return this.log(message.log);
        this.bump();
        if (message.error !== undefined) reject(new Error(message.error));
        else resolve(message.result ?? null);
        void worker.terminate();
      });
      worker.on("error", reject);
    });
  }

  /** Each copy's source key, whether its checkout is stale, and its changed lines against its source's canonical text. */
  private derive(): void {
    const stored = this.storedCopies();
    const facts = stored.map(c => c.fact);
    const stale = staleCheckouts(facts);
    const realKey = new Map<string, string>();
    const keyed = facts.map(f => {
      if (f.linkTarget !== null) return { f, key: "" };
      const key = identifyFolder(f).key;
      realKey.set(`${f.box}:${f.realPath}`, key);
      return { f, key };
    });
    for (const entry of keyed) {
      if (entry.f.linkTarget === null) continue;
      entry.key = realKey.get(`${entry.f.box}:${entry.f.realPath}`) ?? identifyFolder({ ...entry.f, path: entry.f.realPath, source: "", checkout: null }).key;
    }
    const copies: CopyFact[] = keyed.map(({ f, key }) => ({ ...f, key, changedLines: null, stale: stale.has(f) }));
    const canon = canonical(copies, this.config.box);
    const texts = this.texts(copies);
    const update = this.db.prepare("UPDATE skill_copies SET skill_key = ?, changed_lines = ?, stale = ? WHERE box = ? AND path = ?");
    for (const c of copies) {
      const source = canon.get(c.key);
      let changed: number | null = null;
      if (source && c.hash && source.hash) {
        if (c.hash === source.hash) changed = 0;
        else {
          const [a, b] = [texts.get(source.hash), texts.get(c.hash)];
          changed = a !== undefined && b !== undefined ? changedLines(a, b) : null;
        }
      }
      update.run(c.key, changed, c.stale ? 1 : 0, c.box, c.path);
    }
  }

  /** The SKILL.md text of each hash: carried by the scan for another box, read from disk on this one. */
  private texts(copies: readonly CopyFact[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of copies) {
      if (!c.hash || out.has(c.hash)) continue;
      if (c.text !== null) out.set(c.hash, c.text);
      else if (c.box === this.config.box && c.skillMd && !c.skillMd.startsWith("harness:")) {
        try {
          out.set(c.hash, readFileSync(c.skillMd, "utf8"));
        } catch {}
      }
    }
    return out;
  }

  /**
   * A box's first good scan: a row for every source on it and an install for every link, so the DB starts as a mirror of the disk and the
   * first apply changes nothing. A box asleep at the first scan is seeded at its first good one.
   */
  private seed(box: string): void {
    const all = this.copies();
    const copies = all.filter(c => c.box === box);
    const canon = canonical(all, this.config.box);
    const addSkill = this.db.prepare("INSERT OR IGNORE INTO skills (id, name, owner, source, created_at) VALUES (?, ?, ?, ?, ?)");
    const at = now();
    for (const c of copies) {
      if (!c.key) continue;
      const base = canon.get(c.key) ?? c;
      const id = c.linkTarget === null ? identifyFolder(base) : identifyFolder({ ...c, path: c.realPath, source: "", checkout: null });
      const source = c.linkTarget === null || canon.has(c.key) ? identifyFolder(base).source : id.source;
      addSkill.run(c.key, base.name, ownerText(seedOwner(source)), JSON.stringify(source), at);
    }
    const placed = new Set(this.installs().map(i => `${i.box}:${i.path}`));
    for (const c of copies.filter(c => c.linkTarget !== null && !placed.has(`${c.box}:${c.path}`))) this.insertInstall(this.linkInstall(c, c.key));
  }

  private linkInstall(c: CopyFact, skillId: string): InstallRecord {
    return {
      id: `inst_${short(`${c.box}:${c.path}`)}`, skillId, box: c.box, path: c.path, mode: "link", target: c.linkTarget ?? "", runtimes: c.runtimes, agent: null,
      appliedHash: c.hash, sourceHash: null, pending: null,
    };
  }

  private insertInstall(i: InstallRecord): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO skill_installs (id, skill_id, box, path, mode, target, runtimes, agent, applied_hash, source_hash, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(i.id, i.skillId, i.box, i.path, i.mode, i.target, JSON.stringify(i.runtimes), i.agent, i.appliedHash, i.sourceHash, i.pending);
  }

  private insertSkill(skill: SkillRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO skills (id, name, owner, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(skill.id, skill.name, ownerText(skill.owner), JSON.stringify(skill.source), skill.createdAt);
  }

  private insertStored(c: StoredCopy): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO skill_copies (box, path, real_path, link_target, hash, lines, bytes, mtime, skill_key, changed_lines, stale, fact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(c.box, c.path, c.fact.realPath, c.fact.linkTarget, c.fact.hash, c.fact.lines, c.fact.bytes, c.fact.mtime, c.key, c.changed, c.stale ? 1 : 0, JSON.stringify(c.fact));
  }

  /** The verdicts and the use counts, recomputed from the copies, the rows and the scan's use. */
  /**
   * Keeps each counted box's use and sums the boxes, so a box whose scan failed, such as the Mac asleep, keeps its last counts in the
   * totals. On 11-22 the Mac slept at 06:00Z and agent-message fell from 46,025 to 43,727 uses until it woke. An inventory from before
   * usageByBox gives its merged use as is.
   */
  private storeUse(facts: Facts): ReadonlyMap<string, FactUse> {
    if (!facts.usageByBox.size) return facts.usage;
    const put = this.db.prepare("INSERT INTO skill_use_box (box, name, use) VALUES (?, ?, ?)");
    for (const [box, byName] of facts.usageByBox) {
      this.db.prepare("DELETE FROM skill_use_box WHERE box = ?").run(box);
      for (const [name, use] of byName) put.run(box, name, JSON.stringify(use));
    }
    const byName = new Map<string, FactUse[]>();
    for (const r of this.db.prepare("SELECT name, use FROM skill_use_box").all() as Row[]) byName.set(s(r.name), [...(byName.get(s(r.name)) ?? []), JSON.parse(s(r.use)) as FactUse]);
    return new Map([...byName].map(([name, parts]) => [name, sumUse(parts)]));
  }

  private rules(usage: ReadonlyMap<string, FactUse>, usageCounted: boolean): void {
    const skills = this.skills();
    const copies = this.copies();
    const canon = canonical(copies, this.config.box);
    const ours = skills.flatMap(skill => {
      const c = canon.get(skill.id);
      return c && !c.stale && (skill.source.kind === "git" || skill.source.kind === "local") && c.skillMd?.endsWith("SKILL.md") ? [c] : [];
    });
    const limits = thresholds(ours);
    const found = verdicts({ skills, copies, canon, texts: this.texts([...canon.values()]), usage, usageCounted, limits });
    this.db.exec("DELETE FROM skill_verdicts");
    const add = this.db.prepare("INSERT INTO skill_verdicts (skill_id, rule, action, detail, copy_id, other) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [skill, rows] of found) for (const v of rows) add.run(skill, v.rule, v.action, v.detail, v.copyId, v.other);
    if (usageCounted) {
      this.db.exec("DELETE FROM skill_use");
      const use = this.db.prepare("INSERT INTO skill_use (name, uses, sessions, last_use, by_kind, by_path) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [name, u] of usage) use.run(name, u.uses30d, u.sessions30d, u.lastUse, JSON.stringify(u.byKind), JSON.stringify(u.byPath));
      this.setMeta("usageCounted", "1");
    }
    this.setMeta("thresholds", JSON.stringify(limits));
  }

  // The read model

  private verdictRows(): Map<string, SkillVerdictRow[]> {
    const out = new Map<string, SkillVerdictRow[]>();
    for (const r of this.db.prepare("SELECT * FROM skill_verdicts").all() as Row[]) {
      const row = { rule: s(r.rule), action: s(r.action), detail: s(r.detail), copyId: sn(r.copy_id), other: sn(r.other) } as SkillVerdictRow;
      out.set(s(r.skill_id), [...(out.get(s(r.skill_id)) ?? []), row]);
    }
    return out;
  }

  private useRows(): Map<string, SkillEntry["use"] & { byPath: PathUse[] }> {
    return new Map((this.db.prepare("SELECT * FROM skill_use").all() as Row[]).map(r => [s(r.name), {
      uses: nn(r.uses) ?? 0, sessions: nn(r.sessions) ?? 0, lastUse: sn(r.last_use), byKind: JSON.parse(s(r.by_kind)), byPath: JSON.parse(sn(r.by_path) ?? "[]") as PathUse[],
    }]));
  }

  private inlined(): string | null {
    if (!this.config.piHostPrompt) return null;
    try {
      return /export const WRITING_SKILL = "([^"]+)"/.exec(readFileSync(this.config.piHostPrompt, "utf8"))?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /** Everything the wanted state and the disk say right now, shared by the view, check, apply and the changes. */
  private state() {
    const skills = this.skills();
    const installs = this.installs();
    const copies = this.copies();
    const scans = this.scans();
    const canon = canonical(copies, this.config.box);
    const skillMap = new Map(skills.map(k => [k.id, k]));
    const installAt = new Map(installs.map(i => [`${i.box}:${i.path}`, i]));
    const copyAt = new Map(copies.map(c => [copyId(c), c]));
    const roles = new Map<string, CopyRole>(copies.map(c => [copyId(c), roleOf(c, skillMap, installAt, canon)]));
    const states = new Map<string, InstallState>(installs.map(i => [i.id, installState(i, copyAt.get(`${i.box}:${i.path}`), scans.find(x => x.box === i.box), canon.get(i.skillId)?.hash ?? null)]));
    return { skills, installs, copies, scans, canon, skillMap, installAt, copyAt, roles, states };
  }

  view(scan: SkillScan): SkillsView {
    return { ...this.viewWithoutScan(), scan };
  }

  /** The view without its scan state, the same object until the DB changes. */
  viewWithoutScan(): Omit<SkillsView, "scan"> {
    if (this.cached?.version !== this.version) this.cached = { version: this.version, view: this.build() };
    return this.cached.view;
  }

  /**
   * The view without its scan state as `listedView` texts, the same object until the DB changes, so GET /api/skills sends kept bytes and
   * the changes since a version until then (compress.ts `sendKeptJson`). The serving process builds it in a worker thread: on us-metal02
   * the build took 136 to 235 ms and its JSON 27 to 33 ms (a copy of the live DB on 11-23), and in the 11-21 to 11-23 request logs 154 of
   * 604 GET /api/skills held the event loop 100 to 400 ms, every call of the server waiting behind it. A worker answered in 269 to 362 ms
   * with its start.
   */
  viewListed(): Promise<ListedView> {
    if (this.built?.version !== this.version) {
      const listed = this.viewsOffThread ? this.viewOffThread() : Promise.resolve(listedView(this.viewWithoutScan()));
      const built = { version: this.version, listed };
      this.built = built;
      listed.catch(() => {
        if (this.built === built) this.built = null;
      });
    }
    return this.built.listed;
  }

  /** Called after each change of the DB; http.ts makes the page's first answer of the new view then, before any read asks for it. */
  onChange: (() => void) | null = null;

  /** A change to the DB: a view built in a worker is built again at once, so the next read of the page finds it ready. */
  private bump(): void {
    this.version++;
    if (this.viewsOffThread && this.built) setImmediate(() => void this.viewListed().catch(() => undefined));
    if (this.onChange) setImmediate(this.onChange);
  }

  private viewOffThread(): Promise<ListedView> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./skills-db-worker.ts", import.meta.url), { workerData: { config: this.config, view: true } });
      worker.on("message", (message: { log?: string; view?: ListedView; error?: string }) => {
        if (message.log !== undefined) return this.log(message.log);
        if (message.error !== undefined) reject(new Error(message.error));
        else resolve(message.view!);
        void worker.terminate();
      });
      worker.on("error", reject);
    });
  }

  private build(): Omit<SkillsView, "scan"> {
    const st = this.state();
    const verdictRows = this.verdictRows();
    const use = this.useRows();
    const usageCounted = this.meta("usageCounted") === "1";
    const limits = JSON.parse(this.meta("thresholds") ?? "null") as SkillThresholds | null ?? thresholds([]);
    const settings = st.scans.find(x => x.box === this.config.box)?.settings ?? null;
    const inlined = this.inlined();
    const copyView = (c: CopyFact): SkillCopy => ({
      id: copyId(c), box: c.box, path: c.path, role: st.roles.get(copyId(c)) ?? "unowned", installId: st.installAt.get(copyId(c))?.id ?? null, link: c.linkTarget,
      realPath: c.realPath, exists: c.exists, hash: c.hash, lines: c.lines, bytes: c.bytes, folderBytes: c.folderBytes ?? null, files: c.files, mtime: c.mtime, loadedBy: c.runtimes, changedLines: c.changedLines,
      checkout: c.checkout ? { root: c.checkout.root, branch: c.checkout.branch, headAt: c.checkout.headAt, stale: c.stale } : null,
    });
    const byKey = new Map<string, CopyFact[]>();
    for (const c of st.copies) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
    const installsOf = new Map<string, InstallRecord[]>();
    for (const i of st.installs) installsOf.set(i.skillId, [...(installsOf.get(i.skillId) ?? []), i]);
    const entries: SkillEntry[] = st.skills.map(skill => {
      const canon = st.canon.get(skill.id);
      const own = [...(byKey.get(skill.id) ?? [])];
      for (const i of installsOf.get(skill.id) ?? []) {
        const at = st.copyAt.get(`${i.box}:${i.path}`);
        if (at && !own.includes(at)) own.push(at);
      }
      const found = use.get(skill.name);
      const u = found ? { uses: found.uses, sessions: found.sessions, lastUse: found.lastUse, byKind: found.byKind } : { uses: 0, sessions: 0, lastUse: null, byKind: {} };
      return {
        id: skill.id, name: skill.name, description: canon?.description ?? own[0]?.description ?? "", owner: skill.owner, source: skill.source,
        installs: (installsOf.get(skill.id) ?? []).map(i => ({ id: i.id, box: i.box, path: i.path, mode: i.mode, runtimes: i.runtimes, agent: i.agent, state: st.states.get(i.id)! })),
        copies: own.map(copyView),
        size: { lines: canon?.lines ?? null, bytes: canon?.bytes ?? null, ratio: canon?.bytes != null && limits.medianBytes ? Math.round((canon.bytes / limits.medianBytes) * 100) / 100 : null },
        verdicts: verdictRows.get(skill.id) ?? [],
        use: u,
        preimported: own.some(c => c.box === this.config.box && c.pythonImport !== null && (c.source === "prime-links" || c.source === "prime-release")),
        sees: sees(skill.name, own.filter(c => c.box === this.config.box), settings, inlined),
        extraCopies: extraCopies(own.filter(c => c.key === skill.id), canon).map(x => ({ copyId: copyId(x.copy), keptId: copyId(x.kept), why: x.why })),
      };
    });
    const home = (box: string): string | null => {
      try {
        return this.homeOf(box, st.copies);
      } catch {
        return null;
      }
    };
    const homes = new Map(st.scans.map(scan => [scan.box, home(scan.box)]));
    creditUse(entries, new Map([...use].map(([name, u]) => [name, u.byPath])), box => homes.get(box) ?? null);
    const unowned = st.copies.filter(c => st.roles.get(copyId(c)) === "unowned").map(copyView);
    const items = drift(st.copies, st.roles, st.installs, st.states, st.skills);
    const has = (e: SkillEntry, rules: readonly VerdictRule[]) => e.verdicts.some(v => rules.includes(v.rule));
    const counts: SkillCounts = {
      skills: entries.length, copies: st.copies.length, installs: st.installs.length,
      duplicated: entries.filter(e => has(e, COUNT_RULES.duplicated)).length,
      outdated: entries.filter(e => has(e, COUNT_RULES.outdated)).length,
      bloated: entries.filter(e => has(e, COUNT_RULES.bloated)).length,
      neverUsed: usageCounted ? entries.filter(e => e.source.kind !== "harness" && e.use.uses === 0).length : 0,
      drift: items.length,
    };
    const boxes: SkillBoxState[] = st.scans.map(scan => this.boxState(scan, st.copies.filter(c => c.box === scan.box)));
    return { generatedAt: this.meta("ingested"), seededAt: this.meta("seeded"), counts, thresholds: limits, boxes, skills: entries, unowned };
  }

  private boxState(scan: BoxScan, copies: CopyFact[]): SkillBoxState {
    const state = scan.ok ? "ok" : scan.lastOkAt ? "offline" : "never";
    return { box: scan.box, state, scannedAt: scan.attemptedAt, lastOkAt: scan.lastOkAt, since: scan.ok ? null : scan.since, seconds: scan.seconds, error: scan.error, tree: tree(copies) };
  }

  check(): SkillsCheck {
    const st = this.state();
    return { at: now(), items: drift(st.copies, st.roles, st.installs, st.states, st.skills), offline: st.scans.filter(x => !x.ok).map(x => x.box) };
  }

  moves(): SkillMove[] {
    return (this.db.prepare("SELECT id, at, kind, summary, undone_at FROM skill_moves ORDER BY at DESC LIMIT 200").all() as Row[]).map(r => ({
      id: s(r.id), at: s(r.at), kind: s(r.kind) as SkillMove["kind"], summary: s(r.summary), undoneAt: sn(r.undone_at),
    }));
  }

  /** The review's rows with the rule verdicts as their `useful` field, so the review app proposes what the rules propose. */
  overlay(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const acting = new Map<string, SkillVerdictRow>();
    for (const list of this.verdictRows().values()) for (const v of list) if (v.copyId && (v.action === "remove" || v.action === "merge")) acting.set(v.copyId, v);
    const names = new Map(this.skills().map(k => [k.id, k.name]));
    return rows.map(row => {
      const box = String(row.box ?? "");
      const ids = [String(row.id ?? ""), `${box}:${String(row.dir ?? "")}`, ...(Array.isArray(row.links) ? row.links.map(l => `${box}:${String(l)}`) : [])];
      const v = ids.map(id => acting.get(id)).find(Boolean);
      const useful = v
        ? { verdict: v.action, reason: `${v.rule}: ${v.detail}`, mergeInto: v.action === "merge" ? names.get(v.other ?? "") ?? v.other : null, action: true }
        : { verdict: null, reason: null, mergeInto: null, action: false };
      return { ...row, useful };
    });
  }

  // Changes

  private snapshot(keys: { skills?: string[]; installs?: string[]; copies?: string[] }): Snapshot {
    const skillSet = new Set(keys.skills ?? []);
    const installSet = new Set(keys.installs ?? []);
    const copySet = new Set(keys.copies ?? []);
    return {
      skills: this.skills().filter(k => skillSet.has(k.id)),
      installs: this.installs().filter(i => installSet.has(i.id)),
      copies: this.storedCopies().filter(c => copySet.has(copyId(c))),
    };
  }

  private record(kind: SkillMove["kind"], summary: string, item: string | null, before: Snapshot, touched: Touched, id = newMove()): SkillMove {
    const move: SkillMove = { id, at: now(), kind, summary, undoneAt: null };
    this.db.prepare("INSERT INTO skill_moves (id, at, kind, summary, item, before, touched, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(move.id, move.at, kind, summary, item, JSON.stringify(before), JSON.stringify(touched));
    this.bump();
    return move;
  }

  /** Refuses a path outside the box's home folder, such as a metal path given for the Mac, which no step there can create. */
  private inHome(box: string, path: string, home: string): void {
    if (!path.startsWith("/") || path.split("/").includes("..")) throw new SkillsRefused(`${path} is not an absolute path.`);
    if (path !== home && !path.startsWith(`${home}/`)) throw new SkillsRefused(`${path} is outside ${box}'s home ${home}.`);
  }

  private homeOf(box: string, copies: readonly CopyFact[]): string {
    if (box === this.config.box) return this.config.home;
    for (const c of copies) {
      const m = c.box === box ? /^(.*)\/\.(?:prime\/agent|claude|codex)\/skills$/.exec(c.root) : null;
      if (m) return m[1]!;
    }
    throw new SkillsRefused(`No scan of ${box} names its home folder yet.`);
  }

  /** Makes the disk match the installs: creates what is missing, points wrong links back and refreshes copies left behind. */
  async apply(opts: { dryRun?: boolean; only?: string[]; moveId?: string; kind?: SkillMove["kind"]; summary?: string; before?: Snapshot; touched?: Touched; keepFailures?: boolean } = {}): Promise<ApplyResult> {
    const st = this.state();
    // An install of a skill whose git folder left main is not put back; `sw skills remove` settles it.
    const gone = new Set(goneSkills(st.skills, st.copies).map(skill => skill.id));
    const installs = st.installs.filter(i => !gone.has(i.skillId) && (!opts.only || opts.only.includes(i.id)));
    const pending = installs.filter(i => i.pending);
    const planned = plan(installs, st.states);
    const queuedNote = pending.map(i => ({ installId: i.id, box: i.box, path: i.path, step: "create" as const, result: "queued" as const, note: `Waits for ${i.box} (move ${i.pending}).` }));
    if (opts.dryRun || !planned.length) {
      return { at: now(), dryRun: !!opts.dryRun, changes: planned.length, steps: [...planned.map(p => ({ ...p, result: "planned" as const, note: null })), ...(opts.dryRun ? queuedNote : [])], moveId: null };
    }
    const moveId = opts.moveId ?? newMove();
    const item = `sw:${moveId}`;
    const byId = new Map(st.installs.map(i => [i.id, i]));
    const disk: DiskStep[] = [];
    for (const p of planned) {
      const i = byId.get(p.installId)!;
      const skill = st.skillMap.get(i.skillId);
      const name = skill?.name ?? i.path.split("/").at(-1)!;
      if (p.step !== "create") disk.push({ kind: "delete", box: i.box, path: i.path, name });
      const from = i.mode === "copy" ? this.copySource(i, st) : i.target;
      disk.push({ kind: "place", box: i.box, path: i.path, name, mode: i.mode, from });
    }
    const touchedCopies = planned.map(p => `${p.box}:${p.path}`);
    const before = opts.before ?? this.snapshot({ installs: planned.map(p => p.installId), copies: touchedCopies });
    const results = await this.disk.run(item, disk);
    const steps: ApplyStep[] = [];
    await this.write(() => {
      for (const p of planned) {
        const i = byId.get(p.installId)!;
        const placed = results.filter(r => r.box === i.box && r.path === i.path).at(-1);
        const result: ApplyStep["result"] = placed?.state === "applied" ? "done" : placed?.state === "queued" ? "queued" : "failed";
        steps.push({ ...p, result, note: placed?.note ?? null });
        if (result === "done") this.placedFact(i, st);
        if (result === "queued") this.db.prepare("UPDATE skill_installs SET pending = ? WHERE id = ?").run(moveId, i.id);
      }
      const summary = opts.summary ?? `apply: ${steps.filter(x => x.result !== "failed").length} of ${steps.length} steps`;
      this.record(opts.kind ?? "apply", summary, item, before, { skills: opts.touched?.skills ?? [], installs: opts.touched?.installs ?? [], copies: [...(opts.touched?.copies ?? []), ...touchedCopies] }, moveId);
    });
    const failed = failure("apply", moveId, results);
    if (failed && !opts.keepFailures) throw failed;
    return { at: now(), dryRun: false, changes: steps.filter(x => x.result !== "failed").length, steps, moveId };
  }

  /** The folder a copy install is made from: the canonical copy on the install's box, else any copy of the source there. */
  private copySource(i: InstallRecord, st: ReturnType<SkillsDb["state"]>): string {
    const canon = st.canon.get(i.skillId);
    if (canon && canon.box === i.box) return canon.realPath;
    const here = st.copies.find(c => c.key === i.skillId && c.box === i.box && c.linkTarget === null && !c.stale);
    if (!here) throw new SkillsRefused(`No copy of ${i.skillId} on ${i.box} to copy from.`);
    return here.realPath;
  }

  /** Records what a placed step left on disk, so the next apply finds it there before the next scan does. */
  private placedFact(i: InstallRecord, st: ReturnType<SkillsDb["state"]>): void {
    const source = st.canon.get(i.skillId);
    const name = st.skillMap.get(i.skillId)?.name ?? i.path.split("/").at(-1)!;
    const fact: FactCopy = {
      box: i.box, path: i.path, realPath: i.mode === "link" ? source?.realPath ?? i.target : i.path, linkTarget: i.mode === "link" ? i.target : null, exists: true, name,
      description: source?.description ?? "", source: "sw-install", root: dirname(i.path), how: "sw skills install", runtimes: i.runtimes, hash: source?.hash ?? null,
      lines: source?.lines ?? null, bytes: source?.bytes ?? null, folderBytes: source?.folderBytes ?? null, files: source?.files ?? null, mtime: now(), skillMd: i.mode === "link" ? source?.skillMd ?? null : `${i.path}/SKILL.md`,
      checkout: null, dmi: source?.dmi ?? false, pythonImport: source?.pythonImport ?? null, deadRefs: [], text: null,
    };
    this.insertStored({ box: i.box, path: i.path, fact, key: i.skillId, changed: 0, stale: false });
    if (i.mode === "copy") this.db.prepare("UPDATE skill_installs SET applied_hash = ?, source_hash = ? WHERE id = ?").run(source?.hash ?? null, source?.hash ?? null, i.id);
  }

  async install(body: InstallBody): Promise<SkillsChange> {
    const st = this.state();
    const skill = this.pickSkill(st.skills, body.name, body.source ?? null);
    const runtime = body.runtime;
    if (!isRuntime(runtime)) throw new SkillsRefused(`A runtime is one of ${SKILL_RUNTIMES.join(", ")}.`);
    const mode = body.mode ?? "link";
    const home = this.homeOf(body.box, st.copies);
    const path = body.path ?? `${runtimeFolder(home, runtime)}/${skill.name}`;
    this.inHome(body.box, path, home);
    const existing = st.installAt.get(`${body.box}:${path}`);
    if (existing && existing.skillId !== skill.id) throw new SkillsRefused(`${body.box}:${path} is ${existing.skillId}'s install ${existing.id}; remove it first.`);
    const onDisk = st.copyAt.get(`${body.box}:${path}`);
    if (!existing && onDisk) throw new SkillsRefused(`${body.box}:${path} already holds a folder; adopt it with sw skills adopt ${copyId(onDisk)} or remove it first.`);
    if (existing) {
      const apply = await this.apply({ only: [existing.id] });
      return { move: this.record("install", `install ${skill.name} on ${body.box}: already there`, null, emptySnapshot(), emptyTouched()), apply };
    }
    const target = mode === "link" ? this.linkTarget(skill.id, body.box, st) : this.copySource({ skillId: skill.id, box: body.box } as InstallRecord, st);
    const install: InstallRecord = {
      id: `inst_${short(`${body.box}:${path}`)}`, skillId: skill.id, box: body.box, path, mode, target, runtimes: runtimesAt(home, path), agent: body.agent ?? null,
      appliedHash: null, sourceHash: null, pending: null,
    };
    const moveId = newMove();
    await this.write(() => this.insertInstall(install));
    const apply = await this.apply({
      only: [install.id], moveId, kind: "install", summary: `install ${skill.name} on ${body.box} at ${path} (${mode})`,
      before: emptySnapshot(), touched: { skills: [], installs: [install.id], copies: [] }, keepFailures: true,
    });
    const failed = apply.steps.filter(x => x.result === "failed");
    if (failed.length) {
      await this.write(() => {
        this.db.prepare("DELETE FROM skill_installs WHERE id = ?").run(install.id);
        this.db.prepare("DELETE FROM skill_copies WHERE box = ? AND path = ?").run(install.box, install.path);
        this.db.prepare("UPDATE skill_moves SET undone_at = ? WHERE id = ?").run(now(), moveId);
      });
      throw new SkillsStepFailed(`install of ${skill.name} on ${body.box} failed, so no install row stays (move ${moveId}): ${failed.map(x => x.note ?? "no reason given").join("; ")}`);
    }
    return { move: this.moveById(moveId) ?? this.record("install", `install ${skill.name}`, null, emptySnapshot(), { skills: [], installs: [install.id], copies: [] }, moveId), apply };
  }

  /** What a new link on a box points at: where the skill's other links there point, else its copy there. */
  private linkTarget(skillId: string, box: string, st: ReturnType<SkillsDb["state"]>): string {
    const sibling = st.installs.find(i => i.skillId === skillId && i.box === box && i.mode === "link" && i.target.startsWith("/"));
    if (sibling) return sibling.target;
    const canon = st.canon.get(skillId);
    if (canon?.box === box) return canon.realPath;
    const here = st.copies.find(c => c.key === skillId && c.box === box && c.linkTarget === null && !c.stale);
    if (!here) throw new SkillsRefused(`No copy of ${skillId} on ${box} to link to; check out its source there first.`);
    return here.realPath;
  }

  private pickSkill(skills: readonly SkillRecord[], name: string, id: string | null): SkillRecord {
    if (id) {
      const found = skills.find(k => k.id === id);
      if (!found) throw new SkillsRefused(`No skill ${id}.`);
      return found;
    }
    const named = skills.filter(k => k.name === name);
    if (!named.length) throw new SkillsRefused(`No skill named ${name}.`);
    const ours = named.filter(k => k.source.kind === "git" && k.source.repo === "sieun-pi");
    const git = named.filter(k => k.source.kind === "git");
    const pick = named.length === 1 ? named[0] : ours.length === 1 ? ours[0] : git.length === 1 ? git[0] : undefined;
    if (pick) return pick;
    throw new SkillsRefused(`${named.length} skills are named ${name}; pass one of ${named.map(k => k.id).join(", ")} as source.`);
  }

  async remove(body: RemoveBody): Promise<SkillsChange> {
    const st = this.state();
    const target = body.target;
    const install = st.installs.find(i => i.id === target) ?? st.installAt.get(target);
    const skill = st.skillMap.get(target);
    const copy = st.copyAt.get(target);
    let steps: { box: string; path: string; name: string }[];
    let installs: InstallRecord[];
    let dropSkills: string[] = [];
    let summary: string;
    if (install) {
      installs = [install];
      steps = [{ box: install.box, path: install.path, name: st.skillMap.get(install.skillId)?.name ?? "" }];
      summary = `remove install ${install.id} at ${install.box}:${install.path}`;
    } else if (skill) {
      installs = st.installs.filter(i => i.skillId === skill.id);
      const canon = st.canon.get(skill.id);
      const rel = skill.source.kind === "git" ? skill.source.path : null;
      const mirrors = st.copies.filter(c => c.key === skill.id && c.linkTarget === null && c !== canon && rel !== null && c.box !== canon?.box && c.path.endsWith(`/${rel}`) && !c.stale);
      // A source in a stale checkout is an old clone or worktree of a skill its repo dropped; removing the row leaves that checkout alone.
      const source = canon && !canon.stale ? [canon] : [];
      steps = [...installs.map(i => ({ box: i.box, path: i.path, name: skill.name })), ...source.map(c => ({ box: c.box, path: c.path, name: skill.name })), ...mirrors.map(c => ({ box: c.box, path: c.path, name: skill.name }))];
      dropSkills = [skill.id];
      summary = `remove skill ${skill.id}: ${installs.length} installs and its source`;
    } else if (copy) {
      installs = [];
      steps = [{ box: copy.box, path: copy.path, name: copy.name }];
      const left = st.copies.filter(c => c.key === copy.key && c.linkTarget === null && c !== copy);
      if (copy.linkTarget === null && !left.length && st.skillMap.has(copy.key)) dropSkills = [copy.key];
      summary = `remove ${copyId(copy)}`;
    } else throw new SkillsRefused(`No skill, install or copy ${target}; a copy id is <box>:<path> as GET /api/skills lists it.`);
    const moveId = newMove();
    const item = `sw:${moveId}`;
    const copyKeys = steps.map(x => `${x.box}:${x.path}`);
    const before = this.snapshot({ skills: dropSkills, installs: [...installs.map(i => i.id), ...(dropSkills.length ? st.installs.filter(i => dropSkills.includes(i.skillId)).map(i => i.id) : [])], copies: copyKeys });
    const results = await this.disk.run(item, steps.map(x => ({ kind: "delete" as const, ...x })));
    const failed = results.filter(r => r.state === "failed");
    await this.write(() => {
      for (const r of results) if (r.state === "applied") this.db.prepare("DELETE FROM skill_copies WHERE box = ? AND path = ?").run(r.box, r.path);
      if (!failed.length) {
        for (const i of before.installs) this.db.prepare("DELETE FROM skill_installs WHERE id = ?").run(i.id);
        for (const id of dropSkills) this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
      }
      this.record("remove", failed.length ? `${summary} (${failed.length} steps failed)` : summary, item, before, { skills: dropSkills, installs: before.installs.map(i => i.id), copies: copyKeys }, moveId);
    });
    const error = failure("remove", moveId, results);
    if (error) throw error;
    return { move: this.moveById(moveId)!, apply: diskResult(moveId, results, () => "delete") };
  }

  async adopt(body: AdoptBody): Promise<SkillsChange> {
    const st = this.state();
    const copy = st.copyAt.get(body.copyId);
    if (!copy) throw new SkillsRefused(`No copy ${body.copyId} in the last scan.`);
    const install = st.installAt.get(body.copyId);
    const moveId = newMove();
    if (install) {
      const state = st.states.get(install.id);
      if (state?.kind !== "changed" && state?.kind !== "wrong-link") throw new SkillsRefused(`${body.copyId} is install ${install.id} and matches the disk already.`);
      const before = this.snapshot({ installs: [install.id] });
      await this.write(() => {
        if (install.mode === "link") this.db.prepare("UPDATE skill_installs SET target = ? WHERE id = ?").run(copy.linkTarget ?? install.target, install.id);
        else this.db.prepare("UPDATE skill_installs SET applied_hash = ?, source_hash = ? WHERE id = ?").run(copy.hash, st.canon.get(install.skillId)?.hash ?? null, install.id);
        this.record("adopt", `adopt the disk's ${body.copyId} into install ${install.id}`, null, before, { skills: [], installs: [install.id], copies: [] }, moveId);
      });
      return { move: this.moveById(moveId)!, apply: null };
    }
    if (st.roles.get(body.copyId) !== "unowned") throw new SkillsRefused(`${body.copyId} already belongs to ${copy.key}.`);
    const skillId = body.skillId ?? copy.key;
    const known = st.skillMap.get(skillId);
    const identity = copy.linkTarget === null ? identifyFolder(copy) : identifyFolder({ ...copy, path: copy.realPath, source: "", checkout: null });
    const newSkill: SkillRecord | null = known ? null : { id: skillId, name: copy.name, owner: seedOwner(identity.source), source: identity.source, createdAt: now() };
    if (newSkill && body.skillId && body.skillId !== copy.key) throw new SkillsRefused(`No skill ${body.skillId}.`);
    const link = copy.linkTarget !== null ? this.linkInstall(copy, skillId) : null;
    // A new skill's source takes the links that already point at it, such as prime-sync's on each box, so one adopt leaves no drift.
    const links = link ? [link] : newSkill ? st.copies.filter(c => c.linkTarget !== null && c.key === skillId && st.roles.get(copyId(c)) === "unowned").map(c => this.linkInstall(c, skillId)) : [];
    await this.write(() => {
      if (newSkill) this.insertSkill(newSkill);
      for (const l of links) this.insertInstall(l);
      const what = link ? `install ${link.id} of ${skillId}` : `the source of ${skillId}${links.length ? ` with ${links.length} linked installs` : ""}`;
      this.record("adopt", `adopt ${body.copyId} as ${what}`, null, emptySnapshot(), { skills: newSkill ? [newSkill.id] : [], installs: links.map(l => l.id), copies: [] }, moveId);
    });
    return { move: this.moveById(moveId)!, apply: null };
  }

  async move(body: MoveBody): Promise<SkillsChange> {
    const st = this.state();
    const install = st.installs.find(i => i.id === body.installId);
    if (!install) throw new SkillsRefused(`No install ${body.installId}.`);
    if (install.path === body.path) throw new SkillsRefused(`${install.id} is at ${body.path} already.`);
    const home = this.homeOf(install.box, st.copies);
    this.inHome(install.box, body.path, home);
    const runtimes = runtimesAt(home, body.path);
    if (st.installAt.has(`${install.box}:${body.path}`) || st.copyAt.has(`${install.box}:${body.path}`)) throw new SkillsRefused(`${install.box}:${body.path} already holds a folder.`);
    const name = st.skillMap.get(install.skillId)?.name ?? "";
    const moveId = newMove();
    const item = `sw:${moveId}`;
    const from = install.mode === "copy" ? this.copySource(install, st) : install.target;
    const copies = [`${install.box}:${install.path}`, `${install.box}:${body.path}`];
    const before = this.snapshot({ installs: [install.id], copies });
    const steps: DiskStep[] = [
      { kind: "place", box: install.box, path: body.path, name, mode: install.mode, from },
      { kind: "delete", box: install.box, path: install.path, name },
    ];
    const results = await this.disk.run(item, steps);
    const ok = results.every(r => r.state === "applied" || r.state === "queued");
    await this.write(() => {
      if (ok) {
        this.db.prepare("UPDATE skill_installs SET path = ?, runtimes = ? WHERE id = ?").run(body.path, JSON.stringify(runtimes), install.id);
        this.db.prepare("DELETE FROM skill_copies WHERE box = ? AND path = ?").run(install.box, install.path);
        if (results.every(r => r.state === "applied")) this.placedFact({ ...install, path: body.path, runtimes }, st);
      }
      this.record("move", `move ${install.id} from ${install.path} to ${body.path}${ok ? "" : " (failed)"}`, item, before, { skills: [], installs: [install.id], copies }, moveId);
    });
    const error = failure("move", moveId, results);
    if (error) throw error;
    return { move: this.moveById(moveId)!, apply: diskResult(moveId, results, i => shownStep(steps[i]!)) };
  }

  /** Hands agent factory the merge of one skill into another; the agent checks it, moves the lines, then removes the first with sw skills remove. */
  async merge(body: MergeBody): Promise<SkillsChange> {
    const st = this.state();
    const from = st.skillMap.get(body.skillId);
    const into = st.skillMap.get(body.into);
    if (!from || !into) throw new SkillsRefused(`No skill ${from ? body.into : body.skillId}.`);
    const canon = st.canon.get(from.id);
    if (!canon) throw new SkillsRefused(`${from.id} has no copy on disk to merge.`);
    const reason = st.canon.get(into.id) ? `Merge ${from.id} into ${into.id}, whose source is ${copyId(st.canon.get(into.id)!)}.` : `Merge ${from.id} into ${into.id}.`;
    const moveId = newMove();
    const item = `sw:${moveId}`;
    const results = await this.disk.run(item, [{ kind: "fold", box: canon.box, path: canon.path, name: from.name, into: into.id, reason }]);
    await this.write(() => this.record("merge", `merge ${from.id} into ${into.id}`, item, emptySnapshot(), emptyTouched(), moveId));
    return { move: this.moveById(moveId)!, apply: diskResult(moveId, results, () => "fold") };
  }

  async own(body: OwnBody): Promise<SkillsChange> {
    const skill = this.skills().find(k => k.id === body.skillId);
    if (!skill) throw new SkillsRefused(`No skill ${body.skillId}.`);
    if (!body.owner || !/^(owner|ag_[\w-]+)$/.test(body.owner)) throw new SkillsRefused("An owner is `owner` or an agent id such as ag_agent-factory.");
    const moveId = newMove();
    const before = this.snapshot({ skills: [skill.id] });
    await this.write(() => {
      this.db.prepare("UPDATE skills SET owner = ? WHERE id = ?").run(body.owner, skill.id);
      this.record("own", `${skill.id} now belongs to ${body.owner}`, null, before, { skills: [skill.id], installs: [], copies: [] }, moveId);
    });
    return { move: this.moveById(moveId)!, apply: null };
  }

  /** Puts a move back: the review restores its disk steps from their backups, and the rows and facts it changed return to before. */
  async undo(body: UndoBody): Promise<SkillsChange> {
    const move = this.moveRow(body.moveId);
    if (!move) throw new SkillsRefused(`No move ${body.moveId}.`);
    if (move.undoneAt) return { move, apply: null };
    const results = move.item ? await this.disk.undo(move.item) : [];
    const failed = results.filter(r => r.state === "failed");
    await this.write(() => {
      if (!failed.length) {
        for (const id of move.touched.skills) this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
        for (const id of move.touched.installs) this.db.prepare("DELETE FROM skill_installs WHERE id = ?").run(id);
        for (const key of move.touched.copies) {
          const at = key.indexOf(":");
          this.db.prepare("DELETE FROM skill_copies WHERE box = ? AND path = ?").run(key.slice(0, at), key.slice(at + 1));
        }
        for (const k of move.before.skills) this.insertSkill(k);
        for (const i of move.before.installs) this.insertInstall(i);
        for (const c of move.before.copies) this.insertStored(c);
        this.db.prepare("UPDATE skill_moves SET undone_at = ? WHERE id = ?").run(now(), move.id);
      }
    });
    const error = failure("undo", move.id, results);
    if (error) throw error;
    return { move: this.moveById(move.id)!, apply: diskResult(move.id, results, () => "restore") };
  }

  private moveRow(id: string): MoveRow | null {
    const r = this.db.prepare("SELECT * FROM skill_moves WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: s(r.id), at: s(r.at), kind: s(r.kind) as SkillMove["kind"], summary: s(r.summary), undoneAt: sn(r.undone_at), item: sn(r.item),
      before: JSON.parse(s(r.before)) as Snapshot, touched: JSON.parse(s(r.touched)) as Touched,
    };
  }

  private moveById(id: string): SkillMove | null {
    const row = this.moveRow(id);
    return row ? { id: row.id, at: row.at, kind: row.kind, summary: row.summary, undoneAt: row.undoneAt } : null;
  }
}

/** Sleeps this thread. `land` runs in the ingest worker, where no event loop waits on it; the fixture's inline ingest lands in one transaction. */
const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const newMove = (): string => `mv_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const emptySnapshot = (): Snapshot => ({ skills: [], installs: [], copies: [] });
const emptyTouched = (): Touched => ({ skills: [], installs: [], copies: [] });

/** The apply step a disk step reads as: placing a folder creates it. */
const shownStep = (step: DiskStep): ApplyStep["step"] => (step.kind === "place" ? "create" : step.kind);

/** `stepOf(i)` names the step of `results[i]`, as the disk runs one result per step in order. */
function diskResult(moveId: string, results: DiskResult[], stepOf: (index: number) => ApplyStep["step"]): ApplyResult {
  return {
    at: now(), dryRun: false, changes: results.filter(r => r.state === "applied" || r.state === "queued" || r.state === "undone").length, moveId,
    steps: results.map((r, i) => ({
      installId: "", box: r.box, path: r.path, step: stepOf(i),
      result: r.state === "applied" || r.state === "undone" ? "done" : r.state === "queued" ? "queued" : r.state === "pending" ? "planned" : "failed", note: r.note,
    })),
  };
}
