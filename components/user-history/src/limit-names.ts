import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The job names the chats know, for the c43 limit check: the job of each plan step on every board, and each root job in chat-jobs.json. A name
 * like "instagram 401 ceiling" (a Crawler VP job) then reads as a name, not as a ceiling. A file that cannot be read adds nothing.
 */
export async function jobNames(dataDir: string): Promise<string[]> {
  const names = new Set<string>();
  const boards = join(dataDir, "boards");
  const files = await readdir(boards).catch(() => [] as string[]);
  await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => {
    try {
      const board = JSON.parse(await readFile(join(boards, file), "utf8")) as { plan?: unknown };
      const walk = (items: unknown): void => {
        if (!Array.isArray(items)) return;
        for (const item of items as { job?: unknown; children?: unknown }[]) {
          if (typeof item?.job === "string" && item.job.trim()) names.add(item.job.trim());
          walk(item?.children);
        }
      };
      walk(board.plan);
    } catch { /* no names from this board */ }
  }));
  try {
    const registry = JSON.parse(await readFile(join(dataDir, "chat-jobs.json"), "utf8")) as { jobs?: Record<string, unknown> };
    for (const name of Object.keys(registry.jobs ?? {})) if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(name)) names.add(name);
  } catch { /* no registry */ }
  return [...names];
}
