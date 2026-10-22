// Slack green guy on 10-22: d1 targeted three growth numbers that the plan goals p145, p151 and p166 hold, so it read red every day (c110).
// They became readings: the precheck prints them, the verdict never counts them, and each run writes them into the goals that name them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Duty, judge, outputReadings, PLACEHOLDER, upsertDuty } from "../src/shared/chat-duties.ts";

const definition = (readings?: unknown) => ({
  name: "Visitors become paying users", ownerWords: "conversion funnel", goal: "the funnel measure works", onMiss: "fix the broken check",
  schedule: { kind: "daily", at: "09:30" }, precheck: { command: ["node", "x.ts"], cwd: "/tmp" },
  metrics: [{ key: "home_test_reach_pct", label: "Home test reach", op: ">=", target: 90, unit: "%", headline: true }, { key: "source_errors", label: "Failed sources", op: "<=", target: 0 }],
  ...(readings === undefined ? {} : { readings }),
});

test("a duty keeps its readings, the verdict leaves them out, and a definition without them drops them", () => {
  const duties: Duty[] = [];
  assert.equal(upsertDuty(duties, definition([{ key: "signup_to_workspace_pct", label: "Signups who connect Slack", unit: "%" }]), 1), "added d1");
  assert.deepEqual(duties[0]!.readings, [{ key: "signup_to_workspace_pct", label: "Signups who connect Slack", unit: "%" }]);
  const output = { metrics: { home_test_reach_pct: 94.34, source_errors: 0, signup_to_workspace_pct: 21.25, on_topic_visit_to_paid_pct: 0.56 } };
  const judged = judge(duties[0]!.metrics, output);
  assert.equal(judged.verdict, "met");
  assert.deepEqual(Object.keys(judged.metrics), ["home_test_reach_pct", "source_errors"]);
  assert.deepEqual(outputReadings(duties[0]!.readings, output), { signup_to_workspace_pct: 21.25 });
  assert.equal(outputReadings(duties[0]!.readings, { metrics: { signup_to_workspace_pct: PLACEHOLDER } }), undefined);
  assert.equal(upsertDuty(duties, definition([{ key: "signup_to_workspace_pct", label: "Signups who connect Slack", unit: "%" }]), 2), "unchanged d1");
  assert.equal(upsertDuty(duties, definition(), 3), "updated d1");
  assert.equal(duties[0]!.readings, undefined);
  assert.equal(upsertDuty(duties, definition(), 4), "unchanged d1");
});

test("a reading that is also a metric or has no label is refused", () => {
  assert.throws(() => upsertDuty([], definition([{ key: "source_errors", label: "Failed sources" }]), 1), /readings\[0\]/);
  assert.throws(() => upsertDuty([], definition([{ key: "signup_to_workspace_pct" }]), 1), /readings\[0\]/);
  assert.throws(() => upsertDuty([], definition({ key: "x" }), 1), /readings: a list/);
});
