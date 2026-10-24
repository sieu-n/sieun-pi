import type { DutyRunRecord, FixLink, MetricResult } from "./chat-duties.ts";

/**
 * Miss streaks per metric, read from a duty's runs. A run's verdict is its measure after its own job ended when it has one (`effectiveRun`),
 * so a check-in that fixed its own finding is not counted as a miss. Skipped and error runs neither extend nor break a streak, and nor does an
 * older run whose job was cut (`streakRuns`).
 */

/** After this many misses in a row with no move toward the target, a run must change approach: a new root-cause job, not the same fix. */
export const CHANGE_APPROACH_MISSES = 3;

/** One metric's current miss streak: how many measured runs in a row missed it, whether its value moved toward the target over the streak, and its fix step. */
export interface MetricStreak {
  key: string;
  misses: number;
  /** The newest value is closer to the target than the value at the start of the streak. */
  moved: boolean;
  /** The time of the oldest run in the streak. */
  since: number;
  value: number; target: number; op: MetricResult["op"];
  /** The fix step the newest run of the streak found, if any. */
  fix?: FixLink;
  /**
   * For a count over a trailing window (its result has `lastEventAt`), the time of the newest counted event when it is older than the previous
   * measured run, cut or not, since a cut run's precheck still measured: no new event came since, so the number only waits for old events to
   * leave the window. Crawler VP d6 10-21: api_down_minutes_24h's newest down minute was 01:02Z, the 01:32Z and 21:20Z runs were cut, and the
   * 11:38Z run compared it with the 14:07Z run of 10-20 and read "change approach" though promote 18's 09:35Z deploy had 0 down minutes.
   */
  quietSince?: number;
  /**
   * CHANGE_APPROACH_MISSES or more misses, no move toward the target, and not `quietSince`. With a fix step, only the misses its run records name
   * the same fix for count (`fixMisses`): a fix job younger than the misses has not had them yet. Demo sandbox 10-18: restarts_24h read 4 from
   * stops at 02:17Z to 06:53Z, the fix landed at 08:24Z and no stop came after, yet every hourly run until the window emptied said "change approach".
   */
  stuck: boolean;
}

/** The run as judged: its after-job measure when it has one, else its own. */
export function effectiveRun(run: DutyRunRecord): Pick<DutyRunRecord, "verdict" | "metrics" | "summary" | "parts" | "items"> {
  return run.after ? { verdict: run.after.verdict, metrics: run.after.metrics, summary: run.after.summary, ...(run.after.parts ? { parts: run.after.parts } : {}),
    ...(run.after.items ? { items: run.after.items } : {}) } : run;
}

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/**
 * The run that holds a duty's newest met-or-missed reading by the time it was taken: a run's after-job measure at its own `at`, else the run at
 * its start. Runs are ordered by start, and an older run's after-job measure can be newer than a later run: on 10-20 the Wiki dream's 00:46Z
 * run read wiki_problems 43 after its job at 03:26Z while a 02:02Z verify run, skipped behind that job, had read 0. The duty runner's push and
 * d9's stuck_duties both judge on this reading: at 14:45Z on 10-22 d9 counted AI harness d11 and ops guy's d1 as red duties with no fix from
 * their 13:12Z and 11:43Z skipped verify runs, while the after-job measures of their older runs at 13:30Z and 13:17Z read every metric met.
 */
export function newestReading(runs: readonly DutyRunRecord[]): DutyRunRecord | undefined {
  let best: DutyRunRecord | undefined;
  for (const run of runs) {
    if (measured(run) && (!best || (run.after?.at ?? run.at) > (best.after?.at ?? best.at))) best = run;
  }
  return best;
}
const gap = (result: MetricResult): number => Math.abs(result.value - result.target);

/**
 * The measured runs a streak counts, newest first: each met or missed run except an older one whose job was cut (`DutyRunRecord.cut`). A cut
 * job did no work, so its run tried no fix, and its after-job measure is mostly the next run's own measure written again (`launch`; 549 of
 * 585 cut runs with one on 10-21). The newest run stays, since it reads the duty's state now. AI harness d11 10-21: the 21:31Z verify run and
 * its 01:32Z rerun both ended on pi-pool slot waits, their after-job measures read unlabeled_lines 3 and 6, and the 02:32Z push run was told
 * "missed 3 runs in a row, change approach".
 */
