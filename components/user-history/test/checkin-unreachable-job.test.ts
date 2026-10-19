// mac-management 10-19 16:44Z: a failed check-in push recommended replacing four jobs; email template made a tool call ten seconds later.
// A timeout can follow prompt acceptance, so its outcome stays unknown even when the last observed turn had failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type JobPush, jobPushLine } from "../src/checkin-jobs.ts";

const push = (name: string, owes: string[]): JobPush => ({ fact: { key: name, name, sessionId: `session-${name}`, state: "working" }, act: "restart", idleMs: 2 * 15 * 60_000, owes, why: "nothing moved" });
const old = push("search flows end to end", []);
const live = push("vent webhooks", ["Send every incoming webhook through Vent"]);

test("an unconfirmed push checks the existing job and does not revive an old job with no open work", () => {
  assert.equal(jobPushLine([old], new Set([old.fact.key])), null);
  const line = jobPushLine([old, live], new Set([old.fact.key, live.fact.key])) ?? "";
  assert.match(line, /Could not confirm delivery to job vent webhooks \(session-vent webhooks\)/);
  assert.match(line, /may already be queued or accepted/);
  assert.match(line, /current state, queued messages, provider wait and recent progress before retrying/);
  assert.match(line, /keep its session and model/);
  assert.match(line, /replace it only after confirming it cannot be resumed and still owns unfinished work/);
  assert.doesNotMatch(line, /start a job in its place|restarted job vent webhooks|because nothing moved/);
  assert.doesNotMatch(line, /search flows end to end/);
});

test("a failed restart keeps delivery unknown even when the prior turn ended or waited on the provider", () => {
  for (const state of ["working", "ended", "failed"] as const) {
    const job = { ...live, fact: { ...live.fact, state, error: "pi-pool: claude16 waits for its slot" } };
    const line = jobPushLine([job], new Set([job.fact.key])) ?? "";
    assert.match(line, /Could not confirm delivery/);
    assert.match(line, /A delivery failure does not mean the job stopped/);
    assert.doesNotMatch(line, /start a job in its place|restarted job/);
  }
});

test("confirmed restart and nudge results stay separate from uncertain deliveries", () => {
  const stopped = { ...push("stopped job", ["Finish its step"]), fact: { key: "stopped", name: "stopped job", state: "failed" as const } };
  const nudged = { ...push("active job", ["Finish its other step"]), act: "nudge" as const };
  const line = jobPushLine([stopped, nudged, live], new Set([live.fact.key])) ?? "";
  assert.match(line, /^Check-in: restarted job stopped job; nudged job active job, because nothing moved on their work\./);
  assert.match(line, /Could not confirm delivery to job vent webhooks/);
  assert.doesNotMatch(line, /restarted job vent webhooks|start a job in its place/);
  assert.equal(jobPushLine([stopped]), "Check-in: restarted job stopped job, because nothing moved on their work.");
});
