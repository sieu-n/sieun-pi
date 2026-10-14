import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clockTime } from "./checkin-settings.ts";
import { spawnRecord } from "./spawn-record.ts";
import type { PlanItem } from "./shared/types.ts";

/**
 * What a fresh job needs to pick up the work of a job the chat ended while it waited on a board step: the job's brief, its last report to the
 * chat, and the wait (each step's waitFor or waitUntil).
 */
export interface JobResume { chat: string; childId: string; job: string; steps: string[]; event: string; brief: string; report: string; endedAt: number }

/** `<data dir>/job-resumes/<chat>/<child id>.json`, one file per ended job. */
export interface JobResumes {
  /** Writes the saved state and returns its path. */
  save(resume: JobResume): Promise<string>;
  read(path: string): Promise<JobResume>;
}
export function jobResumes(dir: string): JobResumes {
  return {
    async save(resume) {
      const folder = join(dir, resume.chat);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, `${resume.childId}.json`);
      await writeFile(path + ".tmp", JSON.stringify(resume, null, 1), { mode: 0o600 });
      await rename(path + ".tmp", path);
      return path;
    },
    async read(path) { return JSON.parse(await readFile(path, "utf8")) as JobResume; },
  };
}

/**
 * A job's brief: the prompt the daemon stored at the spawn (`rlm-subagent.json`, which keeps prompts of 4,096 characters or fewer), else the
 * first user message of the job's session file in its folder `childDir`. Undefined when neither can be read.
 */
export async function jobBrief(childDir: string): Promise<string | undefined> {
  const spawn = await spawnRecord(childDir);
  if (spawn) return spawn.prompt;
  const names = await readdir(childDir).catch(() => [] as string[]);
  for (const name of names.filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl")) {
    const lines = createInterface({ input: createReadStream(join(childDir, name), "utf8"), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"role":"user"')) continue;
        const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
        if (entry.message?.role !== "user") continue;
        const content = entry.message.content;
        return typeof content === "string" ? content
          : Array.isArray(content) ? content.map(part => typeof part === "object" && part && "text" in part ? String(part.text) : "").join("") : undefined;
      }
    } finally { lines.close(); }
  }
  return undefined;
}

/** What a step holds, as one line: `p12 waits for "the r14 sha"`, `p12 waits until 2026-10-14T12:00:00Z`, or `p12 is doing` for a step with no wait. */
export function waitText(item: PlanItem): string {
  const waits = [item.waitFor !== undefined ? `for "${item.waitFor}"` : "", item.waitUntil !== undefined ? `until ${item.waitUntil}` : ""].filter(Boolean);
  return waits.length ? `${item.id} waits ${waits.join(" and ")}` : `${item.id} is ${item.status}`;
}

const SAVED = "Saved state: ";
/** The line the cleanup puts first in a step's note when it ends the step's job, naming the saved state's path. */
export const savedStateNote = (job: string, endedAt: number, path: string): string =>
  `${SAVED}job ${job} ended at ${clockTime(endedAt)} while it was quiet; its brief, last report and wait are in ${path}.`;
/** The saved state path a step's note names (`savedStateNote`), or undefined. */
export function savedStatePath(item: Pick<PlanItem, "note">): string | undefined {
  const line = item.note?.split("\n").find(text => text.startsWith(SAVED));
  return line === undefined ? undefined : / are in (\S+\.json)\.$/.exec(line)?.[1];
}
