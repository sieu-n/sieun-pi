import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chatDataDir } from "../../src/owner-ok.ts";
import { misses, readWatch, TARGET, type TargetPart, type WatchLine } from "../../src/mac-usable-watch.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Mac stays usable duty's precheck (`node --import tsx scripts/duties/mac-stays-usable.ts`): reads the chat service's Mac usable watch
 * (src/mac-usable-watch.ts, one line a minute) and reports the share of minutes on the harness target over the last hour and the last 24 h, the
 * minutes each target part missed, the top miss with the chat trees behind it, and the longest run of minutes off target in the last hour. A run
 * of OFF_STREAK_ALERT or more is flagged as an alert for the duty job to tell the chat. No model call.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Minutes off target in a row that make an alert: the 10 the harness team set for this duty on 10-14. */
export const OFF_STREAK_ALERT = 10;

const PARTS: readonly TargetPart[] = ["footprint", "idle", "queue"];
const PART_WORDS: Record<TargetPart, string> = {
  footprint: `Prime worker footprint over ${TARGET.footprintGb} GB`,
  idle: `working sessions quiet over ${TARGET.idleMinutes} min`,
  queue: `a queued turn waiting over ${TARGET.queueWaitS} s`,
};

const pct = (on: number, of: number): number => of ? Math.round(on / of * 1000) / 10 : 0;
const clock = (at: string): string => new Date(at).toTimeString().slice(0, 5);

/** The longest run of consecutive off-target lines, with its first and last line; a gap of more than 2 minutes between lines ends a run. */
export function longestOffStreak(lines: readonly WatchLine[]): { minutes: number; from?: string; to?: string } {
  let best: { minutes: number; from?: string; to?: string } = { minutes: 0 };
  let minutes = 0, from = "", last = -Infinity;
  for (const line of lines) {
    const at = Date.parse(line.at);
    const off = misses(line).length > 0;
    minutes = off ? (at - last > 2 * MINUTE ? 1 : minutes + 1) : 0;
    if (minutes === 1) from = line.at;
    if (minutes > best.minutes) best = { minutes, from, to: line.at };
    last = at;
  }
  return best;
}

/** The chat trees behind a part's misses: the footprint by tree summed over the top workers of each missed minute and averaged, the quiet sessions by tree, or the tree of the oldest queued turn. */
export function treesBehind(part: TargetPart, missed: readonly WatchLine[]): string {
  const totals = new Map<string, number>();
  const add = (tree: string, value: number) => totals.set(tree, (totals.get(tree) ?? 0) + value);
  for (const line of missed) {
    if (part === "footprint") for (const worker of line.top) add(worker.tree, worker.gb / missed.length);
    else if (part === "idle") for (const tree of line.idleTrees) add(tree.tree, tree.count / missed.length);
    else if (line.queue?.oldestTree) add(line.queue.oldestTree, 1);
  }
  const unit = part === "footprint" ? " GB" : part === "idle" ? " sessions" : " min";
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tree, value]) => `${tree} ${Math.round(value * 10) / 10}${unit}`).join(", ");
}

/** The precheck output for the lines of the last 24 h at `now`. */
export function measure(lines: readonly WatchLine[], now: number): PrecheckOutput {
  const hour = lines.filter(line => Date.parse(line.at) > now - HOUR);
  const missMinutes = Object.fromEntries(PARTS.map(part => [part, hour.filter(line => misses(line).includes(part))])) as Record<TargetPart, WatchLine[]>;
  const streak = longestOffStreak(hour);
  const latest = hour.at(-1);
  const metrics: Record<string, number> = {
    on_target_pct_1h: pct(hour.filter(line => !misses(line).length).length, hour.length),
    on_target_pct_24h: pct(lines.filter(line => !misses(line).length).length, lines.length),
    footprint_miss_min_1h: missMinutes.footprint.length,
    idle_miss_min_1h: missMinutes.idle.length,
    queue_miss_min_1h: missMinutes.queue.length,
    off_streak_max_1h: streak.minutes,
    worker_gb_now: latest?.workerGb ?? 0,
    watched_min_1h: hour.length,
  };
  const flagged: FlaggedSlice[] = [];
  const top = PARTS.reduce<TargetPart | null>((best, part) => missMinutes[part].length > (best ? missMinutes[best].length : 0) ? part : best, null);
  if (top) {
    flagged.push({ kind: "top_miss", item: top, excerpt: `Top miss: ${PART_WORDS[top]} in ${missMinutes[top].length} of ${hour.length} minutes. ` +
      `Chat trees behind it: ${treesBehind(top, missMinutes[top]) || "none named"}.` });
  }
  if (streak.minutes >= OFF_STREAK_ALERT) {
    flagged.push({ kind: "alert", excerpt: `The harness side was off target ${streak.minutes} minutes in a row, ${clock(streak.from!)} to ${clock(streak.to!)}.` });
  }
  if (!hour.length) flagged.push({ kind: "no_watch", excerpt: "The Mac usable watch wrote no line in the last hour: the chat service is down or runs a release without the watch." });
  if (latest) {
    flagged.push({ kind: "now", at: Date.parse(latest.at), excerpt: `At ${clock(latest.at)}: ${latest.workers} workers hold ${latest.workerGb} GB (top: ${latest.top.map(worker =>
      `${worker.tree} ${worker.gb} GB`).join(", ")}); ${latest.live} live sessions, ${latest.working} working, ${latest.idleOver} quiet over ${TARGET.idleMinutes} min; ` +
      `${latest.finished} finished jobs not deleted (${latest.finishedTrees.map(tree => `${tree.tree} ${tree.count}`).join(", ") || "none"}); ` +
      `queue ${latest.queue ? `${latest.queue.working} working, ${latest.queue.queued} queued, oldest ${latest.queue.oldestWaitS} s` : "unread"}. ` +
      `Context, not a target: swap ${latest.mac.swapGb ?? "?"} GB, pressure level ${latest.mac.pressureLevel ?? "?"}.` });
  }
  return { metrics, flagged };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("mac-stays-usable: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  await writeFile(output, JSON.stringify(measure(await readWatch(chatDataDir(), now - 24 * HOUR, now), now), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