export const streakRuns = (runs: readonly DutyRunRecord[]): DutyRunRecord[] => runs.filter(measured).filter((run, index) => index === 0 || !run.cut);

/** How many counted runs in a row, newest first, missed (`effectiveRun`, `streakRuns`). */
export function missStreak(runs: readonly DutyRunRecord[]): number {
  const ordered = streakRuns(runs);
  const at = ordered.findIndex(run => effectiveRun(run).verdict !== "missed");
  return at < 0 ? ordered.length : at;
}

/**
 * The runs of a streak that name `fix` as the metric's fix: the same step, and the same job when it has one. launch main bro 10-15: the 16:13:38Z
 * check-in run missed stuck_steps for the third measured run in a row and named p128 with job "fix check-in launch main bro 01:09", started at
 * 16:09Z; the 13:50Z and 14:54Z misses had no fix at all, yet the run told the check-in to change approach because p128 "did not move it".
 */
export const fixMisses = (streak: readonly DutyRunRecord[], key: string, fix: FixLink): number =>
  streak.filter(run => { const named = run.fixes?.[key]; return named?.step === fix.step && named.job === fix.job; }).length;

/**
 * The misses of `key`'s current streak (`streakRuns`) whose run named `step` as its fix, and whether the value is closer to the target now than
 * at the first of them. A fix is judged on its own runs: the whole streak counted the misses before it too, so the root-cause step a chat
 * started on d9's push read as a fix that does not move from its first run. SEO guy 10-23: d9's 04:07Z push replaced p83 with p90, whose job
 * started at 04:10Z, and the 05:06Z d2 run, the first to name p90, made it 18 misses with no move, so d9 asked again to replace p90.
 * A run that found the step held by an open For you todo (`FixLink.hold`) ends the count, since the fix waited on the owner and starts again
 * once he answers: AI harness p919 waited on Railway Breach's t11 at 08:37Z on 10-23, t11 closed, and its job started on it again by 09:11Z,
 * which d9 read as 6 misses under p919 counting 4 from before the hold.
 */
/** What a fix step works, as one run read it: the board item (the step or one above it) and its number against its own target. */
export interface WorkedReading { item: string; value: number; target: number; op?: MetricResult["op"] }
/** How far a fix's own number moved over the runs that named it (`fixStepStreak`): the item, its value at the first of them and now, and its target now. */
export interface WorkedMove { item: string; from: number; to: number; target: number }

/**
 * The number a run read for what `step` works: the duty's own reading of the step (`DutyRunRecord.items`), else the step's own target as the
 * run found it (`FixLink.target`), else the duty's reading of the nearest item above the step (`above`, nearest first).
 */
function workedReading(run: DutyRunRecord, fix: FixLink | undefined, step: string, above: readonly string[]): WorkedReading | undefined {
  const items = effectiveRun(run).items ?? {};
  const own = items[step];
  if (own) return { item: step, value: own.value, target: own.target, op: own.op };
  if (fix?.step === step && fix.target) {
    const { current, target, direction } = fix.target;
    return { item: step, value: current, target, ...direction ? { op: direction === "down" ? "<=" as const : ">=" as const } : {} };
  }
  const id = above.find(entry => items[entry] !== undefined);
  return id === undefined ? undefined : { item: id, value: items[id]!.value, target: items[id]!.target, op: items[id]!.op };
}

