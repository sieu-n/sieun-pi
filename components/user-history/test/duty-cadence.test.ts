import assert from "node:assert/strict";
import { test } from "node:test";
import { cadenceDraft, cadenceSchedule, classesLabel, flaggedLabel } from "../src/client/duty-cadence.ts";
import { CHECK_IN_DUTY, type DutyRunRecord, type DutyView } from "../src/shared/chat-duties.ts";

const record = (changes: Partial<DutyRunRecord>): DutyRunRecord => ({ duty: "checkin", at: 1, trigger: "schedule", ms: 0, verdict: "missed", metrics: {}, summary: "", ...changes });
const view = (runs: DutyRunRecord[]): DutyView => ({ duty: { ...CHECK_IN_DUTY, status: "active" }, builtin: "checkin", schedule: { kind: "every", minutes: 15 }, paused: false,
  nextAt: null, running: false, runs, priority: "high" });

test("duty cadence editor: the draft starts from the schedule; the check-in saves 1 to 240 minutes and no daily time; another duty 5 to 10080 minutes or HH:MM", () => {
  assert.deepEqual(cadenceDraft({ kind: "every", minutes: 15 }), { kind: "every", minutes: 15, at: "09:00" });
  assert.deepEqual(cadenceDraft({ kind: "daily", at: "23:07" }), { kind: "daily", minutes: 60, at: "23:07" });
  assert.deepEqual(cadenceSchedule({ kind: "every", minutes: 2, at: "" }, true), { kind: "every", minutes: 2 }, "the header's 1 to 240 range");
  assert.deepEqual(cadenceSchedule({ kind: "every", minutes: 241, at: "" }, true), { error: "Give 1 to 240 minutes." });
  assert.deepEqual(cadenceSchedule({ kind: "daily", minutes: 0, at: "09:00" }, true), { error: "The check-in runs every N minutes." });
  assert.deepEqual(cadenceSchedule({ kind: "every", minutes: 2, at: "" }, false), { error: "Give 5 to 10080 minutes." });
  assert.deepEqual(cadenceSchedule({ kind: "every", minutes: 1.5, at: "" }, false), { error: "Give 5 to 10080 minutes." });
  assert.deepEqual(cadenceSchedule({ kind: "daily", minutes: 0, at: "07:30" }, false), { kind: "daily", at: "07:30" });
  assert.deepEqual(cadenceSchedule({ kind: "daily", minutes: 0, at: "7:30" }, false), { error: "Give a time like 23:07." });
});

test("check-in detail: the last run's open steps and what it flagged read as plain sentences with no step ids", () => {
  const run = record({ at: 10, classes: { live: 5, foryou: 7, waiting: 5, due: 0, "stale-chase": 0, orphan: 1 }, job: { id: "s1", name: "check-in 14:00" },
    flagged: [{ kind: "orphan_steps", excerpt: "x", item: "p56" }, { kind: "job_end_unrecorded", excerpt: "y", item: "p56" }, { kind: "due_late", excerpt: "z", item: "p18" }] });
  assert.equal(classesLabel(run), "5 steps in progress, 7 steps waiting on you, 5 steps waiting until a set time and 1 step with no job.");
  assert.equal(classesLabel(record({ classes: { live: 41, "stale-chase": 1 } })), "41 steps in progress and 1 step gone quiet.");
  assert.equal(classesLabel(undefined), "");
  assert.equal(flaggedLabel(view([run])), "1 step with no job, 1 step not updated after its job ended and 1 step past due.");
  const skipped = record({ at: 20, verdict: "skipped", summary: "skipped: previous run still working" });
  assert.equal(flaggedLabel(view([skipped, run])), flaggedLabel(view([run])), "a skipped run measures nothing new");
  assert.equal(flaggedLabel(view([record({ at: 30 })])), "");
  const stalled = record({ flagged: [{ kind: "stalled_steps", excerpt: "a", item: "p254" }, { kind: "stalled_steps", excerpt: "b", item: "p255" }, { kind: "stalled_steps", excerpt: "c", item: "p255" },
    { kind: "stalled_steps", excerpt: "d", item: "p9" }, { kind: "no_progress", excerpt: "e" }, { kind: "brand_new_kind", excerpt: "f", item: "p1" }] });
  const words = flaggedLabel(view([stalled]));
  assert.equal(words, "3 steps stalled, no progress in the last hour and 1 brand new kind.", "one count per step, never its id");
  assert.doesNotMatch(words + classesLabel(run), /\bp\d+\b|_|·/);
});
