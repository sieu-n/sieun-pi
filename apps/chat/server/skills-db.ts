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
import { DatabaseSync } from "node:sqlite";
import {
  COUNT_RULES, SKILL_RUNTIMES, type VerdictRule, type AdoptBody, type ApplyResult, type ApplyStep, type CopyRole, type InstallBody, type InstallState, type MergeBody, type MoveBody,
  type OwnBody, type RemoveBody, type SkillBoxState, type SkillCopy, type SkillCounts, type SkillEntry, type SkillMove, type SkillOwner, type SkillRuntime,
  type SkillScan, type SkillSource, type SkillsChange, type SkillsCheck, type SkillsView, type SkillThresholds, type SkillVerdictRow, type UndoBody,
} from "../web/src/lib/api/shared/skills.ts";
import {
  canonical, changedLines, copyId, drift, identifyFolder, installState, ownerText, parseFacts, parseOwner, plan, roleOf, sameLink, seedOwner, sees, staleCheckouts,
  thresholds, tree, verdicts, type BoxScan, type CopyFact, type FactCopy, type FactUse, type InstallRecord, type SkillRecord,
} from "./skills-model.ts";

export type SkillsDbConfig = {
  /** The sw factory DB file, <data dir>/chat.sqlite. */
  file: string;
  /** The box this server runs on, whose files it reads and writes itself. */
  box: string;
  home: string;
  /** The installed pi-host release's prime-prompt.ts, whose WRITING_SKILL names the skill every sw factory thread gets in full. */
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

/** A disk step that did not take effect; the change answers an error with the step's reason, and its move stays for undo. */
export class SkillsStepFailed extends Error {}

function failure(what: string, moveId: string, results: readonly { box: string; path: string; note: string | null; state: string }[]): SkillsStepFailed | null {
  const failed = results.filter(r => r.state === "failed");
  if (!failed.length) return null;
  return new SkillsStepFailed(`${what} failed on ${failed.length} of ${results.length} steps (move ${moveId}): ${failed.map(r => `${r.box}:${r.path}: ${r.note ?? "no reason given"}`).join("; ")}`);
}

type StoredCopy = { box: string; path: string; fact: FactCopy; key: string; changed: number | null; stale: boolean };
type Snapshot = { skills: SkillRecord[]; installs: InstallRecord[]; copies: StoredCopy[] };
type Touched = { skills: string[]; installs: string[]; copies: string[] };
type MoveRow = SkillMove & { item: string | null; before: Snapshot; touched: Touched };

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
CREATE TABLE IF NOT EXISTS skill_moves (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, item TEXT, before TEXT NOT NULL, touched TEXT NOT NULL, undone_at TEXT
);
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

const RUNTIMES_OF: Record<SkillRuntime, SkillRuntime[]> = { prime: ["prime", "pi-host"], "pi-host": ["prime", "pi-host"], claude: ["claude"], codex: ["codex"], pi: ["pi"] };

export class SkillsDb {
  private readonly db: DatabaseSync;
  private version = 0;
  private cached: { version: number; view: Omit<SkillsView, "scan"> } | null = null;

  constructor(private readonly config: SkillsDbConfig, private readonly disk: DiskSteps, private readonly log: (line: string) => void = () => {}) {
    mkdirSync(dirname(config.file), { recursive: true });
    this.db = new DatabaseSync(config.file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
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

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this.version++;
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
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
   */
  ingest(raw: unknown): { seeded: boolean; copies: number } | null {
    const facts = parseFacts(raw);
    if (!facts) return null;
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
      this.rules(facts.usage, facts.usageCounted);
      this.setMeta("ingested", facts.generatedAt ?? now());
    });
    return { seeded, copies: facts.copies.length };
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
      const use = this.db.prepare("INSERT INTO skill_use (name, uses, sessions, last_use, by_kind) VALUES (?, ?, ?, ?, ?)");
      for (const [name, u] of usage) use.run(name, u.uses30d, u.sessions30d, u.lastUse, JSON.stringify(u.byKind));
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

  private useRows(): Map<string, SkillEntry["use"]> {
    return new Map((this.db.prepare("SELECT * FROM skill_use").all() as Row[]).map(r => [s(r.name), { uses: nn(r.uses) ?? 0, sessions: nn(r.sessions) ?? 0, lastUse: sn(r.last_use), byKind: JSON.parse(s(r.by_kind)) }]));
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
    if (this.cached?.version !== this.version) this.cached = { version: this.version, view: this.build() };
    return { ...this.cached.view, scan };
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
      const u = use.get(skill.name) ?? { uses: 0, sessions: 0, lastUse: null, byKind: {} };
      return {
        id: skill.id, name: skill.name, description: canon?.description ?? own[0]?.description ?? "", owner: skill.owner, source: skill.source,
        installs: (installsOf.get(skill.id) ?? []).map(i => ({ id: i.id, box: i.box, path: i.path, mode: i.mode, runtimes: i.runtimes, agent: i.agent, state: st.states.get(i.id)! })),
        copies: own.map(copyView),
        size: { lines: canon?.lines ?? null, bytes: canon?.bytes ?? null, ratio: canon?.bytes != null && limits.medianBytes ? Math.round((canon.bytes / limits.medianBytes) * 100) / 100 : null },
        verdicts: verdictRows.get(skill.id) ?? [],
        use: u,
        preimported: own.some(c => c.box === this.config.box && c.pythonImport !== null && (c.source === "prime-links" || c.source === "prime-release")),
        sees: sees(skill.name, own.filter(c => c.box === this.config.box), settings, inlined),
      };
    });
    const unowned = st.copies.filter(c => st.roles.get(copyId(c)) === "unowned").map(copyView);
    const items = drift(st.copies, st.roles, st.installs, st.states);
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
    const label = scan.box === "mac" ? "Mac" : scan.box;
    const day = (iso: string | null) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z` : "never");
    const state = scan.ok ? "ok" : scan.lastOkAt ? "offline" : "never";
    const message = scan.ok ? null : scan.lastOkAt ? `${label} asleep or offline since ${day(scan.since)}, showing its scan from ${day(scan.lastOkAt)}.` : `${label} has not answered a scan yet.`;
    return { box: scan.box, state, scannedAt: scan.attemptedAt, lastOkAt: scan.lastOkAt, since: scan.ok ? null : scan.since, seconds: scan.seconds, message, error: scan.error, tree: tree(copies) };
  }

  check(): SkillsCheck {
    const st = this.state();
    return { at: now(), items: drift(st.copies, st.roles, st.installs, st.states), offline: st.scans.filter(x => !x.ok).map(x => x.box) };
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
    this.version++;
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
    const installs = st.installs.filter(i => !opts.only || opts.only.includes(i.id));
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
    this.tx(() => {
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
      id: `inst_${short(`${body.box}:${path}`)}`, skillId: skill.id, box: body.box, path, mode, target, runtimes: RUNTIMES_OF[runtime], agent: body.agent ?? null,
      appliedHash: null, sourceHash: null, pending: null,
    };
    const moveId = newMove();
    this.tx(() => this.insertInstall(install));
    const apply = await this.apply({
      only: [install.id], moveId, kind: "install", summary: `install ${skill.name} on ${body.box} at ${path} (${mode})`,
      before: emptySnapshot(), touched: { skills: [], installs: [install.id], copies: [] }, keepFailures: true,
    });
    const failed = apply.steps.filter(x => x.result === "failed");
    if (failed.length) {
      this.tx(() => {
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
      steps = [...installs.map(i => ({ box: i.box, path: i.path, name: skill.name })), ...(canon ? [canon] : []).map(c => ({ box: c.box, path: c.path, name: skill.name })), ...mirrors.map(c => ({ box: c.box, path: c.path, name: skill.name }))];
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
    this.tx(() => {
      for (const r of results) if (r.state === "applied") this.db.prepare("DELETE FROM skill_copies WHERE box = ? AND path = ?").run(r.box, r.path);
      if (!failed.length) {
        for (const i of before.installs) this.db.prepare("DELETE FROM skill_installs WHERE id = ?").run(i.id);
        for (const id of dropSkills) this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
      }
      this.record("remove", failed.length ? `${summary} (${failed.length} steps failed)` : summary, item, before, { skills: dropSkills, installs: before.installs.map(i => i.id), copies: copyKeys }, moveId);
    });
    const error = failure("remove", moveId, results);
    if (error) throw error;
    return { move: this.moveById(moveId)!, apply: diskResult(moveId, results, "delete") };
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
      this.tx(() => {
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
    this.tx(() => {
      if (newSkill) this.insertSkill(newSkill);
      if (link) this.insertInstall(link);
      this.record("adopt", `adopt ${body.copyId} as ${link ? `install ${link.id} of ` : "the source of "}${skillId}`, null, emptySnapshot(), { skills: newSkill ? [newSkill.id] : [], installs: link ? [link.id] : [], copies: [] }, moveId);
    });
    return { move: this.moveById(moveId)!, apply: null };
  }

  async move(body: MoveBody): Promise<SkillsChange> {
    const st = this.state();
    const install = st.installs.find(i => i.id === body.installId);
    if (!install) throw new SkillsRefused(`No install ${body.installId}.`);
    if (install.path === body.path) throw new SkillsRefused(`${install.id} is at ${body.path} already.`);
    this.inHome(install.box, body.path, this.homeOf(install.box, st.copies));
    if (st.installAt.has(`${install.box}:${body.path}`) || st.copyAt.has(`${install.box}:${body.path}`)) throw new SkillsRefused(`${install.box}:${body.path} already holds a folder.`);
    const name = st.skillMap.get(install.skillId)?.name ?? "";
    const moveId = newMove();
    const item = `sw:${moveId}`;
    const from = install.mode === "copy" ? this.copySource(install, st) : install.target;
    const copies = [`${install.box}:${install.path}`, `${install.box}:${body.path}`];
    const before = this.snapshot({ installs: [install.id], copies });
    const results = await this.disk.run(item, [
      { kind: "place", box: install.box, path: body.path, name, mode: install.mode, from },
      { kind: "delete", box: install.box, path: install.path, name },
    ]);
    const ok = results.every(r => r.state === "applied" || r.state === "queued");
    this.tx(() => {
      if (ok) {
        this.db.prepare("UPDATE skill_installs SET path = ? WHERE id = ?").run(body.path, install.id);
        this.db.prepare("DELETE FROM skill_copies WHERE box = ? AND path = ?").run(install.box, install.path);
        if (results.every(r => r.state === "applied")) this.placedFact({ ...install, path: body.path }, st);
      }
      this.record("move", `move ${install.id} from ${install.path} to ${body.path}${ok ? "" : " (failed)"}`, item, before, { skills: [], installs: [install.id], copies }, moveId);
    });
    const error = failure("move", moveId, results);
    if (error) throw error;
    return { move: this.moveById(moveId)!, apply: diskResult(moveId, results, "create") };
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
    this.tx(() => this.record("merge", `merge ${from.id} into ${into.id}`, item, emptySnapshot(), emptyTouched(), moveId));
    return { move: this.moveById(moveId)!, apply: diskResult(moveId, results, "fold") };
  }

  async own(body: OwnBody): Promise<SkillsChange> {
    const skill = this.skills().find(k => k.id === body.skillId);
    if (!skill) throw new SkillsRefused(`No skill ${body.skillId}.`);
    if (!body.owner || !/^(owner|ag_[\w-]+)$/.test(body.owner)) throw new SkillsRefused("An owner is `owner` or an agent id such as ag_agent-factory.");
    const moveId = newMove();
    const before = this.snapshot({ skills: [skill.id] });
    this.tx(() => {
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
    this.tx(() => {
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
    return { move: this.moveById(move.id)!, apply: diskResult(move.id, results, "restore") };
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

const newMove = (): string => `mv_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const emptySnapshot = (): Snapshot => ({ skills: [], installs: [], copies: [] });
const emptyTouched = (): Touched => ({ skills: [], installs: [], copies: [] });

function diskResult(moveId: string, results: DiskResult[], step: ApplyStep["step"]): ApplyResult {
  return {
    at: now(), dryRun: false, changes: results.filter(r => r.state === "applied" || r.state === "queued" || r.state === "undone").length, moveId,
    steps: results.map(r => ({
      installId: "", box: r.box, path: r.path, step,
      result: r.state === "applied" || r.state === "undone" ? "done" : r.state === "queued" ? "queued" : r.state === "pending" ? "planned" : "failed", note: r.note,
    })),
  };
}
