import assert from "node:assert/strict";
import { test } from "node:test";
import { cadenceDraft, cadenceSchedule, classesLabel, flaggedLabel } from "../src/client/duty-cadence.ts";
import { CHECK_IN_DUTY, type DutyRunRecord, type DutyView } from "../src/shared/chat-duties.ts";

const record = (changes: Partial<DutyRunRecord>): DutyRunRecord => ({ duty: "checkin", at: 1, trigger: "schedule", ms: 0, verdict: "missed", metrics: {}, summary: "", told: true, ...changes });
const view = (runs: DutyRunRecord[]): DutyView => ({ duty: { ...CHECK_IN_DUTY, status: "active" }, builtin: "checkin", schedule: { kind: "every", minutes: 15 }, paused: false,
  nextAt: null, running: false, runs });

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

test("check-in card: the last run's classes, what it flagged by step, and what the recheck after the chat's turn found handled or left", () => {
  const run = record({ at: 10, classes: { live: 5, foryou: 7, waiting: 5, due: 0, "stale-chase": 0, orphan: 1 },
    flagged: [{ kind: "orphan_steps", excerpt: "x", item: "p56" }, { kind: "job_end_unrecorded", excerpt: "y", item: "p56" }, { kind: "due_late", excerpt: "z", item: "p18" }] });
  assert.equal(classesLabel(run), "live 5 · foryou 7 · waiting 5 · orphan 1");
  assert.equal(classesLabel(undefined), "");
  assert.deepEqual(flaggedLabel(view([run])), { flagged: "p56 orphan steps, p56 job end unrecorded, p18 due late", handled: "", left: "" });
  const after = record({ at: 20, trigger: "after-turn", handled: ["p18"], unresolved: [{ kind: "orphan_steps", excerpt: "x", item: "p56" }] });
  assert.deepEqual(flaggedLabel(view([after, run])), { flagged: "p56 orphan steps, p56 job end unrecorded, p18 due late", handled: "p18", left: "p56 orphan steps" });
  assert.deepEqual(flaggedLabel(view([record({ at: 30 }), after, run])), { flagged: "", handled: "", left: "" }, "a newer run replaces the recheck of an older one");
});
