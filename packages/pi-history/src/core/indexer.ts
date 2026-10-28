import { closeSync, openSync, readdirSync, readSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join, sep } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { extract, sessionOfPath, TRANSCRIPT, type Doc } from "./extract.ts";
import { TOOL_KINDS } from "./exclude.ts";
import { getMeta, setMeta } from "./db.ts";

export interface IndexerOptions {
  db: DatabaseSync;
  dbPath?: string;
  /** Folders to scan for transcripts. */
  dirs?: string[];
  sweepMs?: number;
  /** Bytes read per step, one transaction each; sets both the tail and the backfill size. */
  chunkBytes?: number;
  /** A folder whose mtime or newest transcript is younger than this gets an fs.watch. */
  watchRecentMs?: number;
  log?: (line: string) => void;
  /** Which roots keep no tool docs (exclude.ts ToolOutputPolicy). */
  policy?: ToolPolicy;
}

export interface ToolPolicy {
  refreshedAt: number;
  refresh(): Promise<void>;
  excludes(root: string): boolean;
  excludedRoots(): string[];
  forget(root: string): void;
}

export interface IndexStatus {
  mode: "backfill" | "tail";
  files: number;
  docs: number;
  bytesIndexed: number;
  bytesTotal: number;
  backfillPct: number;
  newestAt?: number;
  lagP50Ms?: number;
  lagP99Ms?: number;
  dbBytes: number;
  backfillMs?: number;
  lastSweepMs?: number;
  stepP50Ms?: number;
  stepP99Ms?: number;
  /** From the watch event or sweep that found new bytes to their commit, the indexer's own share of lag. */
  delayP50Ms?: number;
  delayP99Ms?: number;
}

interface FileRow {
  id: number;
  session: string;
  root: string;
  name: string | null;
  indexedTo: number;
  size: number;
  mtime: number;
}

interface Seen {
  size: number;
  mtime: number;
}

export function defaultDirs(home = homedir()): string[] {
  return ["sessions", "session-artifacts", "pi-sessions"].map((d) => join(home, ".prime/agent", d));
}

/** The root session of a transcript: the folder after session-artifacts/, else the file's own session. */
export function placeOf(path: string, session: string): { root: string; depth: number } {
  const parts = path.split(sep);
  const at = parts.lastIndexOf("session-artifacts");
  if (at < 0 || at + 2 >= parts.length) return { root: session, depth: 0 };
  const depth = parts.slice(at + 2, -1).filter((p) => p.startsWith("sub-")).length;
  return { root: parts[at + 1]!, depth };
}

const LAG_SAMPLES = 1000;
/** A sweep yields to the event loop after this much work, so a search waits at most one slice. */
const SWEEP_SLICE_MS = 20;
/**
 * Step sizes. Over 490 MB of this chat's transcripts at load average 255 to 298 on us-metal02 (10-28), step p99 was 298 to 709 ms at
 * 1 MB, 190 to 361 ms at 256 KB and 116 to 145 ms at 64 KB, and the whole pass took 43 to 67 s, 49 to 83 s and 67 to 85 s. Tail mode
 * takes the 256 KB middle, and backfill keeps 1 MB for its throughput.
 */