/**
 * The misses of `key`'s current streak (`streakRuns`) whose run named `step` as its fix, and whether the value is closer to the target now than
 * at the first of them. A fix is judged on its own runs: the whole streak counted the misses before it too, so the root-cause step a chat
 * started on d9's push read as a fix that does not move from its first run. SEO guy 10-23: d9's 04:07Z push replaced p83 with p90, whose job
 * started at 04:10Z, and the 05:06Z d2 run, the first to name p90, made it 18 misses with no move, so d9 asked again to replace p90.
 * A run that found the step held by an open For you todo (`FixLink.hold`) ends the count, since the fix waited on the owner and starts again
 * once he answers: AI harness p919 waited on Railway Breach's t11 at 08:37Z on 10-23, t11 closed, and its job started on it again by 09:11Z,
 * which d9 read as 6 misses under p919 counting 4 from before the hold.
 * When the newest named run reads a number for what the step works (`workedReading`: the step's item, its own target, or the item above it
 * in `above`, nearest first), the fix is judged on that number: its misses are the runs in a row that read it, and the move runs from the
 * oldest of them, which `worked` names. A count or a 0-or-1 metric moves only when a whole item clears: on 10-24 Crawler VP's d9 read
 * throughput_goals_missed 3 then 4 under p942, so d9 asked to replace it, while p850, the goal above p942, went from 135 to 159 walks a minute
 * against 252. A fix first measured this way starts its count, as a new step does, since Crawler VP's runs before 21:24Z on 10-24 kept no
 * such number. A number on its own target counts as moved, since its fix did its part while a windowed duty metric still lags: p952's
 * nvme0n1 1 h rate read 3.86 TB a day against 4 at 19:03Z on 10-24 while d5's 24 h rate read 6.12.
 */
export function fixStepStreak(runs: readonly DutyRunRecord[], key: string, step: string, above: readonly string[] = []):
  { misses: number; moved: boolean; worked?: WorkedMove } {
  const named: MetricResult[] = [];
  const readings: WorkedReading[] = [];
  for (const run of streakRuns(runs)) {
    const found = effectiveRun(run).metrics[key];
    const fix = run.fixes?.[key];
    if (!found || found.met || (fix?.step === step && fix.hold !== undefined)) break;
    if (fix?.step !== step) continue;
    const reading = workedReading(run, fix, step, above);
    if (reading && (named.length === 0 || reading.item === readings[0]?.item)) readings.push(reading);
    named.push(found);
  }
  const misses = named.length;
  const now = readings[0];
  const first = readings[readings.length - 1];
  if (now && first) {
    const onTarget = (reading: WorkedReading): boolean => reading.op === "<=" ? reading.value <= reading.target : reading.op === ">=" && reading.value >= reading.target;
    const distance = (reading: WorkedReading): number => onTarget(reading) ? 0 : Math.abs(reading.value - reading.target);
    return { misses: readings.length, moved: onTarget(now) || distance(now) < distance(first),
      worked: { item: now.item, from: first.value, to: now.value, target: now.target } };
  }
  return { misses, moved: misses > 0 && gap(named[0]!) < gap(named[misses - 1]!) };
}

/** The current miss streak of every metric the newest measured run missed, from runs newest first. */
export function metricStreaks(runs: readonly DutyRunRecord[]): MetricStreak[] {
  const ordered = streakRuns(runs);
  const newest = ordered[0];
  if (!newest) return [];
  const streaks: MetricStreak[] = [];
  for (const [key, result] of Object.entries(effectiveRun(newest).metrics)) {
    if (result.met) continue;
    let oldest = result;
    let since = newest.at;
    const streak: DutyRunRecord[] = [];
    for (const run of ordered) {
      const found = effectiveRun(run).metrics[key];
      if (!found || found.met) break;
      streak.push(run);
      oldest = found;
      since = run.at;
    }
    const misses = streak.length;
    const moved = gap(result) < gap(oldest);
    const fix = newest.fixes?.[key];
    const judged = fix ? fixMisses(streak, key, fix) : misses;
    const previous = runs.filter(measured).find(run => run.at < newest.at);
    const quiet = result.lastEventAt !== undefined && previous !== undefined && result.lastEventAt < previous.at;
    streaks.push({ key, misses, moved, since, value: result.value, target: result.target, op: result.op, ...(fix ? { fix } : {}),
      ...(quiet ? { quietSince: result.lastEventAt } : {}), stuck: judged >= CHANGE_APPROACH_MISSES && !moved && !quiet });
  }
  return streaks;
}
