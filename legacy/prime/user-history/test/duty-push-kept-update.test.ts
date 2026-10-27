// Guards the push loop of 10-27 on the AI harness chat's d7. Its 07:54Z job ended red with an after-job measure at 08:29Z, and from 09:25Z
// to 10:06Z every push run read red and started no job, since the ended job was kept while Prime update 658984-1793090758889 was stopping.
// A STILL_WORKING run never counted as the push that followed the end, so the duty got a push run every 30 s: 80 of them. The runs are d7's
// from the runs file, newest first, with the metrics cut to the three it missed or met.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pushMisses } from "../src/duty-push.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const RUNS = JSON.parse(String.raw`[{"duty": "d7", "at": 1793093167032, "trigger": "push", "ms": 6157, "verdict": "missed", "summary": "quiet_agent_gb 0.7 GB (on target), clean_min_30 1 min (target at least 30 min), queue_holds_30 2 (target at most 0); skipped: previous run still working (job whole system AI harness developer environment 16:54 is kept while Prime update 658984-1793090758889 is stopping)", "metrics": {"quiet_agent_gb": {"value": 0.65, "target": 5, "op": "<=", "met": true}, "clean_min_30": {"value": 1, "target": 30, "op": ">=", "met": false}, "queue_holds_30": {"value": 2, "target": 0, "op": "<=", "met": false}}}, {"duty": "d7", "at": 1793093136674, "trigger": "schedule", "ms": 6349, "verdict": "missed", "summary": "quiet_agent_gb 0.7 GB (on target), clean_min_30 2 min (target at least 30 min), queue_holds_30 2 (target at most 0); skipped: previous run still working (job whole system AI harness developer environment 16:54 is kept while Prime update 658984-1793090758889 is stopping)", "metrics": {"quiet_agent_gb": {"value": 0.65, "target": 5, "op": "<=", "met": true}, "clean_min_30": {"value": 2, "target": 30, "op": ">=", "met": false}, "queue_holds_30": {"value": 2, "target": 0, "op": "<=", "met": false}}}, {"duty": "d7", "at": 1793091336532, "trigger": "schedule", "ms": 8982, "verdict": "missed", "summary": "quiet_agent_gb 8.2 GB (target at most 5 GB); skipped: previous run still working (job whole system AI harness developer environment 16:54 is kept while Prime update 658984-1793090758889 is stopping)", "metrics": {"quiet_agent_gb": {"value": 8.17, "target": 5, "op": "<=", "met": false}, "clean_min_30": {"value": 30, "target": 30, "op": ">=", "met": true}, "queue_holds_30": {"value": 0, "target": 0, "op": "<=", "met": true}}}, {"duty": "d7", "at": 1793089506573, "trigger": "schedule", "ms": 10537, "verdict": "missed", "summary": "quiet_agent_gb 11.2 GB (target at most 5 GB); skipped: previous run still working (job whole system AI harness developer environment 16:54 waits 13 of 95 in pi-pool's turn queue)", "metrics": {"quiet_agent_gb": {"value": 11.2, "target": 5, "op": "<=", "met": false}, "clean_min_30": {"value": 30, "target": 30, "op": ">=", "met": true}, "queue_holds_30": {"value": 0, "target": 0, "op": "<=", "met": true}}}, {"duty": "d7", "at": 1793087684324, "trigger": "schedule", "ms": 9064, "verdict": "missed", "summary": "quiet_agent_gb 6.5 GB (target at most 5 GB), clean_min_30 23 min (target at least 30 min)", "metrics": {"quiet_agent_gb": {"value": 6.49, "target": 5, "op": "<=", "met": false}, "clean_min_30": {"value": 23, "target": 30, "op": ">=", "met": false}, "queue_holds_30": {"value": 0, "target": 0, "op": "<=", "met": true}}, "job": {"id": "01a17c5a-ecda-710e-9531-993fcec1bf9d", "name": "whole system AI harness developer environment 16:54"}, "after": {"at": 1793089747433, "verdict": "missed", "metrics": {"quiet_agent_gb": {"value": 11.2, "target": 5, "op": "<=", "met": false}, "clean_min_30": {"value": 30, "target": 30, "op": ">=", "met": true}, "queue_holds_30": {"value": 0, "target": 0, "op": "<=", "met": true}}, "summary": ""}}]`) as DutyRunRecord[];
const COUNTED = new Set(["quiet_agent_gb", "clean_min_30", "queue_holds_30"]);
const EVERY = 60 * 60_000;

test("a push run that found the ended job kept by a Prime update counts as the push, so the next tick starts none", () => {
  const firstPush = RUNS[0]!;
  assert.equal(firstPush.trigger, "push");
  assert.match(firstPush.summary, / is kept while Prime update /);
  assert.equal(pushMisses(RUNS, COUNTED, EVERY, firstPush.at + 30_000), null);
  assert.notEqual(pushMisses(RUNS, COUNTED, EVERY, firstPush.at + EVERY), null, "the check-in interval still brings the next push");
});

test("the red end of the 07:54Z job owes one push at once while no run has read the duty since", () => {
  const job = RUNS.at(-1)!;
  assert.equal(job.trigger, "schedule");
  assert.notEqual(pushMisses([job], COUNTED, EVERY, job.after!.at + 60_000), null);
});
