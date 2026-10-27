import { lstat, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type InsideProcess, leftoverSource, SHARED_TMP } from "./job-leftovers.ts";
import { removeTree } from "./walk-tree.ts";

/**
 * The /tmp sweep while nobody works there. /tmp is a tmpfs, so each byte is RAM or swap, and a job's end (src/job-leftovers.ts) deletes no /tmp
 * tree, since a transcript naming a path proves no owner. On 10-19 at 01:2xZ us-metal02's /tmp held 9.2 GB with swap at 13.2 of 16 GB, though no turn had run for most
 * of the evening: 13,912 entries nobody held or named, 5.1 GB, among them names several jobs reused (/tmp/cs, /tmp/dd, /tmp/wr), which the
 * job's end keeps because a later job wrote them, mkdtemp dirs no transcript names (tmpma5xa9vn, KbW6bCzDrJoP7_ZCFnABR), a 12 h old land clone
 * of a chat that never ends (clone-metal-land-01a11d24), and 0.93 GB of the tsx compile cache, which grows by every export a job compiles from.
 * Removing them took /tmp to 2.7 GB and swap to 9.8 GB.
 * An entry goes once nothing at or below it changed for the idle window (idleEvictionMinutes, the time after which an idle session stops), no
 * live socket lies in it, no session the daemon holds loaded or that waits on a board.wake names it in its transcript since the entry's birth,
 * and no process holds it (worker-footprint.py `--inside`). The sweep signals no process: a process whose files, cwd, arguments or environment
 * lie in an entry keeps it, because on 10-19 at 02:06Z a job's end SIGTERMed four release processes of other jobs that only named a shared
 * helper's folder. Old files of the tsx cache go the same way, since a missing one is only compiled again.
 */

export interface TmpEntry { path: string; name: string; bornMs: number; changedMs: number; liveSocket: boolean }
export interface Keeper { sessionFile: string }
export interface TmpSweepSource {
  /** The top-level entries of `root` our user owns, except shared ones (SHARED_TMP) and symlinks, with their newest change at or below. */
  entries: () => Promise<readonly TmpEntry[]>;
  /** The transcripts of the sessions the daemon holds loaded and of those a board.wake waits on. */
  keepers: () => Promise<readonly Keeper[]>;
  /** The entries of `root` a transcript names from `sinceMs` on (at least), as `namedIn` finds them. */
  namedSince: (file: string, sinceMs: number, root: string) => Promise<Set<string>>;
  inside: (paths: readonly string[]) => Promise<readonly InsideProcess[]>;
  remove: (paths: readonly string[]) => Promise<readonly string[]>;
  /** Deletes the files of the shared compile caches unchanged and unread since `beforeMs`; returns their bytes. */
  pruneCaches: (beforeMs: number) => Promise<number>;
  root: string;
  idleMs: () => number | null;
  now: () => number;
}

export interface TmpSweep { removed: readonly string[]; cacheBytes: number }

const CACHES = /^tsx-\d+$/;
const TMP_NAME = "[A-Za-z0-9._+@-]+";

function escaped(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * The entries of `root` a transcript text names, as `<root>/<name>` anywhere, since a name that only seems to be one keeps an entry a while
 * longer and a missed one deletes a live job's file: in a JSONL line a path at the start of a line follows an escaped `\n`.
 */
export function namedIn(text: string, root: string): Set<string> {
  return new Set([...text.matchAll(new RegExp(`${escaped(root)}/(${TMP_NAME})`, "g"))].map(match => match[1]!));
}

/** One sweep: returns what it deleted. With idle eviction off, nothing goes. */
export async function sweepTmp(source: TmpSweepSource): Promise<TmpSweep> {
  const idleMs = source.idleMs();
  if (idleMs === null) return { removed: [], cacheBytes: 0 };
  const cutoff = source.now() - idleMs;
  const cacheBytes = await source.pruneCaches(cutoff).catch(() => 0);
  let stale = (await source.entries()).filter(entry => entry.changedMs < cutoff && !entry.liveSocket);
  if (!stale.length) return { removed: [], cacheBytes };
  const since = Math.min(...stale.map(entry => entry.bornMs));
  for (const keeper of await source.keepers()) {
    if (!stale.length) break;
    const named = await source.namedSince(keeper.sessionFile, since, source.root).catch(() => new Set<string>());
    stale = stale.filter(entry => !named.has(entry.name));
  }
  if (!stale.length) return { removed: [], cacheBytes };
  const held = new Set((await source.inside(stale.map(entry => entry.path))).map(entry => entry.dir));
  const free = stale.map(entry => entry.path).filter(path => !held.has(path));
  return { removed: free.length ? await source.remove(free) : [], cacheBytes };
}

/** The bound unix socket paths of live sockets (Linux /proc/net/unix); null where it cannot be read, so every socket counts as live. */
async function liveSockets(): Promise<Set<string> | null> {
  const text = await readFile("/proc/net/unix", "utf8").catch(() => null);
  if (text === null) return null;
  return new Set(text.split("\n").slice(1).map(line => line.trim().split(/\s+/)[7]).filter((path): path is string => !!path && path.startsWith("/")));
}

/** Birth, newest change (mtime or ctime) and whether a live socket lies at or below `path`; the walk stops at the first change after `stopAfter`. */
async function scan(path: string, stopAfter: number, sockets: Set<string> | null): Promise<{ changedMs: number; liveSocket: boolean }> {
  let changedMs = 0;
  let liveSocket = false;
  const walk = async (at: string): Promise<void> => {
    const item = await lstat(at).catch(() => null);
    if (!item) return;
    changedMs = Math.max(changedMs, item.mtimeMs, item.ctimeMs);
    if (item.isSocket() && (sockets === null || sockets.has(at))) liveSocket = true;
    if (!item.isDirectory() || liveSocket || changedMs >= stopAfter) return;
    for (const entry of await readdir(at).catch(() => [])) {
      await walk(join(at, entry));
      if (liveSocket || changedMs >= stopAfter) return;
    }
  };
  await walk(path);
  return { changedMs, liveSocket };
}

export async function tmpEntries(root: string, stopAfter: number): Promise<TmpEntry[]> {
  const uid = process.getuid?.();
  const sockets = await liveSockets();
  const found: TmpEntry[] = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (SHARED_TMP.test(name)) continue;
    const path = join(root, name);
    const item = await lstat(path).catch(() => null);
    if (!item || item.isSymbolicLink() || (uid !== undefined && item.uid !== uid)) continue;
    found.push({ path, name, bornMs: item.birthtimeMs > 0 ? item.birthtimeMs : item.ctimeMs, ...await scan(path, stopAfter, sockets) });
  }
  return found;
}

