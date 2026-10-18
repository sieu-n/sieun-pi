import { readFile } from "node:fs/promises";
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
