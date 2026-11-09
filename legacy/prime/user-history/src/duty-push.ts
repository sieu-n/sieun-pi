import { missedKeys } from "./shared/duty-fixes.ts";
import { type DutyRunRecord, STILL_WORKING } from "./shared/chat-duties.ts";
import { effectiveRun, metricStreaks, newestReading, type MetricStreak } from "./shared/duty-streak.ts";

/**
 * Whether the duty's newest job ended with no push job since: that job is no push run's, nor a rerun's of a push run, and it ended with an
 * after-job measure or on a cut. Its duty then gets its push at once instead of a check-in interval after the newest run; the push itself
 * checks that the job no longer works (`DutyJobHost.working`) and that a cut run has had its rerun. At 07:30:45Z on 10-22 ops guy's 23:08Z
 * Local dev servers job ended on restarts 2 with no fix step, a push at 07:31:42Z found it answering a message and started no job, and the
 * next push waited for 09:31Z, so d9 counted the duty stuck till then. A cut job that came back from its pool wait works on and ends with no
 * after-job measure, since its rerun measured beside it: metal-management's d1 verify job of 14:49Z on 10-22 was cut at 15:23Z, its rerun
 * at 15:29Z read tool_rows_off 2 behind it, the job ended at 15:42Z and the fix step p142 closed at about 15:50Z, and no run read the duty
 * again until the 17:29Z push, so d9 counted it stuck at 16:03Z and 17:03Z. AI harness d5 (11:30Z to 12:28Z) and d9 (15:42Z to 16:03Z) sat
 * the same way after their cut reruns' jobs ended. A push job that ends red, or is cut and rerun, waits the interval as before. So does a
 * duty that a run measured after the job ended and started no job for another reason than the job still at work (STILL_WORKING): that run
 * was the push, or read the duty afresh. From 00:30Z on 10-26 slack green guy's d1 got a push run every 30 s, since each one read red,
 * started no job ("the catalog does not list the chat") and left the 10-25 00:30Z job, which ended red at 00:57Z, as the newest job.
 */
/**
 * A run that started no job because the ended job is kept (`Duties.kept`, a Prime update or pi-pool's hold) read the duty afresh. From 09:25Z
 * to 10:06Z on 10-27 the AI harness chat's d7 got 80 push runs, one every 30 s, each "skipped: previous run still working (job ... is kept
 * while Prime update 658984-1793090758889 is stopping)", since a STILL_WORKING run never counted as the push that followed the 08:29Z end.
 */
const KEPT = / is kept[ ,]/;

function endedUnpushed(runs: readonly DutyRunRecord[]): boolean {
  const index = runs.findIndex(run => run.job !== undefined);
  const last = runs[index];
  if (!last || (!last.after && !last.cut)) return false;
  const ended = last.after?.at ?? last.cut?.at ?? last.at;
  if (runs.slice(0, index).some(run => run.verdict !== "skipped" && run.at >= ended && (!run.summary.includes(STILL_WORKING) || KEPT.test(run.summary)))) return false;
  const origin = last.trigger === "rerun" ? runs.find(run => run.at === last.rerunOf) ?? last : last;
  return last.trigger !== "push" && origin.trigger !== "push";
}

/**
 * How often a met duty whose counted metric has parts is read again, when that is sooner than the check-in interval. A part such as the Wiki
 * dream's `wiki_problems_following` turns into the counted metric after its follow window (70 min, `FOLLOW_WINDOW_MS` in
 * scripts/duties/wiki-dream.ts), so a page that falls behind must be read and handed to a writer with time left for the rewrite: 70 min less the
 * p90 rewrite of 52.7 min and the precheck's 2.6 min (the 19:50Z run of 10-29 took 153.5 s) leaves 14.7 min. measured: from 10-27 to 10-29 the
 * d4 run after a met run came at p50 60.3 and p90 78.8 min on the hourly check-in interval, after which the window had passed, and from
 * 20:46Z to 22:45Z on 10-29 the take-ins 5b30292754 and be6da6c8d6 and the session commits put 30 pages an hour behind between those reads.
 */
