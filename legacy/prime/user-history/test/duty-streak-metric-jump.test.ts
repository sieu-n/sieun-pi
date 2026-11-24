// Guards the Wiki dream's d4 on 11-24: sieun-pi 6ac4ef14 added pages_over_core_length to wiki_problems after the 00:30Z run read 9, the next
// runs read 333, 309, 292, 277, 265 and 242 while the job "wiki pages to the core" cut pages, and every run from 01:01Z to 02:03Z judged the
// streak against its first reading and called wiki_problems stuck, so the duty runner asked for a root-cause job. At 02:03Z the 00:30Z run's after-job measure
// read 242, the same as the 02:03Z run, so that run asked too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";

const metrics: DutyMetric[] = [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0 }];
const fix = { step: "p200", live: false };

function run(at: number, value: number, extra: Partial<DutyRunRecord> = {}): DutyRunRecord {
  const { metrics: results, verdict, summary } = judge(metrics, { metrics: { wiki_problems: value } });
  return { duty: "d4", at, trigger: "push", ms: 1, verdict, metrics: results, summary, fixes: { wiki_problems: fix }, ...extra };
}

/** d4's wiki_problems readings on 11-24 from 00:30Z, a run about every 15 min, as its runs file holds them. */
const readings = [9, 333, 309, 292, 277, 265, 242, 217, 190, 154];
const start = Date.parse("2026-11-24T00:30:49Z");
const at = (index: number): number => start + index * 15.5 * 60_000;

/** The runs the runner read when run `last` started, newest first. */
function runsAt(last: number, firstAfter?: number): DutyRunRecord[] {
  return readings.slice(0, last + 1).map((value, index) => index === 0 && firstAfter !== undefined
    ? run(at(0), value, { after: { at: at(last), ...judge(metrics, { metrics: { wiki_problems: firstAfter } }) } })
    : run(at(index), value)).reverse();
}

test("a number that falls run after run after a jump is not stuck", () => {
  // At 01:01Z the last three runs read 9, 333 and 309, a rise, so that run still reads stuck; each run after it judges three falling readings.
  assert.equal(metricStreaks(runsAt(2))[0]?.stuck, true);
  for (let last = 3; last < readings.length; last++) {
    const [streak] = metricStreaks(runsAt(last));
    assert.equal(streak?.misses, last + 1);
    assert.equal(streak.moved, true, `run ${last} read ${readings[last]}`);
    assert.equal(streak.stuck, false, `run ${last} read ${readings[last]}`);
    assert.equal(fixStepStreak(runsAt(last), "wiki_problems", "p200").moved, true, `fix at run ${last}`);
  }
});

test("the 02:03Z run is not stuck when the first run's after-job measure equals its reading", () => {
  const [streak] = metricStreaks(runsAt(6, 242));
  assert.equal(streak?.value, 242);
  assert.equal(streak.stuck, false);
});

test("a flat or rising tail after a fall stays stuck", () => {
  for (const tail of [[333, 300, 300, 300], [333, 300, 301, 302]]) {
    const runs = tail.map((value, index) => run(at(index), value)).reverse();
    const [streak] = metricStreaks(runs);
    assert.equal(streak?.stuck, true, tail.join(", "));
    assert.equal(fixStepStreak(runs, "wiki_problems", "p200").moved, false, tail.join(", "));
  }
});