/** Deletes the files under the compile caches of `root` (CACHES) whose last write and read are before `beforeMs`; returns their bytes. */
export async function pruneCaches(root: string, beforeMs: number): Promise<number> {
  const uid = process.getuid?.();
  let bytes = 0;
  for (const name of await readdir(root).catch(() => [])) {
    if (!CACHES.test(name)) continue;
    const dir = join(root, name);
    const top = await lstat(dir).catch(() => null);
    if (!top?.isDirectory() || (uid !== undefined && top.uid !== uid)) continue;
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      const item = await lstat(file).catch(() => null);
      if (!item || Math.max(item.mtimeMs, item.atimeMs) >= beforeMs) continue;
      if (await rm(file, { force: true }).then(() => true, () => false)) bytes += item.blocks * 512;
    }
  }
  return bytes;
}

const CHUNK = 4 * 1024 * 1024;
const STAMP = /"timestamp":"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/;

/**
 * The entries of `root` a transcript names in its tail back to the first line stamped before `sinceMs`, read from the end one chunk of whole
 * lines at a time, so each decode and match covers one chunk and a read sits between them. On 10-24 decoding and matching the whole tail at
 * once held the chat's event loop up to 298 ms (CPU profile pid626077).
 */
export async function namedSince(file: string, sinceMs: number, root: string, chunk = CHUNK): Promise<Set<string>> {
  const named = new Set<string>();
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    let rest = Buffer.alloc(0);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - chunk);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      end = start;
      const lineStart = start === 0 ? 0 : buffer.indexOf(10) + 1;
      if (start > 0 && lineStart === 0) { rest = Buffer.concat([buffer, rest]); continue; }
      const text = Buffer.concat([buffer.subarray(lineStart), rest]).toString("utf8");
      rest = buffer.subarray(0, lineStart);
      for (const name of namedIn(text, root)) named.add(name);
      const stamp = STAMP.exec(text.slice(0, 64 * 1024));
      if (stamp && Date.parse(stamp[1]!) < sinceMs) break;
    }
    return named;
  } finally {
    await handle.close();
  }
}

/** The loaded or waking sessions among the daemon's rows, by their transcripts. */
export function keepersOf(rows: readonly { sessionId: string; sessionFile?: string; activeSessionId?: string; lifecycle?: string }[], waking: ReadonlySet<string>): Keeper[] {
  return rows.flatMap(row => row.sessionFile && ((row.activeSessionId !== undefined && row.lifecycle !== "archived") || waking.has(row.sessionId)) ? [{ sessionFile: row.sessionFile }] : []);
}

/** Runs `sweepTmp` every `everyMs` on /tmp, one sweep at a time, and logs what each one freed. Returns the stop. */
export function startTmpSweep(input: { rows: () => readonly { sessionId: string; sessionFile?: string; activeSessionId?: string; lifecycle?: string }[];
  waking: () => Promise<ReadonlySet<string>>; idleMs: () => number | null; log: (line: string) => void; everyMs: number; root?: string }): () => void {
  const root = input.root ?? "/tmp";
  const source: TmpSweepSource = {
    root, idleMs: input.idleMs, now: () => Date.now(),
    entries: () => { const idleMs = input.idleMs(); return tmpEntries(root, Date.now() - (idleMs ?? 0)); },
    keepers: async () => keepersOf(input.rows(), await input.waking().catch(() => new Set<string>())),
    namedSince,
    inside: paths => leftoverSource.inside(paths),
    remove: async paths => {
      const removed: string[] = [];
      for (const path of paths) if (await removeTree(path)) removed.push(path);
      return removed;
    },
    pruneCaches: beforeMs => pruneCaches(root, beforeMs),
  };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void sweepTmp(source).then(swept => {
      if (!swept.removed.length && !swept.cacheBytes) return;
      const shown = swept.removed.slice(0, 5).join(", ") + (swept.removed.length > 5 ? ` and ${swept.removed.length - 5} more` : "");
      input.log(`tmp sweep: deleted ${swept.removed.length} entries nobody held or named${shown ? ` (${shown})` : ""}, pruned ${(swept.cacheBytes / 1024 ** 2).toFixed(0)} MB of compile cache`);
    }).catch(error => input.log(`tmp sweep: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
  const timer = setInterval(run, input.everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