export const PART_READ_MS = 15 * 60_000;

/**
 * The counted metrics a push run of a standing duty goes after, or null when the duty gets no push now. `runs` are the duty's runs, newest
 * first. The duty is red when its newest met-or-missed reading (`newestReading`, so a run whose after-job measure is met counts green) missed a
 * counted metric. It gets a push once its newest run of any verdict is `everyMs` old, the chat's check-in interval: the owner's own push
 * cadence for the chat. Without it a red daily duty waited a whole day after its fix job ended, and forever when its job did not start: from
 * 10-16 to 10-18 four daily duties sat red with no job for 1 to 2 days after "the catalog cannot list the chat". It gets one sooner when its
 * newest job ended red with no push job since (`endedUnpushed`), on the misses that are no quiet windowed count, which owe no fix job.
 *
 * A met run whose part of a counted metric (`metricParts`, `<metricKey>_<part>`) is off target gets a push for that part too: the part is work
 * the verdict waits to count. The Wiki dream's `wiki_problems_following` counts pages behind their code for less than the time one push run
 * and one rewrite take, so they are rewritten before they count; on 10-20 cited code changed under 20 pages in the 15 min after 48 were
 * rewritten. Until then no duty's met run had a part off target, so this pushes no other duty.
 *
 * A met run whose counted metric has parts gets a push with no keys (`[]`) once it is `PART_READ_MS` old, or `everyMs` when that is sooner,
 * even with every part on target, so a page that falls behind later is read while its follow window leaves time to rewrite it; the push run starts no job when it reads met with every part on target (`run` in
 * src/chat-duty-run.ts). On 10-25 the Wiki dream's after-job measure of 12:30Z read wiki_problems_following 0, no run read d4 again until its
 * 16:30Z schedule run, and that run read wiki_problems 45 and wiki_problems_following 13.
 *
 * A missed run whose counted metric has parts gets its push at that pace too, since its parts keep falling behind while it is red: from the
 * 16:30Z schedule run of 11-06, which read wiki_problems 29, no run read d4 again until 03:38Z on 11-07, which read 43.
 */
export function pushMisses(runs: readonly DutyRunRecord[], counted: ReadonlySet<string>, everyMs: number, now: number): string[] | null {
  const newest = runs[0];
  if (!newest) return null;
  const holder = newestReading(runs);
  if (!holder) return null;
  const measured = effectiveRun(holder);
  if (measured.verdict === "missed") {
    const keys = missedKeys(measured).filter(key => counted.has(key));
    const streaks = metricStreaks(runs);
    const quiet = new Set(streaks.filter(streak => streak.quietSince !== undefined).map(streak => streak.key));
    // A quiet windowed count only waits for its old events to leave the window (`agedOut` pushes once they have), so the interval push skips
    // it. From 11-01 12Z to 11-02 12Z the AI harness chat's d10 got 14 hourly push runs, each starting a job, on repeat_corrections_7d and
    // repeats_after_fix_7d with no repeat newer than 10-29 07:35Z.
    const aging = new Set(streaks.filter(streak => quiet.has(streak.key) && countWindowMs(streak.key, streak) !== undefined).map(streak => streak.key));
    // A miss on a closed window that has not rolled over reads the same number on any rerun, so it gets no push until the window rolls, and
    // one push right after. On 11-02 api portal vp's d4 got push runs at 21:42Z and 21:58Z, each with a job, on slow_route_p90_s, which reads
    // the last full UTC day and could not change before 00:00Z on 11-03.
    const open = keys.filter(key => windowState(measured, key, newest.at, now) !== "closed");
    if (open.some(key => windowState(measured, key, newest.at, now) === "rolled")) return open;
    const pace = countedParts(measured, counted) ? Math.min(everyMs, PART_READ_MS) : everyMs;
    if (now - newest.at >= pace) { const due = open.filter(key => !aging.has(key)); return due.length ? due : null; }
    const owed = endedUnpushed(runs) ? open.filter(key => !quiet.has(key)) : [];
    return owed.length ? owed : null;
  }
  const parts = countedParts(measured, counted);
  if (!parts) return null;
  if (now - newest.at < Math.min(everyMs, PART_READ_MS)) return null;
  return missedKeys({ metrics: parts });
}

