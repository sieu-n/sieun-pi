// 10-25 06:05Z: d9 counted SEO guy's p101 as stuck. Its job field held the session id of the thread "sep launch!!", which ran on the offline
// Mac that For you t30 asked the owner to bring back, and it had no sessionId, so the step read as running on the chat's own box.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pausedHold, stepSessions } from "../scripts/duties/whole-system.ts";

const THREAD = "01a15427-145f-751d-ba15-d27b6c30f65f";
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const hosts = new Map([[SEO, "us-metal02"], [THREAD, "mac"]]);
const holds = new Map([["mac", { host: "mac", todo: "t30" }]]);

test("a job field that holds a session id names that session, and a job name still resolves through the chat's jobs", () => {
  assert.deepEqual(stepSessions({ job: THREAD }, new Map()), [THREAD]);
  assert.deepEqual(stepSessions({ job: "seo indexing" }, new Map([["seo indexing", ["s-1"]]])), ["s-1"]);
  assert.deepEqual(stepSessions({ job: "seo indexing" }, new Map()), []);
});

test("a paused chat's step whose job is a session id on an offline box waits on the todo that asks the owner to bring it back", () => {
  assert.deepEqual(pausedHold({ job: THREAD }, SEO, new Map(), hosts, holds), { host: "mac", todo: "t30" });
  assert.equal(pausedHold({ job: "seo indexing" }, SEO, new Map(), hosts, holds), undefined);
});
