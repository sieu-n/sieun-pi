import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chatDataDir } from "../../src/owner-ok.ts";
import { isHarnessOwner, isHung, misses, readWatch, TARGET, unusable, USABLE, type QuietLine, type TargetPart, type UsableMiss, type WaiterLine, type WatchLine } from "../../src/mac-usable-watch.ts";
import { groupOf } from "../../src/memory-groups.ts";
import type { MemoryGroupId } from "../../src/shared/types.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Mac stays usable duty's precheck (`node --import tsx scripts/duties/mac-stays-usable.ts`): reads the chat service's Mac usable watch
 * (src/mac-usable-watch.ts, one line a minute) and reports the share of minutes the Mac was usable (`USABLE`, from ops guy's pressure feed) over
 * the last hour and the last 24 h, the minutes each harness part missed, the top miss with the chat trees behind it, and the longest run of
 * unusable minutes in the last hour, the quiet sessions behind an idle miss, and each tool call a quiet session sat in. A run of OFF_STREAK_ALERT or more is flagged as an alert for the duty job to tell the chat. The Prime
 * worker footprint is a detail line with no target. Each unusable minute goes to the harness side when agent sessions hold the largest
 * share of memory or of its growth (`isHarnessMinute`), and to the apps' or owner's side otherwise, with the feed's largest owners named for those minutes. No model call.
 */

const MINUTE = 60_000;
const GROUP_WORDS: Record<MemoryGroupId, string> = { agents: "agent sessions", dev: "dev servers", docker: "Docker", browsers: "browsers", coding: "coding tools",
  system: "system", other: "other" };
const HOUR = 60 * MINUTE;
/** Unusable minutes in a row that make an alert: the 10 the harness team set for this duty on 10-14. */
export const OFF_STREAK_ALERT = 10;
/**
 * An unusable minute is the harness's when agent sessions hold the largest share of the Mac's memory that minute, or of its growth since the
 * line before, by the groups Settings > This Mac shows (src/memory-groups.ts, the same rule table). The groups come from every owner in ops guy's
 * feed (`groups`); a line written before 10-18 01:40Z kept only the 8 largest owners, so its groups are summed from those. Agent sessions take
 * at least the Prime workers' footprint the watch measures itself plus the chat service, since each chat tree is its own feed owner and most
 * fall below the 8 largest. Whether a minute is unusable at all comes only from the feed (`USABLE`). A fixed 16 GB line, and before it a
 * 14-turn line, sent minutes with 22 to 26 job turns at work to the apps' side (01:10Z and 01:24Z on 10-18).
 */
export function memoryShares(line: WatchLine): Map<MemoryGroupId, number> {
  const shares = new Map<MemoryGroupId, number>();
  if (line.usable?.groups) for (const [id, gb] of Object.entries(line.usable.groups)) shares.set(id as MemoryGroupId, gb);
  else for (const owner of line.usable?.owners ?? []) shares.set(groupOf(owner.owner), (shares.get(groupOf(owner.owner)) ?? 0) + owner.gb);
  shares.set("agents", Math.max(shares.get("agents") ?? 0, line.workerGb + (line.serviceGb ?? 0)));
  return shares;
}

const leads = (shares: ReadonlyMap<MemoryGroupId, number>): boolean => {
  const agents = shares.get("agents") ?? 0;
  return agents > 0 && [...shares].every(([id, gb]) => id === "agents" || gb < agents);
};

/**
 * Whether agent sessions hold the largest footprint of `line`, or the largest growth since `previous` when it is at most 2 minutes older. A line
 * whose feed named no owners has no shares to compare and goes to the apps' or owner's side, as before.
 */
export function isHarnessMinute(line: WatchLine, previous?: WatchLine): boolean {
  if (!line.usable?.groups && !line.usable?.owners?.length) return false;
  const now = memoryShares(line);
  if (leads(now)) return true;
  if (!previous || (!previous.usable?.groups && !previous.usable?.owners?.length) || Date.parse(line.at) - Date.parse(previous.at) > 2 * MINUTE) return false;
  const before = memoryShares(previous);
  const growth = new Map([...now].map(([id, gb]) => [id, gb - (before.get(id) ?? 0)] as const));
  return (growth.get("agents") ?? 0) > 0 && leads(growth);
}

/** `isHarnessMinute` for lines of `lines`, each judged against the line before it there. */
export function harnessSide(lines: readonly WatchLine[]): (line: WatchLine) => boolean {
  const previous = new Map(lines.map((line, at) => [line, lines[at - 1]] as const));
  return line => isHarnessMinute(line, previous.get(line));
}

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
/** A quiet session in words: its job, short id and tree, its quiet minutes, and the tool call its last entry left open. */
export const quietWords = (quiet: QuietLine): string => `${quiet.job} (${quiet.session.slice(0, 8)}, ${quiet.tree}) quiet ${quiet.quietMin} min, ` +
  (quiet.call ? `open ${quiet.call.tool} call since ${quiet.call.at.slice(11, 16)}Z` : "no open tool call");

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

/** The feed owners behind `missed` by average footprint, the largest 6, each marked harness or not, as "Google Chrome 6.5 GB (app or owner)". */
export function ownersBehind(missed: readonly WatchLine[]): string {
  const totals = new Map<string, { label: string; gb: number }>();
  for (const line of missed) for (const owner of line.usable?.owners ?? []) {
    const seen = totals.get(owner.owner) ?? { label: owner.label, gb: 0 };
    totals.set(owner.owner, { label: seen.label, gb: seen.gb + owner.gb / missed.length });
  }
  return [...totals.entries()].sort((a, b) => b[1].gb - a[1].gb).slice(0, 6)
    .map(([owner, { label, gb }]) => `${label} ${Math.round(gb * 10) / 10} GB (${isHarnessOwner(owner) ? "harness" : "app or owner"})`).join(", ");
}

/**
 * The precheck output for the lines of the last 24 h at `now`. The usable shares count only minutes with a fresh feed reading, and are left out
 * when no line has one, so the run is an error that names them rather than a share of nothing.
 */
export function measure(lines: readonly WatchLine[], now: number): PrecheckOutput {
  const hour = lines.filter(line => Date.parse(line.at) > now - HOUR);
  const fed = (span: readonly WatchLine[]) => span.filter(line => line.usable);
  const missMinutes = Object.fromEntries(PARTS.map(part => [part, hour.filter(line => misses(line).includes(part))])) as Record<TargetPart, WatchLine[]>;
  const harness = harnessSide(lines);
  const streak = longestOffStreak(hour);
  const latest = hour.at(-1);
  const metrics: Record<string, number> = {
    ...(fed(hour).length ? { usable_pct_1h: pct(fed(hour).length - missMinutes.usable.length, fed(hour).length) } : {}),
    ...(fed(lines).length ? { usable_pct_24h: pct(fed(lines).filter(line => !isUnusable(line)).length, fed(lines).length) } : {}),
    harness_unusable_min_1h: missMinutes.usable.filter(harness).length,
    other_unusable_min_1h: missMinutes.usable.filter(line => !harness(line)).length,
    unusable_streak_max_1h: streak.minutes,
    idle_miss_min_1h: missMinutes.idle.length,
    queue_miss_min_1h: missMinutes.queue.length,
    kernel_waiters_1h: 0,
  };
  const flagged: FlaggedSlice[] = [];
  const waiters = new Map<number, WaiterLine>();
  for (const line of hour) for (const waiter of line.waiters ?? []) waiters.set(waiter.pid, waiter);
  metrics.kernel_waiters_1h = waiters.size;
  const calls = new Map<string, QuietLine & { call: NonNullable<QuietLine["call"]> }>();
  for (const line of hour) for (const quiet of [...line.quiet ?? [], ...line.active ?? []]) if (quiet.call) calls.set(quiet.call.id, { ...quiet, call: quiet.call });
  for (const quiet of calls.values()) {
    const hung = isHung(quiet) ? `; its kernel has not moved for ${quiet.stillMin} min` : "";
    flagged.push({ kind: "open_call", item: quiet.session, excerpt: `${quiet.tree}, job ${quiet.job} (session ${quiet.session.slice(0, 8)}): one ${quiet.call.tool} call since ` +
      `${quiet.call.at.slice(11, 16)}Z with no model call for ${quiet.quietMin} min, \`${quiet.call.code}\`${hung}.` });
  }
  for (const waiter of waiters.values()) {
    flagged.push({ kind: "kernel_waiter", item: String(waiter.pid), excerpt: `${waiter.tree}, job ${waiter.job}, pid ${waiter.pid}, \`${waiter.command}\`, ` +
      `${waiter.ageMin ?? "?"} min: ${waiter.quietMin === undefined ? "a background wait in a kernel" : `a bash() handle held ${waiter.quietMin} min past its turn end`}.` });
  }
  if (fed(hour).length) {
    const why = (["pressure", "swapouts", "kernel_task"] as const).map(miss => [miss, missMinutes.usable.filter(line => unusable(line.usable!).includes(miss)).length] as const);
    flagged.push({ kind: "usable", excerpt: `The Mac was usable in ${fed(hour).length - missMinutes.usable.length} of the ${fed(hour).length} minutes with a feed reading in the last hour ` +
      `(${hour.length} watched)${missMinutes.usable.length ? `; unusable minutes by cause: ${why.filter(([, count]) => count).map(([miss, count]) => `${USABLE_WORDS[miss]} ${count}`).join(", ")}` : ""}.` });
    const harnessMin = missMinutes.usable.filter(harness), other = missMinutes.usable.filter(line => !harness(line));
    const shares = (line: WatchLine): string => [...memoryShares(line)].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, gb]) => `${GROUP_WORDS[id]} ${Math.round(gb * 10) / 10} GB`).join(", ");
    if (harnessMin.length) flagged.push({ kind: "harness_side", excerpt: `${harnessMin.length} unusable minutes had agent sessions holding the largest share of memory or of its growth ` +
      `(${harnessMin.map(line => `${clock(line.at)} ${shares(line)}, ${line.queue?.working ?? "?"} turns, ${line.workers} workers`).join("; ")}): the harness side. ` +
      `Workers behind them: ${treesBehind("usable", harnessMin) || "none named"}.` });
    if (other.length) flagged.push({ kind: "other_side", excerpt: `${other.length} unusable minutes had another group holding the largest share of memory and of its growth ` +
      `(${other.map(line => `${clock(line.at)} ${shares(line)}`).join("; ")}); the feed's largest owners then: ${ownersBehind(other) || "the feed named no owners"}.` });
  }
  const named = missMinutes.idle.findLast(line => line.quiet?.length);
  const top = PARTS.reduce<TargetPart | null>((best, part) => missMinutes[part].length > (best ? missMinutes[best].length : 0) ? part : best, null);
  if (top) {
    flagged.push({ kind: "top_miss", item: top, excerpt: `Top miss: ${PART_WORDS[top]} in ${missMinutes[top].length} of ${hour.length} minutes. ` +
      `Chat trees behind it${top === "usable" ? ", by Prime worker footprint in those minutes" : ""}: ${treesBehind(top, missMinutes[top]) || "none named"}.` +
      (top === "idle" && named?.quiet?.length ? ` Quiet sessions at ${clock(named.at)}: ${named.quiet.map(quietWords).join("; ")}.` : "") });
  }
  if (streak.minutes >= OFF_STREAK_ALERT) {
    flagged.push({ kind: "alert", excerpt: `The Mac was unusable ${streak.minutes} minutes in a row, ${clock(streak.from!)} to ${clock(streak.to!)}.` });
  }
  if (!hour.length) flagged.push({ kind: "no_watch", excerpt: "The Mac usable watch wrote no line in the last hour: the chat service is down or runs a release without the watch." });
  else if (!fed(hour).length) flagged.push({ kind: "no_feed", excerpt: "No watch line in the last hour has a fresh pressure feed reading: ops guy's feed (~/.cache/virev/mac-pressure.json) is stale, or the chat service runs a release that does not read it." });
  if (latest) {
    const reading = latest.usable ? `pressure level ${latest.usable.pressureLevel}, ${latest.usable.swapoutsPerS} swapouts a second, kernel_task ${latest.usable.kernelTaskPct}%` : "no fresh feed reading";
    flagged.push({ kind: "now", at: Date.parse(latest.at), excerpt: `At ${clock(latest.at)}: ${reading}. Detail with no target: ${latest.workers} Prime workers hold ${latest.workerGb} GB (top: ${latest.top.map(worker =>
      `${worker.tree} ${worker.gb} GB`).join(", ")}); ${latest.live} live sessions, ${latest.working} working, ${latest.idleOver} quiet over ${TARGET.idleMinutes} min` +
      `${latest.quiet?.length ? ` (${latest.quiet.map(quietWords).join("; ")})` : ""}; ` +
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