/**
 * Whether the duty's newest reading has parts of its counted metrics (`countedParts`). Its push run reads the duty whatever fix step is live or
 * waits on the owner, since the run's job is the one that works the parts: at 04:00Z on 11-07 the d4 fix job "d4 push reads gap 11-07" on p1455
 * was live, the d4 job of 01:30 KST was cut and archived at 03:54Z, and no push run read d4 or started a writer for its 43 wiki problems.
 */
export function readsParts(runs: readonly DutyRunRecord[], counted: ReadonlySet<string>): boolean {
  const holder = newestReading(runs);
  return !!holder && countedParts(effectiveRun(holder), counted) !== null;
}

/** The parts of the counted metrics in `measured` (`<metricKey>_<part>`), or null when it has none. */
function countedParts(measured: Pick<DutyRunRecord, "parts">, counted: ReadonlySet<string>): DutyRunRecord["parts"] | null {
  const parts = Object.fromEntries(Object.entries(measured.parts ?? {}).filter(([key]) => [...counted].some(metric => key.startsWith(`${metric}_`))));
  return Object.keys(parts).length ? parts : null;
}

/**
 * Where the closed window a metric of `measured` reads stands (`MetricResult.rollsAt`): "closed" before it rolls over, when a rerun reads the
 * same number, "rolled" once it has with no run since `newestAt`, else undefined: the metric reads no closed window, or a run read the new one.
 */
export function windowState(measured: Pick<DutyRunRecord, "metrics">, key: string, newestAt: number, now: number): "closed" | "rolled" | undefined {
  const rollsAt = measured.metrics[key]?.rollsAt;
  if (rollsAt === undefined) return undefined;
  if (now < rollsAt) return "closed";
  return newestAt < rollsAt ? "rolled" : undefined;
}

/**
 * When every one of `keys` reads a closed window in the duty's newest reading that has not rolled over, the time the last one rolls, else
 * undefined. A verify run before then reads the same numbers as the run before it: at 22:08:56Z on 11-02 api portal vp's d4 verify run of p111
 * read slow_route_p90_s 8.97 s on 11-01 again and started a job, and the push after the roll measures the fix.
 */
export function closedUntil(runs: readonly DutyRunRecord[], keys: readonly string[], now: number): number | undefined {
  const holder = newestReading(runs);
  if (!holder || !keys.length) return undefined;
  const measured = effectiveRun(holder);
  let until = 0;
  for (const key of keys) {
    if (windowState(measured, key, runs[0]!.at, now) !== "closed") return undefined;
    until = Math.max(until, measured.metrics[key]!.rollsAt!);
  }
  return until;
}

/**
 * A windowed count's window: the one its precheck named (`MetricResult.windowMs`), else its key's `_<n>m`, `_<n>h` or `_<n>d` part
 * (`noisy_rules_24h`, `probe_uptime_24h_pct`), or undefined.
 */
