import { missedKeys } from "./shared/duty-fixes.ts";
import { type DutyRunRecord, STILL_WORKING } from "./shared/chat-duties.ts";
import { effectiveRun, metricStreaks, newestReading } from "./shared/duty-streak.ts";

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
function endedUnpushed(runs: readonly DutyRunRecord[]): boolean {
  const index = runs.findIndex(run => run.job !== undefined);
  const last = runs[index];
  if (!last || (!last.after && !last.cut)) return false;
  const ended = last.after?.at ?? last.cut?.at ?? last.at;
  if (runs.slice(0, index).some(run => run.verdict !== "skipped" && run.at >= ended && !run.summary.includes(STILL_WORKING))) return false;
  const origin = last.trigger === "rerun" ? runs.find(run => run.at === last.rerunOf) ?? last : last;
  return last.trigger !== "push" && origin.trigger !== "push";
}

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
 * A met run whose counted metric has parts gets a push with no keys (`[]`) once it is `everyMs` old even with every part on target, so a page
 * that falls behind later is seen within one interval; the push run starts no job when it reads met with every part on target (`run` in
 * src/chat-duty-run.ts). On 10-25 the Wiki dream's after-job measure of 12:30Z read wiki_problems_following 0, no run read d4 again until its
 * 16:30Z schedule run, and that run read wiki_problems 45 and wiki_problems_following 13.
 */
export function pushMisses(runs: readonly DutyRunRecord[], counted: ReadonlySet<string>, everyMs: number, now: number): string[] | null {
  const newest = runs[0];
  if (!newest) return null;
  const holder = newestReading(runs);
  if (!holder) return null;
  const measured = effectiveRun(holder);
  if (measured.verdict === "missed") {
    const keys = missedKeys(measured).filter(key => counted.has(key));
    if (now - newest.at >= everyMs) return keys.length ? keys : null;
    const quiet = new Set(metricStreaks(runs).filter(streak => streak.quietSince !== undefined).map(streak => streak.key));
    const owed = endedUnpushed(runs) ? keys.filter(key => !quiet.has(key)) : [];
    return owed.length ? owed : null;
  }
  if (now - newest.at < everyMs) return null;
  const parts = Object.fromEntries(Object.entries(measured.parts ?? {}).filter(([key]) => [...counted].some(metric => key.startsWith(`${metric}_`))));
  return Object.keys(parts).length ? missedKeys({ metrics: parts }) : null;
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
