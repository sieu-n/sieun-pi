// Guards the clear time d9 prints for a duty red only on windowed counts. At 22:25Z on 10-26 d9 listed CI and RepoOps d5 as red only on
// counts that age out with its newest event at 02:35Z, and the AI harness chat read that as d5 clearing at 02:35Z on 10-27. d5 also counts
// refused_lands_promotes_7d, whose one refusal of 21:53Z on 10-25 stays in its window until 21:53Z on 11-01. The runs are d5's last three
// from the runs file, newest first, with their summaries left out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, agingUntil } from "../scripts/duties/chat-system.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const RUNS = JSON.parse(String.raw`[{"duty": "d5", "at": 1793052601724, "trigger": "schedule", "ms": 71057, "verdict": "missed", "summary": "", "metrics": {"false_reds_24h": {"value": 2, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793041114000}, "refused_lands_promotes_7d": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792965210000}}, "after": {"at": 1793053111754, "verdict": "missed", "metrics": {"false_reds_24h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792982148290}, "refused_lands_promotes_7d": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792965210000}}, "summary": ""}}, {"duty": "d5", "at": 1793003246712, "trigger": "owner", "ms": 125936, "verdict": "missed", "summary": "", "metrics": {"false_reds_24h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792982148290}, "refused_lands_promotes_7d": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792965210000}}, "after": {"at": 1793003526336, "verdict": "missed", "metrics": {"false_reds_24h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792982148290}, "refused_lands_promotes_7d": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792965210000}}, "summary": ""}}, {"duty": "d5", "at": 1792982453558, "trigger": "push", "ms": 140591, "verdict": "missed", "summary": "", "metrics": {"false_reds_24h": {"value": 0, "target": 0, "op": "<=", "met": true}, "refused_lands_promotes_7d": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792965210000}}, "after": {"at": 1792983159044, "verdict": "missed", "metrics": {"false_reds_24h": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792982148290}, "refused_lands_promotes_7d": {"value": 1, "target": 0, "op": "<=", "met": false, "lastEventAt": 1792965210000}}, "summary": ""}}]`) as DutyRunRecord[];

test("CI d5 of 10-26 clears when its 7-day refusal leaves the window, not at its newest event", () => {
  assert.equal(new Date(agingSince(RUNS)!).toISOString().slice(0, 16), "2026-10-26T02:35");
  assert.equal(new Date(agingUntil(RUNS)!).toISOString().slice(0, 16), "2026-11-01T21:53");
});

test("a duty with a quiet miss whose key names no window gets no clear time", () => {
  const renamed = RUNS.map(run => ({ ...run, metrics: Object.fromEntries(Object.entries(run.metrics).map(([key, value]) => [key === "refused_lands_promotes_7d" ? "refused_lands" : key, value])),
    ...run.after ? { after: { ...run.after, metrics: Object.fromEntries(Object.entries(run.after.metrics).map(([key, value]) => [key === "refused_lands_promotes_7d" ? "refused_lands" : key, value])) } } : {} }));
  assert.notEqual(agingSince(renamed), undefined);
  assert.equal(agingUntil(renamed), undefined);
});
