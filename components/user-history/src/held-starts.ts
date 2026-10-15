import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobRegistry } from "./chat-sources.ts";

/**
 * The root starts agents queued while the fleet budget was closed (src/message-limit-check.py writes `<data dir>/held-starts/<ticket>.json`),
 * by the chat they belong to: the chat the job registry gave the name when the cell ran, else the session that asked when it is that chat.
 * A start whose kernel is gone is left out, since nothing will send it. The check-in reads these as starts that wait (`starting`), the same
 * as the server's own starts in the fleet budget.
 */
export interface HeldStart { ticket: string; name: string; parent?: string; pid: number; at: number }
export const HELD_STARTS_DIR = "held-starts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

export async function readHeldStarts(dataDir: string, isAlive: (pid: number) => boolean = alive): Promise<HeldStart[]> {
  const dir = join(dataDir, HELD_STARTS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: HeldStart[] = [];
  for (const name of names.filter(entry => entry.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(join(dir, name), "utf8")) as Partial<HeldStart>;
      if (typeof value.name !== "string" || typeof value.pid !== "number" || !isAlive(value.pid)) continue;
      found.push({ ticket: String(value.ticket ?? name.replace(/\.json$/, "")), name: value.name, pid: value.pid, at: Number(value.at ?? 0),
        ...(typeof value.parent === "string" ? { parent: value.parent } : {}) });
    } catch { continue; }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The names of `chat`'s held starts. */
export async function heldStartsOf(starts: readonly HeldStart[], registry: Pick<JobRegistry, "chatOf"> | undefined, chat: string): Promise<string[]> {
  const names: string[] = [];
  for (const start of starts) if ((await registry?.chatOf(start.name).catch(() => undefined) ?? start.parent) === chat) names.push(start.name);
  return names;
}
