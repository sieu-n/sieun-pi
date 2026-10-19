import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The sessions the idle unload stopped (src/idle-unload.ts), `{ <session id>: <ISO time> }`. The daemon's kill archives the session, and
 * resume_paused.py reads this file so that archive does not hide a turn that failed before it: in the 10-16 to 10-17 token hook outage the
 * unload stopped 16 root jobs right after a failed turn, and none got a continue once the hook worked again.
 */
export const UNLOADED_FILE = "unloaded.json";
/** Two days, past the resume pass's 24 h look-back. */
const KEEP_MS = 48 * 60 * 60_000;

/** The write under way for each file, so concurrent stops in one process append in turn instead of racing on one temp file. */
const writes = new Map<string, Promise<void>>();

/**
 * Adds `sessions` stopped at `at` to UNLOADED_FILE and drops entries older than KEEP_MS, through a temp file. Calls queue per file: since
 * ed0ffc2 the idle unload stops a sweep's sessions at once, and on 10-18 from 04:05Z on the Mac 35 of its records failed with ENOENT on the
 * shared temp file's rename, and each record that lost the race dropped its session from the file.
 */
export function recordUnloaded(dataDir: string, sessions: readonly string[], at: number): Promise<void> {
  if (!sessions.length) return Promise.resolve();
  const file = join(dataDir, UNLOADED_FILE);
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(() => write(file, sessions, at));
  const tail = next.catch(() => {});
  writes.set(file, tail);
  void tail.then(() => { if (writes.get(file) === tail) writes.delete(file); });
  return next;
}

async function write(file: string, sessions: readonly string[], at: number): Promise<void> {
  let kept: Record<string, string> = {};
  try {
    const read = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof read === "object" && read !== null && !Array.isArray(read))
      kept = Object.fromEntries(Object.entries(read).filter((entry): entry is [string, string] => typeof entry[1] === "string" && at - Date.parse(entry[1]) <= KEEP_MS));
  } catch { kept = {}; }
  for (const session of sessions) kept[session] = new Date(at).toISOString();
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(kept)).then(() => rename(temp, file));
}

/**
 * One line of UNLOAD_RECEIPTS per idle kill: `sent` right before the kill goes out, then `stopped` or `failed` with the daemon's answer. On
 * 10-19 at 16:22:14-17Z 17 kills timed out after 30 s, the service log named each by the first 8 characters of its session id, and nothing
 * else was written, so rb-p161-p143 (01a154b8-96c6-765e-ac87-ffc09f8fc16d) went archived at 16:22:16Z with no record that the unload had
 * asked: a `sent` line with no `stopped` line now says exactly that.
 */
export const UNLOAD_RECEIPTS = "unload-receipts.jsonl";
export interface UnloadReceipt { at: string; phase: "sent" | "stopped" | "failed"; sessionId: string; activeSessionId: string; why: "idle" | "pool wait"; error?: string }

/** Appends one receipt line; one write per line, so lines from concurrent stops do not interleave. */
export function writeReceipt(dataDir: string, receipt: UnloadReceipt): Promise<void> {
  return appendFile(join(dataDir, UNLOAD_RECEIPTS), JSON.stringify(receipt) + "\n");
}
