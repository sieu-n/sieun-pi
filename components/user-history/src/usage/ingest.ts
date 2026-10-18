import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageCall, UsageIngest } from "../shared/usage.ts";
import { databaseVersion, readDatabase } from "./databases.ts";
import type { ParserState } from "./parsers.ts";
import { loadPrices, resolvePrice, type PriceTable } from "./prices.ts";
import { readAppended, tailSample } from "./reader.ts";
import type { DatabaseSource, FileRoot } from "./sources.ts";
import { callKey, type FileRow, type StoredCall, type UsageStore } from "./store.ts";

/**
 * Keeps usage.duckdb in step with the transcripts. The first start reads every file once (state "building"); after that
 * a recursive fs.watch per root (FSEvents on macOS) marks files dirty, a pass runs at most every `debounceMs`, and a
 * slow sweep stats every file as the safety net for a missed event. Each file is read from its stored offset; a
 * shrink, a new inode, or changed bytes before the offset reread it from 0, which is safe because inserts merge by id.
 */
export type IngestOptions = {
  store: UsageStore; roots: FileRoot[]; databases: DatabaseSource[]; pricesPath: string;
  debounceMs?: number; sweepMs?: number; onCalls?(calls: StoredCall[]): void; log?(line: string): void;
  fetchPrices?: (url: string) => Promise<unknown>;
};

/**
 * Low priority: a pass works at most `workMs`, then sleeps `restMs`, so the first build uses at most about 70% of one
 * core and leaves the machine responsive. Node cannot lower one thread's OS priority on macOS, so this is the brake.
 */
const workMs = 140;
const restMs = 60;
/** A periodic sweep only stats files that rarely changed, so it goes slower still: at most about a quarter of a core. */
const sweepWorkMs = 25;
const sweepRestMs = 75;
const flushRows = 40_000;
const flushFiles = 1000;
const flushAfterMs = 2000;

export class Ingest {
  private readonly checkpoints = new Map<string, FileRow>();
  private readonly dirty = new Set<string>();
  private readonly watchers: FSWatcher[] = [];
  private calls = new Map<bigint, StoredCall>();
  private files = new Map<string, FileRow>();
  private lastFlush = Date.now();
  private sliceStart = Date.now();
  /** When each root was last listed; a root with its own `sweepMs` (the archives) is skipped until that much time passed. */
  private readonly sweptAt = new Map<FileRoot, number>();
  private passTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private priceTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private prices: PriceTable = new Map();
  private priced = new Set<string>();
  readonly status: UsageIngest = { state: "syncing", filesDone: 0, filesTotal: 0, lastSyncAt: null, error: null, sources: [] };

  constructor(private readonly options: IngestOptions) {}

  async start(): Promise<void> {
    const versions = new Map<string, string>([...this.options.roots.map(root => [root.source, root.spec.version] as const),
      ...this.options.databases.map(db => [db.source, databaseVersion] as const)]);
    const reread = await this.options.store.resetSources(versions);
    if (reread.length) this.options.log?.(`usage: a parser changed, reading ${reread.join(", ")} again`);
    for (const row of await this.options.store.files()) this.checkpoints.set(row.path, row);
    this.status.state = this.options.store.fresh || reread.length ? "building" : "syncing";
    await this.refreshPrices();
    for (const root of this.options.roots) this.watchRoot(root);
    for (const db of this.options.databases) this.watchDatabase(db);
    this.queue(() => this.sweep(true));
    this.sweepTimer = setInterval(() => this.queue(() => this.sweep(false)), this.options.sweepMs ?? 5 * 60_000);
    this.sweepTimer.unref();
    this.priceTimer = setInterval(() => { void this.refreshPrices(); }, 6 * 60 * 60_000);
    this.priceTimer.unref();
  }

