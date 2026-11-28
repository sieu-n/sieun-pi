/**
 * What a duty run gives the duty's job, item by item, and when a job has held its duty too long. A run beside a job that still works used to
 * start none and give it nothing: from 11-25 21:10Z one job held devops guy's d17 "Vendor bills stay inside plan" for 62 h, 7 runs said "so
 * this run started none", and the lines they newly flagged (PostHog Events on 11-27, the OpenAI credits on 11-28) reached no job
 * (~/work/bill-check-miss/survey.md). Prime's runner handed a working job each new item (`Duties.handOff`) and retired a stuck one
 * (`previous`, legacy/prime/user-history/src/chat-duty-run.ts); this file is those two rules for sw factory, as pure functions, so a
 * replay runs them over stored runs (~/work/duty-beside-job/replay.mts).
 */
import { createHash } from "node:crypto";
import type { PlanItem } from "../web/src/lib/api/types.ts";
import type { Duty, DutyRunRecord, FlaggedSlice, ItemOwner, MetricResult } from "../web/src/lib/api/shared/chat-duties.ts";
import { stuckAfterMs } from "../../../legacy/prime/user-history/src/duty-stuck.ts";

/**
 * A number, a date or a time that stands alone in a sentence, which a keyless item's key reads as one mark. A number inside a name, as in
 * `crawler_local_pytest_30266` or `claude10@slack.green`, stays, since it tells two items apart.
 */
const LOOSE_NUMBER = /(?<![A-Za-z0-9_])\d[\d,.:TZ-]*(?![A-Za-z0-9_])/g;

/**
 * The key a flagged item is given out by, once per job: its sig, else its kind and item, else its kind and its excerpt with each loose
 * number read as one mark, so "waits 2850 h" and "waits 2874 h" are one finding. Of the 9,892 flagged items in the 1,149 stored run files
 * on 11-28, 3,320 had a sig, 2,750 an item and 3,822 neither, and with the excerpt as written a keyless line that restates a count or an
 * age was new on every run in 21 of 91 duties (~/work/duty-beside-job/item-keys.md).
 */
export function itemKey(slice: Pick<FlaggedSlice, "kind" | "excerpt" | "item" | "sig">): string {
  if (slice.sig) return slice.sig;
  if (slice.item !== undefined) return `${slice.kind}|${slice.item}`;
  return `${slice.kind}|#${createHash("sha1").update(slice.excerpt.replace(LOOSE_NUMBER, "#").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12)}`;
}
/** The key a missed metric is given out by. */
export const metricKey = (key: string): string => `metric|${key}`;

/** What a run has for a job: every flagged item and each missed metric the verdict counts. */
export interface RunItems { flagged: readonly FlaggedSlice[]; missed: readonly string[] }
export const runKeys = (items: RunItems): string[] => [...new Set([...items.flagged.map(itemKey), ...items.missed.map(metricKey)])];

/** The part of a run's items that no earlier run gave the job, with its keys. */
export interface Unseen { flagged: FlaggedSlice[]; missed: string[]; keys: string[] }
export function unseen(items: RunItems, given: ReadonlySet<string>): Unseen {
  const seen = new Set<string>();
  const fresh = (key: string): boolean => !given.has(key) && !seen.has(key) && !!seen.add(key);
  const flagged = items.flagged.filter(slice => fresh(itemKey(slice)));
  const missed = items.missed.filter(key => fresh(metricKey(key)));
  return { flagged, missed, keys: [...seen] };
}

/**
 * The keys every run gave a job, from the runs that name it, oldest first. A record with no `given` is from before 11-28 or started its job
 * on a later try: the oldest such run gave the job its brief, which names its missed metrics and the findings file with every flagged item of
 * its detail file (`flaggedOf`), and a later one, a run beside the job, gave it nothing.
 */
export async function givenTo(jobRuns: readonly DutyRunRecord[], flaggedOf: (detail: string) => Promise<readonly FlaggedSlice[]>): Promise<Set<string>> {
  const given = new Set<string>();
  for (const [index, run] of jobRuns.entries()) {
    let keys = run.given;
    if (!keys && index === 0) {
      const missed = Object.entries(run.metrics).filter(([, result]) => !result.met).map(([key]) => key);
      keys = runKeys({ flagged: run.detail ? await flaggedOf(run.detail).catch(() => []) : [], missed });
    }
    for (const key of keys ?? []) given.add(key);
  }
  return given;
}

/** Whether `now` reads a metric that `then` missed closer to its target, or on it. */
const closer = (then: Record<string, MetricResult>, now: Record<string, MetricResult>): boolean => Object.entries(then).some(([key, was]) => {
  const is = now[key];
  return !was.met && is !== undefined && (is.met || (was.op === "<=" ? is.value < was.value : is.value > was.value));
});

