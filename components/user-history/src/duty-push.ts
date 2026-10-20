import { missedKeys } from "./shared/duty-fixes.ts";
import type { DutyRunRecord } from "./shared/chat-duties.ts";
import { effectiveRun } from "./shared/duty-streak.ts";

/**
 * The counted metrics a push run of a standing duty goes after, or null when the duty gets no push now. `runs` are the duty's runs, newest
 * first. The duty is red when its newest met-or-missed run (`effectiveRun`, so a run whose after-job measure is met counts green) missed a
 * counted metric. It gets a push once its newest run of any verdict is `everyMs` old, the chat's check-in interval: the owner's own push
 * cadence for the chat. Without it a red daily duty waited a whole day after its fix job ended, and forever when its job did not start: from
 * 10-16 to 10-18 four daily duties sat red with no job for 1 to 2 days after "the catalog cannot list the chat".
 *
 * A met run whose part of a counted metric (`metricParts`, `<metricKey>_<part>`) is off target gets a push for that part too: the part is work
 * the verdict waits to count. The Wiki dream's `wiki_problems_following` counts pages behind their code for less than the time one push run
 * and one rewrite take, so they are rewritten before they count; on 10-20 cited code changed under 20 pages in the 15 min after 48 were
 * rewritten. Until then no duty's met run had a part off target, so this pushes no other duty.
 */
export function pushMisses(runs: readonly DutyRunRecord[], counted: ReadonlySet<string>, everyMs: number, now: number): string[] | null {
  const newest = runs[0];
  if (!newest || now - newest.at < everyMs) return null;
  const measured = runs.map(effectiveRun).find(run => run.verdict === "met" || run.verdict === "missed");
  if (!measured) return null;
  if (measured.verdict === "missed") {
    const keys = missedKeys(measured).filter(key => counted.has(key));
    return keys.length ? keys : null;
  }
  const parts = missedKeys({ metrics: measured.parts ?? {} }).filter(key => [...counted].some(metric => key.startsWith(`${metric}_`)));
  return parts.length ? parts : null;
}
