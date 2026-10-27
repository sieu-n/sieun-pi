import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
const exists = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "EEXIST";
const dead = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ESRCH";

export interface JsonFile<T> { path: string; label: string; parse(value: unknown): T; initial(): T }

export async function readJsonFile<T>(file: JsonFile<T>): Promise<T> { return file.parse(JSON.parse(await readFile(file.path, "utf8"))); }

/** Lock and recovery folders older than this with no owner pid are left over from a process that died before it wrote one. */
const staleMs = 30000;

/** The pid written in `dir`, or null when it has none yet. */
async function ownerOf(dir: string, label: string): Promise<number | null> {
  try {
    const pid = Number(await readFile(dir + "/pid", "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid ${label} lock owner`);
    return pid;
  } catch (error) { if (missing(error)) return null; throw error; }
}

/** True when the owner of `dir` is gone, or when `dir` has no owner and is older than `staleMs`. */
async function abandoned(dir: string, owner: number | null): Promise<boolean> {
  if (owner !== null) { try { process.kill(owner, 0); return false; } catch (error) { return dead(error); } }
  try { return Date.now() - (await stat(dir)).mtimeMs > staleMs; } catch (error) { if (missing(error)) return false; throw error; }
}

/** Writes this process as the owner of `dir`. A hard link fails when the pid file exists, so of two processes only one owns it. */
async function own(dir: string): Promise<boolean> {
  const temporary = `${dir}/pid.${randomUUID()}`;
  await writeFile(temporary, String(process.pid), { mode: 0o600 });
  try { await link(temporary, dir + "/pid"); return true; }
  catch (error) { if (exists(error)) return false; throw error; }
  finally { await rm(temporary, { force: true }); }
}

/**
 * Enters `recovery`, which lets one process at a time clear a stale lock. A recovery folder whose owner died, as one did in the chat service
 * restart on us-metal02 on 10-23 and so failed every archive with "recovery is busy", is taken over in place: its pid file moves aside by a
 * rename that only one process can win, so no process removes a recovery folder that another process may hold.
 */
async function enterRecovery(recovery: string, label: string): Promise<boolean> {
  try {
    try { await mkdir(recovery, { mode: 0o700 }); return await own(recovery); } catch (error) { if (!exists(error)) throw error; }
    const owner = await ownerOf(recovery, label);
    if (!await abandoned(recovery, owner)) return false;
    if (owner === null) return await own(recovery);
    const aside = `${recovery}/${randomUUID()}`;
    await rename(recovery + "/pid", aside);
    if (Number(await readFile(aside, "utf8")) === owner) return await own(recovery);
    await link(aside, recovery + "/pid").catch(error => { if (!exists(error)) throw error; });
    await rm(aside, { force: true });
    return false;
  } catch (error) { if (missing(error)) return false; throw error; }
}

async function acquire(file: JsonFile<unknown>): Promise<string> {
  const lock = file.path + ".lock";
  const deadline = Date.now() + 3000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(lock + "/pid.tmp", String(process.pid), { mode: 0o600 }); await rename(lock + "/pid.tmp", lock + "/pid"); return lock; }
    catch (error) {
      if (!exists(error)) throw error;
      if (await abandoned(lock, await ownerOf(lock, file.label))) {
        const recovery = lock + ".recovery";
        const entered = await enterRecovery(recovery, file.label);
        if (entered) {
          try { if (await abandoned(lock, await ownerOf(lock, file.label))) await rm(lock, { recursive: true, force: true }); }
          finally { await rm(recovery, { recursive: true, force: true }); }
        }
        if (Date.now() >= deadline) throw new Error(`${file.label} recovery is busy`);
        if (!entered) await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`${file.label} is busy`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

/** Runs `task` under the cross-process lock of `path` (`<path>.lock`), for a file that is not one JSON value, such as an append-only JSONL log. */
export async function withFileLock<R>(path: string, label: string, task: () => Promise<R>): Promise<R> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquire({ path, label, parse: value => value, initial: () => null });
  try { return await task(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

/** Read, change, and atomically replace a private JSON file under a cross-process lock. The file is written only when the change altered it. */
/**
 * Read, change, and atomically replace a private JSON file under a cross-process lock. The file is written only when the change altered it.
 * A file read through `cachedJsonFile` skips the read and parse while the file is as this process last saw it, and its cache takes the written
 * state, so the next read parses nothing: on 10-20 a scratch serve on a copy of the live data dir with its chats parsed extension-loads.json
 * (337 KB) 64 times and check-ins.json (700 KB) 29 times a minute, 1.4 s of main thread, mostly right after its own writes. The state such a
 * file returns is the cached value, which the caller must not change.
 */
export async function transactJsonFile<T, R = void>(file: JsonFile<T>, change: (state: T) => R): Promise<{ state: T; result: R }> {
  await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
  const lock = await acquire(file);
  const temporary = file.path + "." + randomUUID();
  try {
    let state: T; let before: string | undefined;
    const cached = parsed.get(file.path);
    const hit = cached?.text !== undefined && cached.key === await statKey(file.path) ? cached : undefined;
    if (hit) { state = structuredClone(hit.value) as T; before = hit.text; }
    else {
      try { state = await readJsonFile(file); before = JSON.stringify(state); }
      catch (error) { if (!missing(error)) throw error; state = file.initial(); }
    }
    const result = change(state);
    const after = JSON.stringify(state);
    if (after !== before) { await writeFile(temporary, after, { mode: 0o600 }); await rename(temporary, file.path); }
    if (cached) { const key = await statKey(file.path); if (key) parsed.set(file.path, { key, value: state, text: after }); }
    return { state, result };
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }); }
}

/** The file's inode, size, change and modify times, which a rename in `transactJsonFile` always moves; null for a missing file. */
async function statKey(path: string): Promise<string | null> {
  try { const info = await stat(path, { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
  catch (error) { if (!missing(error)) throw error; return null; }
}

/** Parsed files by path, with their `statKey` and, once this process wrote one, the JSON it wrote. */
const parsed = new Map<string, { key: string; value: unknown; text?: string }>();

/**
 * `snapshotJsonFile` for a file read on every catalog projection: it parses again only after the file's inode, size or change time moved, and
 * `transactJsonFile` replaces the file by rename, so each write gets a new inode. On 10-18 a scratch copy of the box chat parsed
 * chat-jobs.json (38 KB) 3,839 times and extension-loads.json (191 KB) 297 times in 80 s, 5.1 s of its main thread. Callers share the value
 * and must not change it.
 */
export async function cachedJsonFile<T>(file: JsonFile<T>): Promise<T> {
  const key = await statKey(file.path);
  if (key === null) return snapshotJsonFile(file);
  const hit = parsed.get(file.path);
  if (hit?.key === key) return hit.value as T;
  const value = await snapshotJsonFile(file);
  parsed.set(file.path, { key, value });
  return value;
}

export async function snapshotJsonFile<T>(file: JsonFile<T>): Promise<T> {
  try { return await readJsonFile(file); }
  catch (error) { if (!missing(error)) throw error; return (await transactJsonFile(file, () => {})).state; }
}
