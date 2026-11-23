/**
 * Moves one kind of record from the chat server's JSON files into chat.sqlite (chat-db.ts) and keeps the move safe to run again.
 *
 * On boot, `open` imports every JSON file of the kind whose content the DB has not seen, and stores the file's sha256 in `db_files`, so a
 * second boot, like a second `docker compose up`, imports nothing. For a week after the first import the DB writes each changed file back
 * as a JSON export, rendered from the rows (`JsonKind.dump`), so `scripts/release-apps-chat.mjs --rollback` to a release that still reads
 * the files finds current data. Each export's sha256 is stored before the file is replaced, so the next boot knows it. A file whose content
 * the DB never stored or wrote was written by such an older release, and the next boot imports it again. After the week the files move to
 * `json-archive/<kind>/` and nothing reads or writes them.
 *
 * `check` counts each file's records against the DB's, and `apply` writes the exports that are behind; `sw <kind> check|apply` call them.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { replaceLater, sealedFor, written } from "./disk.ts";
import type { ChatDb } from "./chat-db.ts";

/** One kind of record and its JSON files. Each function gets the calling thread's connection; `load` runs inside the import's transaction. */
export interface JsonKind {
  /** The kind's name, which `sw <kind> check|apply` and the `db_kinds` table use, such as "rooms". */
  kind: string;
  /** The kind's tables, one DDL step each, in order; a step that ran once never runs again, so a later step adds to the list. */
  migrations: readonly string[];
  /** The kind's JSON files that are on disk now, as paths relative to the data dir. */
  files(dataDir: string): string[];
  /** Replaces in the DB every record `file` holds with the records of `text`, and answers how many it read. */
  load(db: DatabaseSync, file: string, text: string): number;
  /** How many records `text`, the content of `file`, holds. */
  records(file: string, text: string): number;
  /** How many records of `file` the DB holds. */
  count(db: DatabaseSync, file: string): number;
  /**
   * The text of `file` as the release before the move wrote it, rendered from the DB, or null when the DB holds nothing of it, which deletes
   * the file's export, as the release before the move deleted a file whose last record went.
   */
  dump(db: DatabaseSync, file: string): string | null;
}

export type OpenResult = { kind: string; imported: string[]; records: number; known: number; archived: string[] };
export type CheckItem = {
  file: string;
  /** unknown: the DB never stored or wrote this content, and the next boot imports it. behind: the export is older than the DB. count: the
   *  file and the DB hold different numbers of records although the export is current. */
  state: "unknown" | "behind" | "count";
  json: number | null;
  db: number;
  fix: string;
};
export type MoveCheck = {
  kind: string; version: number; importedAt: string | null; exportUntil: string | null; files: number; json: number; db: number; items: CheckItem[];
};
export type MoveApply = { kind: string; dryRun: boolean; exported: string[]; archived: string[]; left: CheckItem[] };

const DAY_MS = 86_400_000;
/** How long after a write its file's export waits, so a burst of writes to one file costs one export. */
const EXPORT_DELAY_MS = 1000;
/** Export hashes kept per file: the newest is enough for a file the export wrote, and four more cover exports still queued at a crash. */
const KEPT_EXPORTS = 5;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();

export type JsonMoveOptions = { log?: (line: string) => void; now?: () => number; exportDays?: number; exportDelayMs?: number };

export class JsonMove {
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly exportDays: number;
  private readonly exportDelayMs: number;
  private readonly touched = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private exporting: Promise<void> = Promise.resolve();