export function countWindowMs(key: string, result?: { windowMs?: number | undefined }): number | undefined {
  if (result?.windowMs !== undefined) return result.windowMs;
  const found = /_(\d+)(m|h|d)(?:_|$)/.exec(key);
  if (!found) return undefined;
  return Number(found[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[found[2] as "m" | "h" | "d"];
}

/**
 * When the duty's newest reading missed only windowed counts whose newest event (`lastEventAt`) has left its window since, the time the last
 * one left; undefined while any counted miss can still count, or once a run of any verdict came after that time. Such a duty gets a push run
 * even with a live fix job or a hold, and the run reads met and starts no job. Without it the duty read red until its next daily slot: Crawler
 * VP's d6 counted health_snapshot_down_minutes_24h 16 with the newest down minute at 18:16Z on 10-25, its next run was the 21:20Z slot on
 * 10-26, and d9 counted it red at each run in between, as it did ops guy's d3, whose last noisy flap of 12:06Z on 10-26 waited for 23:46Z on 10-27.
 */
export function agedOut(runs: readonly DutyRunRecord[], counted: ReadonlySet<string>, now: number): number | undefined {
  const newest = runs[0];
  const holder = newestReading(runs);
  if (!newest || !holder) return undefined;
  const measured = effectiveRun(holder);
  if (measured.verdict !== "missed") return undefined;
  const missed = missedKeys(measured).filter(key => counted.has(key));
  if (!missed.length) return undefined;
  let left = 0;
  for (const key of missed) {
    const at = measured.metrics[key]?.lastEventAt;
    const window = countWindowMs(key, measured.metrics[key]);
    if (at === undefined || window === undefined) return undefined;
    left = Math.max(left, at + window);
  }
  return left <= now && Math.max(newest.at, holder.after?.at ?? holder.at) < left ? left : undefined;
}

/**
 * When a red duty misses only windowed counts with no new event since the run before (`MetricStreak.quietSince`, the duty runner's own quiet
 * read), the newest event any of them counts; otherwise undefined. Such a duty owes no fix job (`missLine` says to start none), but d9 listed
 * the AI harness chat's d10, repeat_corrections_7d 16 with every line before its fix, among its red examples, and its job pushed the chat for a
 * fix step on it at 07:50Z, 10:47Z and 14:12Z on 10-20. `runs` is the duty's own runs, newest first.
 */
export function agingSince(runs: readonly DutyRunRecord[]): number | undefined {
  const streaks = metricStreaks(runs);
  const newestAt = Math.max(...runs.map(run => run.at));
  if (!streaks.length || streaks.some(streak => streak.quietSince === undefined || chronicWindow(streak, newestAt))) return undefined;
  return Math.max(...streaks.map(streak => streak.quietSince!));
}

/**
 * Whether a windowed count's miss streak is chronic: it has lasted its whole window and an event it counts landed after its first miss, so new
 * events keep the count up and nothing ages out. Such a count is no quiet one and owes a fix job. Until 11-09 d9 read only the newest event, and
 * ops guy's d3 missed noisy_rules_24h at every run from 23:46Z on 11-02 with a new flap each day while d9 said it owed no fix job.
 */
export function chronicWindow(streak: Pick<MetricStreak, "key" | "since" | "lastEventAt" | "windowMs">, newestAt: number): boolean {
  const window = countWindowMs(streak.key, streak);
  return window !== undefined && streak.lastEventAt !== undefined && streak.lastEventAt > streak.since && newestAt - streak.since >= window;
}

/**
 * When the last event an aging duty counts leaves its window (`countWindowMs` of each key), or undefined when a key names no window. The newest
 * event alone misled: at 22:25Z on 10-26 d9 said CI and RepoOps d5 aged out with its newest event at 02:35Z, and the chat read that as clearing
 * at 02:35Z on 10-27, while refused_lands_promotes_7d counts a refusal of 21:53Z on 10-25 until 21:53Z on 11-01.
 */
export function agingUntil(runs: readonly DutyRunRecord[]): number | undefined {
  if (agingSince(runs) === undefined) return undefined;
  let until = 0;
  for (const streak of metricStreaks(runs)) {
    const window = countWindowMs(streak.key, streak);
    if (window === undefined) return undefined;
    until = Math.max(until, streak.quietSince! + window);
  }
  return until;
}
