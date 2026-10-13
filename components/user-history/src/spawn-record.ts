import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** What the daemon stored at a subagent's spawn (`<child folder>/rlm-subagent.json`): the brief as the parent wrote it, and when. Null when unreadable. */
export async function spawnRecord(childDir: string): Promise<{ prompt: string; createdAt: number } | null> {
  try {
    const record: unknown = JSON.parse(await readFile(join(childDir, "rlm-subagent.json"), "utf8"));
    if (typeof record !== "object" || record === null) return null;
    const { prompt, createdAt } = record as { prompt?: unknown; createdAt?: unknown };
    return typeof prompt === "string" && typeof createdAt === "number" && Number.isFinite(createdAt) ? { prompt, createdAt } : null;
  } catch { return null; }
}

/**
 * The latest spawn of the chat before `at`, from the subagent folders in its artifacts folder `dir`; null when there is none. `times` holds each
 * folder's spawn time once read (they never change).
 */
export async function previousSpawn(dir: string, at: number, times: Map<string, number>): Promise<number | null> {
  let previous: number | null = null;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const childDir = join(dir, entry.name);
    let created = times.get(childDir);
    if (created === undefined) {
      created = (await spawnRecord(childDir))?.createdAt;
      if (created === undefined) continue;
      times.set(childDir, created);
    }
    if (created < at && (previous === null || created > previous)) previous = created;
  }
  return previous;
}
