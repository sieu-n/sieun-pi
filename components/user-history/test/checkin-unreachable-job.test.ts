// Vent 10-18 16:56Z: the check-in said "could not reach job search flows end to end, so start a job in its place" though p7 had moved to
// "search flows finish thread", which reported at 16:53Z. The old job owned no open step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type JobPush, jobPushLine } from "../src/checkin-jobs.ts";

const push = (name: string, owes: string[]): JobPush => ({ fact: { key: name, name, state: "working" }, act: "restart", idleMs: 2 * 15 * 60_000, owes, why: "nothing moved" });
const old = push("search flows end to end", []);
const live = push("vent webhooks", ["Send every incoming webhook through Vent"]);

test("a job the server cannot reach needs a job in its place only when it owns an open step", () => {
  assert.equal(jobPushLine([old], new Set([old.fact.key])), null);
  const line = jobPushLine([old, live], new Set([old.fact.key, live.fact.key])) ?? "";
  assert.match(line, /could not reach job vent webhooks, so start a job in its place/);
  assert.doesNotMatch(line, /search flows end to end/);
});
