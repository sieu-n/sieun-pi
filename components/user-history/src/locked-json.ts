import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
const exists = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "EEXIST";
const dead = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ESRCH";

export interface JsonFile<T> { path: string; label: string; parse(value: unknown): T; initial(): T }

export async function readJsonFile<T>(file: JsonFile<T>): Promise<T> { return file.parse(JSON.parse(await readFile(file.path, "utf8"))); }

async function acquire(file: JsonFile<unknown>): Promise<string> {
  const lock = file.path + ".lock";
  const deadline = Date.now() + 3000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(lock + "/pid.tmp", String(process.pid), { mode: 0o600 }); await rename(lock + "/pid.tmp", lock + "/pid"); return lock; }
    catch (error) {
      if (!exists(error)) throw error;
      let stale = false;
      try {
        const pid = Number(await readFile(lock + "/pid", "utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid ${file.label} lock owner`);
        try { process.kill(pid, 0); } catch (error) { stale = dead(error); }
      } catch (error) {
        if (!missing(error)) throw error;
        try { stale = Date.now() - (await stat(lock)).mtimeMs > 30000; } catch (error) { if (!missing(error)) throw error; }
      }
      if (stale) {
        const recovery = lock + ".recovery";
        try {
          await mkdir(recovery, { mode: 0o700 });
          try {
            const owner = Number(await readFile(lock + "/pid", "utf8").catch(error => { if (missing(error)) return "0"; throw error; }));
            let gone = owner === 0 && Date.now() - (await stat(lock)).mtimeMs > 30000;
            if (owner > 0) try { process.kill(owner, 0); } catch (error) { gone = dead(error); }
            if (gone) await rm(lock, { recursive: true, force: true });
          } finally { await rm(recovery, { recursive: true, force: true }); }
        } catch (error) { if (!exists(error)) throw error; }
        if (Date.now() >= deadline) throw new Error(`${file.label} recovery is busy`);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`${file.label} is busy`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

/** Read, change, and atomically replace a private JSON file under a cross-process lock. The file is written only when the change altered it. */
export async function transactJsonFile<T, R = void>(file: JsonFile<T>, change: (state: T) => R): Promise<{ state: T; result: R }> {
  await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
  const lock = await acquire(file);
  const temporary = file.path + "." + randomUUID();
  try {
    let state: T; let before: string | undefined;
    try { state = await readJsonFile(file); before = JSON.stringify(state); }
    catch (error) { if (!missing(error)) throw error; state = file.initial(); }
    const result = change(state);
    const after = JSON.stringify(state);
    if (after !== before) { await writeFile(temporary, after, { mode: 0o600 }); await rename(temporary, file.path); }
    return { state, result };
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }); }
}

export async function snapshotJsonFile<T>(file: JsonFile<T>): Promise<T> {
  try { return await readJsonFile(file); }
  catch (error) { if (!missing(error)) throw error; return (await transactJsonFile(file, () => {})).state; }
}