/**
 * Since when a job has held its duty with no missed number moved: the time of the newest of its runs, oldest first in `runs`, that read a
 * missed metric closer to its target than the run where it last moved, or that found the job waiting for a model account (`jobWaits`), else
 * the run that started it, and never before `answeredAt`, the job's first model answer, since until then it waited for an account. A job
 * that started for no missed metric has no number to move, so its time is its start or its first answer.
 */
export function heldSince(runs: readonly DutyRunRecord[], answeredAt = 0): number {
  let base = runs[0]!;
  for (const run of runs.slice(1)) if (run.jobWaits || closer(base.metrics, run.metrics)) base = run;
  return Math.max(base.at, answeredAt);
}

/**
 * What a run with something due does beside the duty's job that answered and still works:
 * - `replace`: the job held the duty past `stuckAfterMs` of its schedule (one interval, at least 90 min and at most 12 h, Prime's rule) with
 *   no missed number closer to its target, so the run stops it and starts a new job. A job that sleeps on its own board.wake is replaced the
 *   same way: the wake says the job chose to wait, and its number did not move in a whole limit. d17's job slept on a wake for 2026-11-28T03:00Z.
 * - a job pi-pool holds for a model account is never replaced for its age: a new job would join the same line behind it (c250, and Prime's
 *   IN_POOL_LINE measure of 10 replaced jobs that each got an account later than the job they replaced). The time it waited does not count
 *   toward its limit either (`heldSince`), as Prime's `keptAt` gives a job that waited a whole limit of work once it runs.
 * - `steer`: the run has items no run gave the job, so it gets them in one message.
 * - `leave`: the job has all of it.
 */
export type Beside = { do: "replace"; heldMs: number; limitMs: number } | { do: "steer" } | { do: "leave" };
export function beside(input: { now: number; schedule: Duty["schedule"]; jobRuns: readonly DutyRunRecord[]; record: DutyRunRecord; due: boolean; waitsForAccount: boolean; answeredAt?: number; fresh: number }): Beside {
  const heldMs = input.now - heldSince([...input.jobRuns, input.record], input.answeredAt);
  const limitMs = stuckAfterMs(input.schedule);
  if (input.due && !input.waitsForAccount && heldMs > limitMs) return { do: "replace", heldMs, limitMs };
  return input.fresh > 0 ? { do: "steer" } : { do: "leave" };
}

/**
 * Whether a job's runs, oldest first, show at `now` that it held the duty past its stuck limit. A red duty with such a job gets its push run
 * though the job still works (`Boards.pushDuty`), so a daily duty's job is replaced at the first push after 12 h and not at the next day's slot.
 */
export const heldPastLimit = (schedule: Duty["schedule"], jobRuns: readonly DutyRunRecord[], now: number, answeredAt = 0): boolean =>
  jobRuns.length > 0 && now - heldSince(jobRuns, answeredAt) > stuckAfterMs(schedule);

/** A kind or key with each word in the singular, so the kind `line_over_pace` reads as the metric `lines_over_pace`. */
const singular = (name: string): string => name.toLowerCase().split(/[^a-z0-9]+/).map(word => word.replace(/s$/, "")).join("_");
/** The name a step owns a flagged item by: its sig, else its item. */
const itemName = (slice: FlaggedSlice): string | undefined => slice.sig ?? slice.item;

/**
 * The flagged items a missed metric counts, by name: the slices whose kind is the metric's key, in the singular or the plural, that carry a
 * sig or an item. A precheck that names its slices otherwise keeps the one link per metric. Over the 715 newest run files on 11-28, 82 missed
 * metric readings had slices of their own kind, among them d17's lines_over_pace on all 8 runs.
 */
export function countedItems(key: string, flagged: readonly FlaggedSlice[]): string[] {
  const kind = singular(key);
  return [...new Set(flagged.flatMap(slice => singular(slice.kind) === kind ? itemName(slice) ?? [] : []))];
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
/**
 * Whether a step names a flagged item: its text or note holds the item as written, or every word of it, so the step "posthog synced rows"
 * names `posthog//Synced rows` and "vercel spend cut" does not.
 */
export function stepNames(step: Pick<PlanItem, "text" | "note">, item: string): boolean {
  const text = `${step.text} ${step.note ?? ""}`.toLowerCase();
  if (text.includes(item.toLowerCase())) return true;
  const has = new Set(words(text));
  const need = words(item);
  return need.length > 0 && need.every(word => has.has(word));
}

/** Each item with the first of `steps`, the open fix steps linked to its metric in plan order, that names it. */
export function itemOwners(steps: readonly Pick<PlanItem, "id" | "text" | "note">[], items: readonly string[]): ItemOwner[] {
  return items.map(item => {
    const step = steps.find(entry => stepNames(entry, item));
    return { item, ...(step ? { step: step.id } : {}) };
  });
}