  /** Resolves when every pass queued so far is done. */
  idle(): Promise<void> { return this.running; }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers) watcher.close();
    if (this.passTimer) clearTimeout(this.passTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.priceTimer) clearInterval(this.priceTimer);
  }

  private queue(task: () => Promise<void>): void {
    this.running = this.running.then(async () => {
      if (this.closed) return;
      try { await task(); if (this.status.state === "error") this.status.state = "idle"; this.status.error = null; }
      catch (error) {
        this.status.state = "error";
        this.status.error = error instanceof Error ? error.message : String(error);
        this.options.log?.(`usage: ${this.status.error}`);
      }
    });
  }

  private watchRoot(root: FileRoot): void {
    try {
      const watcher = watch(root.root, { recursive: true, persistent: false }, (_event, name) => {
        if (name === null) { this.queue(() => this.sweep(false)); return; }
        const path = join(root.root, name.toString());
        if (root.accepts(path)) this.markDirty(path);
      });
      watcher.on("error", () => { /* the sweep covers a root that went away */ });
      this.watchers.push(watcher);
    } catch { /* the root does not exist yet: the sweep picks it up when it appears */ }
  }

  private watchDatabase(db: DatabaseSource): void {
    try {
      const name = db.path.slice(db.watch.length + 1);
      const watcher = watch(db.watch, { persistent: false }, (_event, file) => {
        if (file !== null && file.toString().startsWith(name)) this.markDirty(db.path);
      });
      watcher.on("error", () => {});
      this.watchers.push(watcher);
    } catch { /* missing client */ }
  }

  private markDirty(path: string): void {
    this.dirty.add(path);
    if (this.passTimer) return;
    this.passTimer = setTimeout(() => {
      this.passTimer = null;
      const paths = [...this.dirty];
      this.dirty.clear();
      this.queue(() => this.pass(paths));
    }, this.options.debounceMs ?? 2000);
    this.passTimer.unref();
  }

  private rootFor(path: string): FileRoot | null {
    return this.options.roots.find(root => path.startsWith(root.root + "/") && root.accepts(path)) ?? null;
  }

  private async pass(paths: string[]): Promise<void> {
    if (this.status.state !== "building") this.status.state = "syncing";
    for (const path of paths) {
      if (this.closed) return;
      await this.breathe();
      const db = this.options.databases.find(d => d.path === path);
      if (db) await this.syncDatabase(db);
      else { const root = this.rootFor(path); if (root) await this.syncFile(root, path); }
    }
    await this.flush(true);
    this.finishPass();
  }

  /** Lists every root (only the directories a root can hold transcripts in) and syncs each file whose stat changed. */
  private async sweep(first: boolean): Promise<void> {
    const listed: [FileRoot, string][] = [];
    const now = Date.now();
    for (const root of this.options.roots) {
      if (!first && root.sweepMs !== undefined && now - (this.sweptAt.get(root) ?? 0) < root.sweepMs) continue;
      this.sweptAt.set(root, now);
      for (const path of await listFiles(root)) listed.push([root, path]);
    }
    if (first) { this.status.filesTotal = listed.length + this.options.databases.length; this.status.filesDone = 0; }
    // Newest first, so the recent hours are in the table early in a first build.
    if (this.status.state === "building") {
      const times = new Map<string, number>();
      await Promise.all(listed.map(async ([, path]) => { times.set(path, await stat(path).then(s => s.mtimeMs, () => 0)); }));
      listed.sort((a, b) => (times.get(b[1]) ?? 0) - (times.get(a[1]) ?? 0));
    }
    for (const [root, path] of listed) {
      if (this.closed) return;
      await (first ? this.breathe() : this.breathe(sweepWorkMs, sweepRestMs));
      await this.syncFile(root, path);
      if (first) this.status.filesDone++;
    }
    for (const db of this.options.databases) { await this.syncDatabase(db); if (first) this.status.filesDone++; }
    await this.flush(true);
    if (first) this.status.filesDone = this.status.filesTotal;
    this.finishPass();
  }

  private async breathe(work = workMs, rest = restMs): Promise<void> {
    if (Date.now() - this.sliceStart < work) return;
    await new Promise(resolve => setTimeout(resolve, rest));
    this.sliceStart = Date.now();
  }

  private finishPass(): void {
    this.status.state = "idle";
    this.status.lastSyncAt = Date.now();
  }

  private checkpoint(path: string): FileRow | undefined { return this.files.get(path) ?? this.checkpoints.get(path); }

  async syncFile(root: FileRoot, path: string): Promise<void> {
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) return;
    const saved = this.checkpoint(path);
    let offset = 0;
    let state: ParserState | null = null;
    if (saved && saved.ino === info.ino && saved.dev === info.dev && info.size >= saved.offset) {
      if (saved.size === info.size && saved.mtime === info.mtimeMs) return;
      if (saved.offset > 0 && await tailSample(path, saved.offset).catch(() => "") === saved.tail) {
        offset = saved.offset;
        state = JSON.parse(saved.state) as ParserState;
      }
    }
    const parser = root.spec.create({ source: root.source, path, fileId: String(info.ino), fallbackTime: info.mtimeMs }, state);
    const found: UsageCall[] = [];
    const result = await readAppended(path, offset, root.spec.needles, (text, at) => { for (const call of parser.line(text, at)) found.push(call); }, { end: info.size });
    found.push(...parser.finish());
    for (const call of found) this.add(call);
    const tail = await tailSample(path, result.offset).catch(() => "");
    this.files.set(path, { path, source: root.source, dev: info.dev, ino: info.ino, size: info.size, offset: result.offset, mtime: info.mtimeMs, tail, state: JSON.stringify(parser.state()), parser: root.spec.version });
    await this.flush(false);
  }

  private async syncDatabase(db: DatabaseSource): Promise<void> {
    const [main, wal] = await Promise.all([stat(db.path).catch(() => null), stat(db.path + "-wal").catch(() => null)]);
    if (!main) return;
    const signature = main.mtimeMs + (wal?.mtimeMs ?? 0);
    const size = main.size + (wal?.size ?? 0);
    const saved = this.checkpoint(db.path);
    if (saved && saved.mtime === signature && saved.size === size) return;
    for (const call of readDatabase(db.source, db.path)) this.add(call);
    this.files.set(db.path, { path: db.path, source: db.source, dev: main.dev, ino: main.ino, size, offset: size, mtime: signature, tail: "", state: "{}", parser: databaseVersion });
    await this.flush(false);
  }

  /** Merges copies of one call inside a batch the same way the store merges across batches. */
  private add(call: UsageCall): void {
    const id = callKey(call.source, call.callId);
    const prior = this.calls.get(id);
    if (!prior) { this.calls.set(id, { ...call, id }); return; }
    prior.input = Math.max(prior.input, call.input); prior.output = Math.max(prior.output, call.output);
    prior.cacheRead = Math.max(prior.cacheRead, call.cacheRead); prior.cacheWrite = Math.max(prior.cacheWrite, call.cacheWrite);
    prior.reasoning = Math.max(prior.reasoning, call.reasoning);
    if (call.costUsd !== null) prior.costUsd = Math.max(prior.costUsd ?? 0, call.costUsd);
    if (call.startedAt !== null) prior.startedAt = prior.startedAt === null ? call.startedAt : Math.min(prior.startedAt, call.startedAt);
    if (call.source === "claude-code") prior.endedAt = Math.max(prior.endedAt, call.endedAt);
  }

  private async flush(force: boolean): Promise<void> {
    if (!force && this.calls.size < flushRows && this.files.size < flushFiles && Date.now() - this.lastFlush < flushAfterMs) return;
    this.lastFlush = Date.now();
    if (this.calls.size === 0 && this.files.size === 0) return;
    const calls = [...this.calls.values()], files = [...this.files.values()];
    this.calls = new Map(); this.files = new Map();
    await this.options.store.write(calls, files);
    for (const file of files) this.checkpoints.set(file.path, file);
    this.options.onCalls?.(calls);
    if (calls.some(call => call.model !== null && !this.priced.has(call.model))) await this.priceModels();
  }

  private async refreshPrices(): Promise<void> {
    try {
      this.prices = (await loadPrices(this.options.pricesPath, this.options.fetchPrices)).table;
      this.priced.clear();
      await this.priceModels();
    } catch (error) { this.options.log?.(`usage prices: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The price row for every model in the table; recomputed when a new model appears or the price file changes. */
  private async priceModels(): Promise<void> {
    const models = await this.options.store.models();
    const rows = [];
    for (const { model, provider } of models) {
      this.priced.add(model);
      const match = resolvePrice(model, provider, this.prices);
      if (match) rows.push({ model, matched: match.key, price: match.price });
    }
    await this.options.store.setPrices(rows);
  }
}

/** Every transcript under a root. Directories are pruned by asking `accepts` about a probe file inside them. */
export async function listFiles(root: FileRoot): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        // A directory is worth entering only if a transcript one or two levels below it could be accepted.
        if (["x.jsonl", "rollout-x.jsonl", join("sub-x", "x.jsonl")].some(probe => root.accepts(join(path, probe)))) await walk(path);
      } else if (entry.isFile() && root.accepts(path)) out.push(path);
    }
  };
  await walk(root.root);
  return out;
}
