import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chatDataDir } from "../../src/owner-ok.ts";
import { misses, readWatch, TARGET, unusable, USABLE, type TargetPart, type UsableMiss, type WaiterLine, type WatchLine } from "../../src/mac-usable-watch.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Mac stays usable duty's precheck (`node --import tsx scripts/duties/mac-stays-usable.ts`): reads the chat service's Mac usable watch
 * (src/mac-usable-watch.ts, one line a minute) and reports the share of minutes the Mac was usable (`USABLE`, from ops guy's pressure feed) over
 * the last hour and the last 24 h, the minutes each harness part missed, the top miss with the chat trees behind it, and the longest run of
 * unusable minutes in the last hour. A run of OFF_STREAK_ALERT or more is flagged as an alert for the duty job to tell the chat. The Prime
 * worker footprint is a detail line with no target. No model call.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Unusable minutes in a row that make an alert: the 10 the harness team set for this duty on 10-14. */
export const OFF_STREAK_ALERT = 10;

const PARTS: readonly TargetPart[] = ["usable", "idle", "queue"];
const PART_WORDS: Record<TargetPart, string> = {
  usable: `the Mac unusable (memory pressure critical, ${USABLE.swapoutsPerS} or more swapouts a second, or kernel_task at ${USABLE.kernelTaskPct}% of a core or more)`,
  idle: `working sessions quiet over ${TARGET.idleMinutes} min`,
  queue: `a queued turn waiting over ${TARGET.queueWaitS} s`,
};
const USABLE_WORDS: Record<UsableMiss, string> = { pressure: "pressure critical", swapouts: "swapouts", kernel_task: "kernel_task" };

const pct = (on: number, of: number): number => of ? Math.round(on / of * 1000) / 10 : 0;
const clock = (at: string): string => new Date(at).toTimeString().slice(0, 5);
const isUnusable = (line: WatchLine): boolean => misses(line).includes("usable");

/** The longest run of consecutive unusable lines, with its first and last line; a gap of more than 2 minutes between lines ends a run. */
export function longestOffStreak(lines: readonly WatchLine[]): { minutes: number; from?: string; to?: string } {
  let best: { minutes: number; from?: string; to?: string } = { minutes: 0 };
  let minutes = 0, from = "", last = -Infinity;
  for (const line of lines) {
    const at = Date.parse(line.at);
    minutes = isUnusable(line) ? (at - last > 2 * MINUTE ? 1 : minutes + 1) : 0;
    if (minutes === 1) from = line.at;
    if (minutes > best.minutes) best = { minutes, from, to: line.at };
    last = at;
  }
  return best;
}

/** The chat trees behind a part's misses: the worker footprint by tree summed over the top workers of each missed minute and averaged, the quiet sessions by tree, or the tree of the oldest queued turn. */
export function treesBehind(part: TargetPart, missed: readonly WatchLine[]): string {
  const totals = new Map<string, number>();
  const add = (tree: string, value: number) => totals.set(tree, (totals.get(tree) ?? 0) + value);
  for (const line of missed) {
    if (part === "usable") for (const worker of line.top) add(worker.tree, worker.gb / missed.length);
    else if (part === "idle") for (const tree of line.idleTrees) add(tree.tree, tree.count / missed.length);
    else if (line.queue?.oldestTree) add(line.queue.oldestTree, 1);
  }
  const unit = part === "usable" ? " GB" : part === "idle" ? " sessions" : " min";
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tree, value]) => `${tree} ${Math.round(value * 10) / 10}${unit}`).join(", ");
}

/**
 * The precheck output for the lines of the last 24 h at `now`. The usable shares count only minutes with a fresh feed reading, and are left out
 * when no line has one, so the run is an error that names them rather than a share of nothing.
 */
