// Guards the d9 pairs of 11-20 to 11-22. The AI harness chat's d9 job of each 2-hour slot ended red in 1 to 6 min on duties_green_pct, which
// other chats' duties hold red, and each end started a push run with a second job briefed on the same miss: 01:32 and 01:36, 03:32 and 03:33,
// 05:32 and 05:38 KST on 11-22. The run is d9's 05:32 KST schedule run from the runs file, with its after-job measure of 05:37:45.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pushMisses } from "../src/duty-push.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const RUN = JSON.parse(String.raw`{"duty": "d9", "at": 1795293141089, "slot": 1795293141086, "trigger": "schedule", "ms": 13324, "verdict": "missed", "metrics": {"stuck_steps_all": {"value": 0, "target": 0, "op": "<=", "met": true}, "stuck_duties": {"value": 0, "target": 0, "op": "<=", "met": true}, "fix_not_moving": {"value": 0, "target": 0, "op": "<=", "met": true}, "duties_green_pct": {"value": 82.3, "target": 100, "op": ">=", "met": false}}, "summary": "stuck_steps_all 0 (on target), duties_green_pct 82.3% (target at least 100%)", "job": {"id": "01a1ffcf-8ed1-7091-a563-8869174bb8c0", "name": "chat system AI harness developer environment 05:32"}, "after": {"at": 1795293465802, "verdict": "missed", "metrics": {"stuck_steps_all": {"value": 0, "target": 0, "op": "<=", "met": true}, "stuck_duties": {"value": 0, "target": 0, "op": "<=", "met": true}, "fix_not_moving": {"value": 0, "target": 0, "op": "<=", "met": true}, "duties_green_pct": {"value": 83.8, "target": 100, "op": ">=", "met": false}}, "summary": "stuck_steps_all 0 (on target), duties_green_pct 83.8% (target at least 100%)"}}`) as DutyRunRecord;
const COUNTED = new Set(["stuck_steps_all", "duties_green_pct", "stuck_duties", "fix_not_moving"]);
const EVERY = 60 * 60_000;

test("a job that ended red on the misses its own run read gets no push at once, and the check-in interval brings the next one", () => {
  const ended = RUN.after!.at;
  assert.equal(pushMisses([RUN], COUNTED, EVERY, ended + 30_000), null);
  assert.equal(pushMisses([RUN], COUNTED, EVERY, RUN.at + EVERY - 1), null);
  assert.deepEqual(pushMisses([RUN], COUNTED, EVERY, RUN.at + EVERY), ["duties_green_pct"]);
});

test("a cut job that did not finish still owes a push at once on its run's misses", () => {
  const { after: _after, ...rest } = RUN;
  const cut: DutyRunRecord = { ...rest, cut: { error: "terminated", at: RUN.at + 3 * 60_000 } };
  assert.deepEqual(pushMisses([cut], COUNTED, EVERY, RUN.at + 4 * 60_000), ["duties_green_pct"]);
});

test("an after-job measure that misses a metric the job's run read on target owes a push at once on that metric only", () => {
  const missed = { ...RUN.after!.metrics.stuck_duties!, value: 2, met: false };
  const after = { ...RUN.after!, metrics: { ...RUN.after!.metrics, stuck_duties: missed } };
  assert.deepEqual(pushMisses([{ ...RUN, after }], COUNTED, EVERY, after.at + 30_000), ["stuck_duties"]);
});
