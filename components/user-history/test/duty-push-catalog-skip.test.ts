// Guards the push loop of 10-26 on slack green guy (01a11b0b), whose session lived on the Mac while Tailscale read it offline. Its d1 job of
// 10-25 00:30Z ended red at 00:57Z, so the duty owed a push at once (`endedUnpushed`). Every push run measured, read red and started no job
// ("skipped: the catalog does not list the chat"), which left that job the newest one, so the duty got a push run about every 30 s from its
// 00:30Z schedule run on 10-26: 117 in the 01Z hour, each running the PostHog precheck for about 8 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pushMisses } from "../src/duty-push.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";

const at = (time: string) => Date.parse(`2026-10-${time}Z`);
const COUNTED = new Set(["home_test_reach_pct", "source_errors"]);
const EVERY = 60 * 60_000;
const reach = (value: number): Record<string, MetricResult> => ({
  home_test_reach_pct: { value, target: 90, op: ">=", met: value >= 90 },
  source_errors: { value: 0, target: 0, op: "<=", met: true },
});
const run = (time: string, trigger: DutyRunRecord["trigger"], value: number, summary = "skipped: the catalog does not list the chat"): DutyRunRecord =>
  ({ duty: "d1", at: at(time), trigger, ms: 8000, verdict: value >= 90 ? "met" : "missed", metrics: reach(value), summary });

const jobRun: DutyRunRecord = {
  ...run("25T00:30:30", "schedule", 66.67, ""),
  job: { id: "01a17077-bd9e-7416-b73b-aacf6fbeccd2", name: "visitors become paying users slack green guy 10-25 09:30" },
  after: { at: at("25T00:57:25"), verdict: "missed", metrics: reach(66.67), summary: "" },
};

test("a push run that measured red and started no job waits the check-in interval, instead of firing again on the next tick", () => {
  assert.deepEqual(pushMisses([jobRun], COUNTED, EVERY, at("25T00:58:00")), ["home_test_reach_pct"], "the red end of the job owes one push at once");
  const pushed = [run("25T00:58:00", "push", 66.67), jobRun];
  assert.equal(pushMisses(pushed, COUNTED, EVERY, at("25T00:58:30")), null);
  assert.equal(pushMisses(pushed, COUNTED, EVERY, at("25T01:57:59")), null);
  assert.deepEqual(pushMisses(pushed, COUNTED, EVERY, at("25T01:58:00")), ["home_test_reach_pct"]);
});

test("the runs of 10-26 get no push 30 s after the 00:30Z schedule run, which read the duty a day after the job ended", () => {
  const runs = [run("26T00:30:37", "push", 84.6), run("26T00:30:08", "schedule", 84.6), run("25T08:36:01", "verify", 100), jobRun];
  assert.equal(pushMisses(runs.slice(1), COUNTED, EVERY, at("26T00:30:37")), null);
  assert.equal(pushMisses(runs, COUNTED, EVERY, at("26T00:31:08")), null);
  assert.deepEqual(pushMisses(runs, COUNTED, EVERY, at("26T01:30:37")), ["home_test_reach_pct"]);
});

test("a duty job that just ended red still gets its push at once, and a push run beside it while it worked does not count", () => {
  const beside = run("25T00:45:00", "push", 66.67, "skipped: previous run still working (job visitors become paying users); handed it 1 item");
  assert.deepEqual(pushMisses([beside, jobRun], COUNTED, EVERY, at("25T00:58:00")), ["home_test_reach_pct"]);
});
