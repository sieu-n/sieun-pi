import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The cross-process lock of one file: a `<file>.lock` directory that holds the owner's pid.
 *
 * It is the protocol of user-history's `locked-json.ts`, prime-sync's `LedgerLock` and the vendored `harness.py`, so every writer of
 * `harness_state.json` excludes every other. A lock whose owner died, or that has no owner and is older than 30 s, is cleared through a
 * `<file>.lock.recovery` directory that one process at a time can own.
 */

const staleMs = 30_000;
const waitMs = 120_000;

const code = (error: unknown): string | undefined => (error instanceof Error && "code" in error ? String(error.code) : undefined);

async function ownerOf(dir: string): Promise<number | null> {
  try {
    const pid = Number(await readFile(dir + "/pid", "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

async function abandoned(dir: string, owner: number | null): Promise<boolean> {
  if (owner !== null) {
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      return code(error) === "ESRCH";
    }
  }
  try {
    return Date.now() - (await stat(dir)).mtimeMs > staleMs;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function own(dir: string): Promise<boolean> {
  const temporary = `${dir}/pid.${randomUUID()}`;
  await writeFile(temporary, String(process.pid), { mode: 0o600 });
  try {
    await link(temporary, dir + "/pid");
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function enterRecovery(recovery: string): Promise<boolean> {
  try {
    try {
      await mkdir(recovery, { mode: 0o700 });
      return await own(recovery);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const owner = await ownerOf(recovery);
    if (!(await abandoned(recovery, owner))) return false;
    if (owner === null) return await own(recovery);
    const aside = `${recovery}/${randomUUID()}`;
    await rename(recovery + "/pid", aside);
    if (Number(await readFile(aside, "utf8")) === owner) return await own(recovery);
    await link(aside, recovery + "/pid").catch(error => {
      if (code(error) !== "EEXIST") throw error;
    });
    await rm(aside, { force: true });
    return false;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function acquire(path: string): Promise<string> {
  const lock = path + ".lock";
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(lock + "/pid.new", String(process.pid), { mode: 0o600 });
      await rename(lock + "/pid.new", lock + "/pid");
      return lock;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    if (await abandoned(lock, await ownerOf(lock))) {
      const recovery = lock + ".recovery";
      const entered = await enterRecovery(recovery);
      if (entered) {
        try {
          if (await abandoned(lock, await ownerOf(lock))) await rm(lock, { recursive: true, force: true });
        } finally {
          await rm(recovery, { recursive: true, force: true });
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`${path} is locked by another writer (${lock})`);
    await pause(5 + Math.random() * 20);
  }
}

/** Runs `task` while this process holds `<path>.lock`. */
export async function withFileLock<R>(path: string, task: () => Promise<R> | R): Promise<R> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquire(path);
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
