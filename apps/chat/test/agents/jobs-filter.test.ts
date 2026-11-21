/**
 * The Jobs tab's filters and search (agents-model.ts).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/agents/jobs-filter.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobFilterCounts, jobFilterOf, jobFilterOfJob, jobsShown } from "../../web/src/pages/agents/agents-model.ts";

const jobs = [
  { id: "a", name: "skills tab design", status: "working" as const, archived: false },
  { id: "b", name: "read ahead bursts", status: "sleeping" as const, archived: false },
  { id: "c", name: "thread open after reload", status: "idle" as const, archived: false },
  { id: "d", name: "Skills list speed", status: "failed" as const, archived: false },
  { id: "e", name: "old skills sweep", status: "idle" as const, archived: true },
];

test("a job is Active while it works or waits, Finished once it ends, and Archived when put away", () => {
  assert.deepEqual(jobs.map(jobFilterOfJob), ["active", "active", "finished", "finished", "archived"]);
  assert.deepEqual(jobFilterCounts(jobs, ""), { active: 2, finished: 2, archived: 1 });
});

test("search matches job names in any case and counts each filter's hits", () => {
  assert.deepEqual(jobFilterCounts(jobs, " SKILLS "), { active: 1, finished: 1, archived: 1 });
  assert.deepEqual(jobsShown(jobs, "finished", "skills").map((j) => j.id), ["d"]);
  assert.deepEqual(jobsShown(jobs, "active", "").map((j) => j.id), ["a", "b"]);
});

test("the tab opens on Active while a job runs, on Finished when none does, and on what the URL names", () => {
  assert.equal(jobFilterOf(undefined, { active: 2, finished: 2, archived: 1 }), "active");
  assert.equal(jobFilterOf(undefined, { active: 0, finished: 2, archived: 1 }), "finished");
  assert.equal(jobFilterOf("archived", { active: 2, finished: 2, archived: 1 }), "archived");
  assert.equal(jobFilterOf("bogus", { active: 0, finished: 0, archived: 0 }), "finished");
});