export function measure(lines: readonly WatchLine[], now: number): PrecheckOutput {
  const hour = lines.filter(line => Date.parse(line.at) > now - HOUR);
  const fed = (span: readonly WatchLine[]) => span.filter(line => line.usable);
  const missMinutes = Object.fromEntries(PARTS.map(part => [part, hour.filter(line => misses(line).includes(part))])) as Record<TargetPart, WatchLine[]>;
  const streak = longestOffStreak(hour);
  const latest = hour.at(-1);
  const metrics: Record<string, number> = {
    ...(fed(hour).length ? { usable_pct_1h: pct(fed(hour).length - missMinutes.usable.length, fed(hour).length) } : {}),
    ...(fed(lines).length ? { usable_pct_24h: pct(fed(lines).filter(line => !isUnusable(line)).length, fed(lines).length) } : {}),
    unusable_streak_max_1h: streak.minutes,
    idle_miss_min_1h: missMinutes.idle.length,
    queue_miss_min_1h: missMinutes.queue.length,
    kernel_waiters_1h: 0,
  };
  const flagged: FlaggedSlice[] = [];
  const waiters = new Map<number, WaiterLine>();
  for (const line of hour) for (const waiter of line.waiters ?? []) waiters.set(waiter.pid, waiter);
  metrics.kernel_waiters_1h = waiters.size;
  for (const waiter of waiters.values()) {
    flagged.push({ kind: "kernel_waiter", item: String(waiter.pid), excerpt: `${waiter.tree}, job ${waiter.job}, pid ${waiter.pid}, \`${waiter.command}\`, ` +
      `${waiter.ageMin ?? "?"} min: ${waiter.quietMin === undefined ? "a background wait in a kernel" : `a bash() handle held ${waiter.quietMin} min past its turn end`}; ` +
      "the chat was asked to move it to board.wake." });
  }
  if (fed(hour).length) {
    const why = (["pressure", "swapouts", "kernel_task"] as const).map(miss => [miss, missMinutes.usable.filter(line => unusable(line.usable!).includes(miss)).length] as const);
    flagged.push({ kind: "usable", excerpt: `The Mac was usable in ${fed(hour).length - missMinutes.usable.length} of the ${fed(hour).length} minutes with a feed reading in the last hour ` +
      `(${hour.length} watched)${missMinutes.usable.length ? `; unusable minutes by cause: ${why.filter(([, count]) => count).map(([miss, count]) => `${USABLE_WORDS[miss]} ${count}`).join(", ")}` : ""}.` });
  }
  const top = PARTS.reduce<TargetPart | null>((best, part) => missMinutes[part].length > (best ? missMinutes[best].length : 0) ? part : best, null);
  if (top) {
    flagged.push({ kind: "top_miss", item: top, excerpt: `Top miss: ${PART_WORDS[top]} in ${missMinutes[top].length} of ${hour.length} minutes. ` +
      `Chat trees behind it${top === "usable" ? ", by Prime worker footprint in those minutes" : ""}: ${treesBehind(top, missMinutes[top]) || "none named"}.` });
  }
  if (streak.minutes >= OFF_STREAK_ALERT) {
    flagged.push({ kind: "alert", excerpt: `The Mac was unusable ${streak.minutes} minutes in a row, ${clock(streak.from!)} to ${clock(streak.to!)}.` });
  }
  if (!hour.length) flagged.push({ kind: "no_watch", excerpt: "The Mac usable watch wrote no line in the last hour: the chat service is down or runs a release without the watch." });
  else if (!fed(hour).length) flagged.push({ kind: "no_feed", excerpt: "No watch line in the last hour has a fresh pressure feed reading: ops guy's feed (~/.cache/virev/mac-pressure.json) is stale, or the chat service runs a release that does not read it." });
  if (latest) {
    const reading = latest.usable ? `pressure level ${latest.usable.pressureLevel}, ${latest.usable.swapoutsPerS} swapouts a second, kernel_task ${latest.usable.kernelTaskPct}%` : "no fresh feed reading";
    flagged.push({ kind: "now", at: Date.parse(latest.at), excerpt: `At ${clock(latest.at)}: ${reading}. Detail with no target: ${latest.workers} Prime workers hold ${latest.workerGb} GB (top: ${latest.top.map(worker =>
      `${worker.tree} ${worker.gb} GB`).join(", ")}); ${latest.live} live sessions, ${latest.working} working, ${latest.idleOver} quiet over ${TARGET.idleMinutes} min; ` +
      `${latest.finished} finished jobs not deleted (${latest.finishedTrees.map(tree => `${tree.tree} ${tree.count}`).join(", ") || "none"}); ` +
      `queue ${latest.queue ? `${latest.queue.working} working, ${latest.queue.queued} queued, oldest ${latest.queue.oldestWaitS} s` : "unread"}; swap ${latest.mac.swapGb ?? "?"} GB.` });
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
