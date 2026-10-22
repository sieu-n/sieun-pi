import { missedKeys } from "./shared/duty-fixes.ts";
import type { DutyRunRecord } from "./shared/chat-duties.ts";
import { effectiveRun, metricStreaks } from "./shared/duty-streak.ts";

/**
 * The newest met-or-missed reading of the duty by the time it was taken: a run's after-job measure at its own `at`, else the run at its start.
 * Runs are ordered by start, and an older run's after-job measure can be newer than a later run: on 10-20 the Wiki dream's 00:46Z run read
 * wiki_problems 43 after its job at 03:26Z, while a 02:02Z verify run, skipped behind that job, had read 0 under the old stale check. The first
 * run in order read 0, so no push run started from 03:26Z to past 05:52Z while 20 pages sat behind their code.
 */
function newestReading(runs: readonly DutyRunRecord[]): ReturnType<typeof effectiveRun> | undefined {
  let best: { at: number; run: ReturnType<typeof effectiveRun> } | undefined;
  for (const run of runs) {
    const reading = effectiveRun(run);
    if (reading.verdict !== "met" && reading.verdict !== "missed") continue;
    const at = run.after?.at ?? run.at;
    if (!best || at > best.at) best = { at, run: reading };
  }
  return best?.run;
}

/**
 * Whether the duty's newest job ended with no push job since: that job is no push run's, its after-job measure is in, and no push run started
 * a job after that measure. Its duty then gets its push at once instead of a check-in interval after the newest run. At 07:30:45Z on 10-22 ops
 * guy's 23:08Z Local dev servers job ended on restarts 2 with no fix step, a push at 07:31:42Z found it answering a message and started no job,
 * and the next push waited for 09:31Z, so d9 counted the duty stuck till then. A push job that ends red waits the interval as before.
 */
function endedUnpushed(runs: readonly DutyRunRecord[]): boolean {
  const last = runs.find(run => run.job !== undefined);
  if (!last?.after || last.trigger === "push") return false;
  const ended = last.after.at;
  return !runs.some(run => run.trigger === "push" && run.job !== undefined && run.at >= ended);
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
 */
export function pushMisses(runs: readonly DutyRunRecord[], counted: ReadonlySet<string>, everyMs: number, now: number): string[] | null {
  const newest = runs[0];
  if (!newest) return null;
  const measured = newestReading(runs);
  if (!measured) return null;
  if (measured.verdict === "missed") {
    const keys = missedKeys(measured).filter(key => counted.has(key));
    if (now - newest.at >= everyMs) return keys.length ? keys : null;
    const quiet = new Set(metricStreaks(runs).filter(streak => streak.quietSince !== undefined).map(streak => streak.key));
    const owed = endedUnpushed(runs) ? keys.filter(key => !quiet.has(key)) : [];
    return owed.length ? owed : null;
  }
  if (now - newest.at < everyMs) return null;
  const parts = missedKeys({ metrics: measured.parts ?? {} }).filter(key => [...counted].some(metric => key.startsWith(`${metric}_`)));
  return parts.length ? parts : null;
}