const TAIL_CHUNK_BYTES = 256 << 10;
const BACKFILL_CHUNK_BYTES = 1 << 20;
/** A step or policy pass this long holds every search behind it, so the log names it. */
const SLOW_MS = 250;
/** macOS FSEvents watches a whole tree with one stream, so the Mac needs no per-folder watchers. */
const RECURSIVE_WATCH = platform() === "darwin";
const NEWLINE = 0x0a;

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export class Indexer {
  readonly db: DatabaseSync;
  private readonly dbPath?: string;
  private readonly dirs: string[];
  private readonly sweepMs: number;
  private readonly tailChunkBytes: number;
  private readonly backfillChunkBytes: number;
  private readonly watchRecentMs: number;
  private readonly log: (line: string) => void;
  private readonly policy?: ToolPolicy;
  private readonly purged = new Set<string>();

  private readonly rows = new Map<string, FileRow>();
  private readonly seen = new Map<string, Seen>();
  private readonly caughtUp = new Set<string>();
  private readonly hot = new Set<string>();
  private backlog: string[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly lags: number[] = [];
  private readonly steps: number[] = [];
  /** Time from the first watch event or sweep that found a file's new bytes to the commit that indexed them. */
  private readonly delays: number[] = [];
  private readonly heardAt = new Map<string, number>();
  private lastStep = { bytes: 0, docs: 0, commitMs: 0 };
  private stepAts: number[] = [];
  private docCount = 0;
  private newestAt: number | undefined;
  private mode: "backfill" | "tail" = "backfill";
  private backfillStartedAt = 0;
  private backfillMs: number | undefined;
  private running = false;
  private stopped = false;
  private pumping: Promise<void> | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  private idSeq = new Map<number, number>();
  private lastSweepMs: number | undefined;

  private readonly st: {
    insertFile: StatementSync;
    updateFile: StatementSync;
    insertDoc: StatementSync;
    insertFts: StatementSync;
    maxIdIn: StatementSync;
    ftsDeleteFile: StatementSync;
    deleteDocs: StatementSync;
  };

  constructor(options: IndexerOptions) {
    this.db = options.db;
    this.dbPath = options.dbPath;
    this.dirs = options.dirs ?? defaultDirs();
    this.sweepMs = options.sweepMs ?? 30_000;
    this.tailChunkBytes = options.chunkBytes ?? TAIL_CHUNK_BYTES;
    this.backfillChunkBytes = options.chunkBytes ?? BACKFILL_CHUNK_BYTES;
    this.watchRecentMs = options.watchRecentMs ?? 2 * 86_400_000;
    this.log = options.log ?? (() => {});
    this.policy = options.policy;
    const db = this.db;
    this.st = {
      insertFile: db.prepare("INSERT INTO files(path, session, root, parent, depth) VALUES(?, ?, ?, ?, ?) RETURNING id"),
      updateFile: db.prepare(
        "UPDATE files SET name = ?, cwd = coalesce(?, cwd), created = coalesce(?, created), parent = coalesce(?, parent), indexed_to = ?, size = ?, mtime = ?, indexed_at = ? WHERE id = ?",
      ),
      insertDoc: db.prepare(
        "INSERT INTO docs(id, file, entry, at, line_offset, kind, tool, tool_call_id, author, is_error, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      insertFts: db.prepare("INSERT INTO fts(rowid, text, kind) VALUES(?, ?, ?)"),
      maxIdIn: db.prepare("SELECT max(id) AS id FROM docs WHERE id >= ? AND id < ?"),
      ftsDeleteFile: db.prepare("INSERT INTO fts(fts, rowid, text, kind) SELECT 'delete', id, text, kind FROM docs WHERE file = ?"),
      deleteDocs: db.prepare("DELETE FROM docs WHERE file = ?"),
    };
    for (const r of db.prepare("SELECT id, path, session, root, name, indexed_to, size, mtime FROM files").all() as any[]) {
      this.rows.set(r.path, { id: r.id, session: r.session, root: r.root, name: r.name, indexedTo: r.indexed_to, size: r.size, mtime: r.mtime });
    }
    this.docCount = Number((db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n);
    const newest = db.prepare("SELECT at FROM docs ORDER BY id DESC LIMIT 1").get() as { at: number } | undefined;
    this.newestAt = newest?.at;
    const done = getMeta(db, "backfill_ms");
    if (done) this.backfillMs = Number(done);
  }

  /** Scans every folder, backfills newest files first, then follows appends through fs.watch and a stat sweep. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.backfillStartedAt = Date.now();
    if (RECURSIVE_WATCH) for (const dir of this.dirs) this.watchTree(dir);
    await this.applyPolicy();
    await this.sweep();
    this.kick();
    this.sweepTimer = setInterval(() => void this.sweep().then(() => this.kick()), this.sweepMs);
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    await this.sweeping;
    await this.pumping;
  }

  /** Resolves once every known file is indexed to its last newline. */
  async idle(): Promise<void> {
    while (this.pumping || this.hot.size || this.backlog.length) {
      if (!this.pumping) this.kick();
      await this.pumping;
    }
  }

  status(): IndexStatus {
    let bytesIndexed = 0;
    let bytesTotal = 0;
    for (const [path, s] of this.seen) {
      bytesTotal += s.size;
      bytesIndexed += Math.min(s.size, this.rows.get(path)?.indexedTo ?? 0);
    }
    const lags = [...this.lags].sort((a, b) => a - b);
    const steps = [...this.steps].sort((a, b) => a - b);
    const delays = [...this.delays].sort((a, b) => a - b);
    let dbBytes = 0;
    if (this.dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          dbBytes += statSync(this.dbPath + suffix).size;
        } catch {}
      }
    }
    return {
      mode: this.mode,
      files: this.seen.size,
      docs: this.docCount,
      bytesIndexed,
      bytesTotal,
      backfillPct: bytesTotal ? Math.floor((bytesIndexed / bytesTotal) * 1000) / 10 : this.lastSweepMs === undefined ? 0 : 100,
      newestAt: this.newestAt,
      lagP50Ms: percentile(lags, 50),
      lagP99Ms: percentile(lags, 99),
      dbBytes,
      backfillMs: this.backfillMs,
      lastSweepMs: this.lastSweepMs,
      stepP50Ms: percentile(steps, 50),
      delayP50Ms: percentile(delays, 50),
      delayP99Ms: percentile(delays, 99),
      stepP99Ms: percentile(steps, 99),
    };
  }

  /** Reads the registry again and drops the tool docs of every excluded root not purged yet. Running it twice changes nothing. */
  async applyPolicy(): Promise<void> {
    if (!this.policy) return;
    try {
      await this.policy.refresh();
    } catch (err) {
      this.log(`pi-history: tool output policy unread: ${(err as Error).message}`);
      return;
    }
    const began = performance.now();
    for (const root of this.policy.excludedRoots()) {
      if (this.purged.has(root)) continue;
      const gone = this.purgeTools(root);
      this.purged.add(root);
      if (gone) this.log(`pi-history: dropped ${gone} tool docs of excluded root ${root}`);
    }
    const took = Math.round(performance.now() - began);
    if (took >= SLOW_MS) this.log(`pi-history: slow tool output policy pass ${took} ms`);
  }

  private purgeTools(root: string): number {
    const kinds = TOOL_KINDS.map((k) => `'${k}'`).join(", ");
    const files = "SELECT id FROM files WHERE root = ?";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO fts(fts, rowid, text, kind) SELECT 'delete', id, text, kind FROM docs WHERE file IN (${files}) AND kind IN (${kinds})`)
        .run(root);
      const gone = Number(this.db.prepare(`DELETE FROM docs WHERE file IN (${files}) AND kind IN (${kinds})`).run(root).changes);
      this.db.exec("COMMIT");
      this.docCount -= gone;
      return gone;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  sweep(): Promise<void> {
    this.sweeping ??= this.applyPolicy().then(() => this.sweepOnce()).finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    const found: string[] = [];
    const now = Date.now();
    const stack: { dir: string; newest: number; entries?: Dirent[]; i: number; parent?: number }[] = [];
    for (const dir of this.dirs) stack.push({ dir, newest: 0, i: 0 });
    let sliceStart = Date.now();
    while (stack.length && !this.stopped) {
      if (Date.now() - sliceStart > SWEEP_SLICE_MS) {
        await new Promise((resolve) => setImmediate(resolve));
        sliceStart = Date.now();
      }
      const top = stack[stack.length - 1]!;
      if (!top.entries) {
        try {
          top.entries = readdirSync(top.dir, { withFileTypes: true });
        } catch {
          top.entries = [];
        }
      }
      if (top.i >= top.entries.length) {
        stack.pop();
        if (now - top.newest < this.watchRecentMs) this.watchDir(top.dir);
        const parent = stack[stack.length - 1];
        if (parent) parent.newest = Math.max(parent.newest, top.newest);
        continue;
      }
      const e = top.entries[top.i++]!;
      const path = join(top.dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: path, newest: 0, i: 0 });
        continue;
      }
      if (!e.isFile() || !TRANSCRIPT.test(e.name)) continue;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const mtime = Math.trunc(st.mtimeMs);
      top.newest = Math.max(top.newest, mtime);
      this.seen.set(path, { size: st.size, mtime });
      const row = this.rows.get(path);
      if (!row || row.size !== st.size || row.mtime !== mtime) found.push(path);
    }
    this.lastSweepMs = Date.now() - now;
    if (!found.length) return;
    if (this.mode === "tail") {
      for (const path of found) this.markHot(path);
      return;
    }
    const queued = new Set(this.backlog);
    for (const path of found) if (!queued.has(path)) this.backlog.push(path);
    const mtimeOf = (p: string) => this.seen.get(p)?.mtime ?? 0;
    this.backlog.sort((x, y) => mtimeOf(y) - mtimeOf(x));
  }

  private watchTree(dir: string): void {
    try {
      const w = watch(dir, { persistent: false, recursive: true }, (_event, name) => {
        if (name && TRANSCRIPT.test(basename(String(name)))) {
          this.markHot(join(dir, String(name)));
          this.kick();
        }
      });
      w.on("error", () => w.close());
      this.watchers.set(dir, w);
    } catch {}
  }

  private watchDir(dir: string): void {
    if (RECURSIVE_WATCH || this.stopped || this.watchers.has(dir)) return;
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: false }, (_event, name) => this.onEvent(dir, name ? String(name) : undefined));
    } catch {
      return;
    }
    w.on("error", () => {
      w.close();
      this.watchers.delete(dir);
    });
    this.watchers.set(dir, w);
  }

  private onEvent(dir: string, name: string | undefined): void {
    if (!name) return;
    const path = join(dir, name);
    if (TRANSCRIPT.test(name)) {
      this.markHot(path);
      this.kick();
      return;
    }
    if (name.includes(".")) return;
    try {
      if (statSync(path).isDirectory()) {
        this.watchDir(path);
        void this.scanNewDir(path);
      }
    } catch {}
  }

  private async scanNewDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        this.watchDir(path);
        await this.scanNewDir(path);
      } else if (TRANSCRIPT.test(e.name)) this.markHot(path);
    }
    this.kick();
  }

  /** Queues a file for the next step and notes when the indexer first heard of its new bytes. */
  private markHot(path: string): void {
    this.hot.add(path);
    if (!this.heardAt.has(path)) this.heardAt.set(path, Date.now());
  }

  private kick(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (!this.stopped && (this.hot.size || this.backlog.length)) this.kick();
    });
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const path: string | undefined = this.hot.size ? this.hot.values().next().value : this.backlog[0];
      if (path === undefined) break;
      if (this.policy && !this.rows.has(path) && this.policy.refreshedAt <= (this.seen.get(path)?.mtime ?? Date.now())) {
        await this.applyPolicy();
      }
      let done = true;
      const began = performance.now();
      try {
        done = this.step(path);
        const took = Math.round(performance.now() - began);
        this.steps.push(took);
        if (this.steps.length > LAG_SAMPLES) this.steps.shift();
        if (took >= SLOW_MS) {
          const { bytes, docs, commitMs } = this.lastStep;
          this.log(`pi-history: slow step ${took} ms (${bytes} bytes, ${docs} docs, commit ${commitMs} ms) on ${path}`);
        }
      } catch (err) {
        this.log(`pi-history: ${path}: ${(err as Error).message}`);
      }
      if (done) {
        this.hot.delete(path);
        if (this.backlog[0] === path) this.backlog.shift();
      } else if (this.hot.delete(path)) {
        this.hot.add(path);
      }
      if (this.mode === "backfill" && !this.backlog.length && !this.sweeping) this.finishBackfill();
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.mode === "backfill" && !this.backlog.length && !this.sweeping) this.finishBackfill();
  }

  private finishBackfill(): void {
    this.mode = "tail";
    if (this.backfillMs === undefined) {
      this.backfillMs = Date.now() - this.backfillStartedAt;
      setMeta(this.db, "backfill_ms", String(this.backfillMs));
      this.log(`pi-history: backfill done in ${this.backfillMs} ms, ${this.docCount} docs`);
    }
  }

  private rowFor(path: string, session: string): FileRow {
    let row = this.rows.get(path);
    if (row) return row;
    const { root, depth } = placeOf(path, session);
    const r = this.st.insertFile.get(path, session, root, null, depth) as { id: number };
    row = { id: r.id, session, root, name: null, indexedTo: 0, size: 0, mtime: 0 };
    this.rows.set(path, row);
    return row;
  }

  private nextId(at: number): number {
    for (let ms = at; ; ms++) {
      let seq = this.idSeq.get(ms);
      if (seq === undefined) {
        const max = (this.st.maxIdIn.get(ms * 1024, ms * 1024 + 1024) as { id: number | null }).id;
        seq = max === null ? 0 : max - ms * 1024 + 1;
      }
      if (seq < 1024) {
        this.idSeq.set(ms, seq + 1);
        return ms * 1024 + seq;
      }
      this.idSeq.set(ms, 1024);
    }
  }

  private rewritten(fd: number, row: FileRow, size: number): boolean {
    if (row.indexedTo === 0) return false;
    if (size < row.indexedTo) return true;
    const b = Buffer.alloc(1);
    return readSync(fd, b, 0, 1, row.indexedTo - 1) !== 1 || b[0] !== NEWLINE;
  }

  /** Indexes one chunk of a file in one transaction. Returns true when the file has no more complete lines. */
  step(path: string): boolean {
    const session = sessionOfPath(path);
    if (!session) return true;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      this.seen.delete(path);
      return true;
    }
    try {
      const s = statSync(path);
      const size = s.size;
      const mtime = Math.trunc(s.mtimeMs);
      this.seen.set(path, { size, mtime });
      const row = this.rowFor(path, session);
      const tail = this.caughtUp.has(path);
      const docsAtStart = this.docCount;
      this.stepAts = [];
      const db = this.db;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (this.rewritten(fd, row, size)) {
          this.st.ftsDeleteFile.run(row.id);
          const gone = Number(this.st.deleteDocs.run(row.id).changes);
          this.docCount -= gone;
          row.indexedTo = 0;
          this.log(`pi-history: ${path} was rewritten, reindexing (${gone} docs dropped)`);
        }
        const start = row.indexedTo;
        const chunkBytes = this.mode === "tail" ? this.tailChunkBytes : this.backfillChunkBytes;
        let want = Math.min(chunkBytes, size - start);
        let buf = Buffer.alloc(0);
        let end = -1;
        while (want > 0) {
          const more = Buffer.alloc(want);
          const n = readSync(fd, more, 0, want, start + buf.length);
          if (n <= 0) break;
          buf = Buffer.concat([buf, more.subarray(0, n)]);
          end = buf.lastIndexOf(NEWLINE);
          if (end >= 0) break;
          want = Math.min(chunkBytes, size - start - buf.length);
        }
        let header: { cwd?: string; created?: number; parent?: string } = {};
        const now = Date.now();
        if (end >= 0) {
          let lineStart = 0;
          let lastAt = row.mtime || mtime;
          while (lineStart <= end) {
            const nl = buf.indexOf(NEWLINE, lineStart);
            const line = buf.toString("utf8", lineStart, nl);
            const offset = start + lineStart;
            lineStart = nl + 1;
            if (!line.trim()) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            const x = extract(parsed);
            if (x.header) {
              header = { cwd: x.header.cwd, created: x.header.created, parent: x.header.parentSession ? sessionOfPath(x.header.parentSession) : undefined };
            }
            if (x.name && x.name !== row.name) {
              row.name = x.name;
              if (row.session === row.root) this.policy?.forget(row.root);
            }
            const at = x.at ?? lastAt;
            lastAt = at;
            for (const d of x.docs) {
              if ((d.kind === "tool_call" || d.kind === "tool_result") && this.policy?.excludes(row.root)) continue;
              this.insertDoc(row, d, x.entry, at, offset, tail, now);
            }
          }
        }
        const consumed = end >= 0 ? end + 1 : 0;
        row.indexedTo = start + consumed;
        const reachedEnd = start + buf.length >= size;
        row.size = reachedEnd ? size : row.size;
        row.mtime = reachedEnd ? mtime : row.mtime;
        this.st.updateFile.run(row.name, header.cwd ?? null, header.created ?? null, header.parent ?? null, row.indexedTo, row.size, row.mtime, now, row.id);
        const commitStart = performance.now();
        db.exec("COMMIT");
        const committed = Date.now();
        this.lastStep = { bytes: consumed, docs: this.docCount - docsAtStart, commitMs: Math.round(performance.now() - commitStart) };
        for (const at of this.stepAts) this.lags.push(committed - at);
        if (this.lags.length > LAG_SAMPLES) this.lags.splice(0, this.lags.length - LAG_SAMPLES);
        const heard = this.heardAt.get(path);
        if (tail && consumed > 0 && heard !== undefined) {
          this.delays.push(committed - heard);
          if (this.delays.length > LAG_SAMPLES) this.delays.shift();
        }
        if (reachedEnd) {
          this.caughtUp.add(path);
          this.heardAt.delete(path);
        }
        return reachedEnd;
      } catch (err) {
        db.exec("ROLLBACK");
        this.reload(path);
        throw err;
      } finally {
        this.idSeq.clear();
      }
    } finally {
      closeSync(fd);
    }
  }

  private reload(path: string): void {
    const r = this.db.prepare("SELECT id, session, root, name, indexed_to, size, mtime FROM files WHERE path = ?").get(path) as any;
    if (r) this.rows.set(path, { id: r.id, session: r.session, root: r.root, name: r.name, indexedTo: r.indexed_to, size: r.size, mtime: r.mtime });
    else this.rows.delete(path);
  }

  private insertDoc(row: FileRow, d: Doc, entry: string | undefined, at: number, offset: number, tail: boolean, now: number): void {
    const id = this.nextId(at);
    const author = d.author ?? row.name ?? row.session;
    this.st.insertDoc.run(id, row.id, entry ?? null, at, offset, d.kind, d.tool ?? null, d.toolCallId ?? null, author, d.isError ? 1 : 0, d.text);
    this.st.insertFts.run(id, d.text, d.kind);
    this.docCount++;
    if (this.newestAt === undefined || at > this.newestAt) this.newestAt = at;
    if (tail) this.stepAts.push(at);
  }
}