  constructor(readonly chat: ChatDb, readonly dataDir: string, readonly kind: JsonKind, options: JsonMoveOptions = {}) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.exportDays = options.exportDays ?? 7;
    this.exportDelayMs = options.exportDelayMs ?? EXPORT_DELAY_MS;
  }

  private get db(): DatabaseSync {
    return this.chat.db;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private state(): { version: number; importedAt: string | null; exportUntil: string | null } {
    const row = this.db.prepare("SELECT version, imported_at, export_until FROM db_kinds WHERE kind = ?").get(this.kind.kind) as
      | { version: number | bigint; imported_at: string | null; export_until: string | null }
      | undefined;
    return { version: Number(row?.version ?? 0), importedAt: row?.imported_at ?? null, exportUntil: row?.export_until ?? null };
  }

  /** Whether the week of JSON exports is still on. */
  exportsOn(): boolean {
    const until = this.state().exportUntil;
    return until === null || this.now() < Date.parse(until);
  }

  private known(file: string, sha: string): boolean {
    return this.db.prepare("SELECT 1 FROM db_files WHERE kind = ? AND path = ? AND sha256 = ?").get(this.kind.kind, file, sha) !== undefined;
  }

  /**
   * The boot's step, before the server serves: runs the kind's new migrations, imports each file whose content the DB has not seen, starts
   * the week of exports at the first import and archives the files once it ended. Runs on the calling thread; nothing else writes yet.
   */
  open(): OpenResult {
    const { kind } = this.kind;
    const result: OpenResult = { kind, imported: [], records: 0, known: 0, archived: [] };
    this.tx(() => {
      const { version } = this.state();
      for (const step of this.kind.migrations.slice(version)) this.db.exec(step);
      this.db.prepare("INSERT INTO db_kinds (kind, version) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET version = excluded.version")
        .run(kind, Math.max(version, this.kind.migrations.length));
    });
    for (const file of this.kind.files(this.dataDir)) {
      const path = join(this.dataDir, file);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      const seen = this.db.prepare("SELECT 1 FROM db_files WHERE kind = ? AND path = ? AND size = ? AND mtime_ms = ?").get(kind, file, stat.size, stat.mtimeMs);
      if (seen) {
        result.known += 1;
        continue;
      }
      const text = readFileSync(path, "utf8");
      const sha = sha256(text);
      if (this.known(file, sha)) {
        this.db.prepare("UPDATE db_files SET size = ?, mtime_ms = ? WHERE kind = ? AND path = ? AND sha256 = ?").run(stat.size, stat.mtimeMs, kind, file, sha);
        result.known += 1;
        continue;
      }
      const records = this.tx(() => {
        const n = this.kind.load(this.db, file, text);
        this.db.prepare(
          "INSERT INTO db_files (kind, path, how, sha256, size, mtime_ms, records, at) VALUES (?, ?, 'import', ?, ?, ?, ?, ?) " +
          "ON CONFLICT (kind, path, sha256) DO UPDATE SET how = 'import', size = excluded.size, mtime_ms = excluded.mtime_ms, records = excluded.records, at = excluded.at",
        ).run(kind, file, sha, stat.size, stat.mtimeMs, n, iso(this.now()));
        return n;
      });
      result.imported.push(file);
      result.records += records;
    }
    if (this.state().importedAt === null) {
      this.db.prepare("UPDATE db_kinds SET imported_at = ?, export_until = ? WHERE kind = ?").run(iso(this.now()), iso(this.now() + this.exportDays * DAY_MS), kind);
    }
    if (!this.exportsOn()) result.archived = this.archive();
    if (result.imported.length) this.log(`chat db: ${kind} imported ${result.records} records from ${result.imported.length} JSON files`);
    return result;
  }

  /** Moves the kind's JSON files into json-archive/<kind>/, once the week of exports ended and the DB holds every file's content. */
  private archive(): string[] {
    const moved: string[] = [];
    for (const file of this.kind.files(this.dataDir)) {
      const path = join(this.dataDir, file);
      if (!existsSync(path) || !this.known(file, sha256(readFileSync(path, "utf8")))) continue;
      const to = join(this.dataDir, "json-archive", this.kind.kind, file);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(path, to);
      moved.push(file);
    }
    if (moved.length) this.log(`chat db: ${this.kind.kind} moved ${moved.length} JSON files to json-archive, since the week of exports ended`);
    return moved;
  }

  /** Says a write changed what `file` holds, so its JSON export follows while the week of exports lasts. */
  touch(file: string): void {
    this.touched.add(file);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushExports();
    }, this.exportDelayMs);
    this.timer.unref();
  }

  /** Writes the exports of every touched file now, once the writes before them are committed; a stop awaits it before the disk queue. */
  flushExports(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const files = [...this.touched];
    this.touched.clear();
    if (!files.length) return this.exporting;
    return (this.exporting = this.exporting.then(async () => void (await this.export(files))).catch(error => {
      this.log(`chat db: ${this.kind.kind} export failed: ${error instanceof Error ? error.message : String(error)}`);
    }));
  }

  private async export(files: readonly string[]): Promise<string[]> {
    if (!this.exportsOn()) return [];
    await this.chat.written();
    const done: string[] = [];
    for (const file of files) {
      const text = this.kind.dump(this.db, file);
      if (text === null) {
        // A write took the file's last record away, such as a wake that went out, so the export goes too: a rollback must not find it.
        const path = join(this.dataDir, file);
        await written(path);
        if (existsSync(path) && !sealedFor(path)) {
          rmSync(path, { force: true });
          done.push(file);
        }
        continue;
      }
      const sha = sha256(text);
      const { kind } = this.kind;
      await this.chat.write([
        {
          sql: "INSERT INTO db_files (kind, path, how, sha256, size, mtime_ms, records, at) VALUES (?, ?, 'export', ?, ?, 0, NULL, ?) " +
            "ON CONFLICT (kind, path, sha256) DO UPDATE SET at = excluded.at",
          params: [kind, file, sha, Buffer.byteLength(text), iso(this.now())],
        },
        {
          sql: "DELETE FROM db_files WHERE kind = ? AND path = ? AND how = 'export' AND rowid NOT IN " +
            "(SELECT rowid FROM db_files WHERE kind = ? AND path = ? AND how = 'export' ORDER BY at DESC LIMIT ?)",
          params: [kind, file, kind, file, KEPT_EXPORTS],
        },
      ], `${kind} export`);
      const path = join(this.dataDir, file);
      replaceLater(path, text);
      await written(path);
      done.push(file);
    }
    return done;
  }

  /** Each file of the kind against the DB: its records, the DB's records and whether the export is current. */
  check(): MoveCheck {
    const { kind } = this.kind;
    const state = this.state();
    const onDisk = this.kind.files(this.dataDir);
    const stored = (this.db.prepare("SELECT DISTINCT path FROM db_files WHERE kind = ?").all(kind) as { path: string }[]).map(r => r.path);
    const items: CheckItem[] = [];
    let json = 0, db = 0;
    const files = [...new Set([...onDisk, ...stored])].sort();
    for (const file of files) {
      const count = this.kind.count(this.db, file);
      db += count;
      const path = join(this.dataDir, file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      const records = this.kind.records(file, text);
      json += records;
      if (!this.known(file, sha256(text))) {
        items.push({ file, state: "unknown", json: records, db: count, fix: "a restart of the chat server imports it" });
        continue;
      }
      const dump = this.kind.dump(this.db, file);
      if (dump !== text) items.push({ file, state: "behind", json: records, db: count, fix: `sw ${kind} apply ${dump === null ? "deletes" : "writes"} the export` });
      else if (records !== count) items.push({ file, state: "count", json: records, db: count, fix: "a bug in the kind's load or dump; nothing fixes it by itself" });
    }
    return { kind, version: state.version, importedAt: state.importedAt, exportUntil: state.exportUntil, files: files.length, json, db, items };
  }

  /** Writes every export that is behind the DB, and archives the files once the week of exports ended. A second run changes nothing. */
  async apply(options: { dryRun?: boolean } = {}): Promise<MoveApply> {
    const dryRun = options.dryRun === true;
    const behind = this.check().items.filter(i => i.state === "behind").map(i => i.file);
    const ended = !this.exportsOn();
    if (dryRun) return { kind: this.kind.kind, dryRun, exported: ended ? [] : behind, archived: ended ? this.kind.files(this.dataDir) : [], left: this.check().items };
    await this.exporting;
    const exported = ended ? [] : await this.export(behind);
    const archived = ended ? this.archive() : [];
    return { kind: this.kind.kind, dryRun, exported, archived, left: this.check().items.filter(i => i.state !== "behind" || !exported.includes(i.file)) };
  }
}
