import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The sessions the idle unload stopped (src/idle-unload.ts), `{ <session id>: <ISO time> }`. The daemon's kill archives the session, and
 * resume_paused.py reads this file so that archive does not hide a turn that failed before it: in the 10-16 to 10-17 token hook outage the
 * unload stopped 16 root jobs right after a failed turn, and none got a continue once the hook worked again.
 */
export const UNLOADED_FILE = "unloaded.json";
/** Two days, past the resume pass's 24 h look-back. */
const KEEP_MS = 48 * 60 * 60_000;

/** Adds `sessions` stopped at `at` to UNLOADED_FILE and drops entries older than KEEP_MS, through a temp file. */
export async function recordUnloaded(dataDir: string, sessions: readonly string[], at: number): Promise<void> {
  if (!sessions.length) return;
  const file = join(dataDir, UNLOADED_FILE);
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
