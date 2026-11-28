/**
 * The owner's own PATCH of a conversation, read back from the request log (request-log.ts), for `App.adoptOwnerModel`: a model he set from
 * his page before 11-28 left no record of who set it, and on 11-28 fable-sweep.ts flagged agent factory for the Fable 5.2 he had set at
 * 19:19 KST, whose only trace was one server line `PATCH /api/c/dm_agent-factory` via tailnet.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dayOf, type RequestTiming } from "./request-log.ts";

const DAY = 86_400_000;

/**
 * Whether the log in `dir` holds an answered PATCH of one of `paths` that the server took at `at` from the owner's page (a server line via
 * tailnet), and when a caller on the box last sent a PATCH of them after it, which may have changed what he set.
 */
export async function ownerPatch(dir: string, paths: readonly string[], at: number, now = Date.now()): Promise<{ owner: boolean; later?: number }> {
  const lines: RequestTiming[] = [];
  for (let day = Date.parse(dayOf(at)); Number.isFinite(day) && day <= now; day += DAY) {
    const text = await readFile(join(dir, `${dayOf(day)}.jsonl`), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"PATCH"')) continue;
      const one = JSON.parse(line) as RequestTiming;
      if (one.src === "server" && one.m === "PATCH" && one.s === 200 && paths.includes(one.p)) lines.push(one);
    }
  }
  const later = lines.filter(one => one.at > at && one.via !== "tailnet").map(one => one.at);
  return { owner: lines.some(one => one.at === at && one.via === "tailnet"), ...(later.length ? { later: Math.max(...later) } : {}) };
}
