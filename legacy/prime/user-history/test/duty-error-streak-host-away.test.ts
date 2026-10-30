import { test } from "node:test";
import assert from "node:assert/strict";
import { errorStreak } from "../src/shared/chat-duties.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const run = (verdict: DutyRunRecord["verdict"], hostAway?: string) =>
  ({ duty: "d6", at: 0, slot: 0, trigger: "schedule", ms: 1, verdict, metrics: {}, summary: "", ...hostAway ? { hostAway } : {} }) as DutyRunRecord;

test("a host_away run neither counts toward the error streak nor ends it", () => {
  assert.equal(errorStreak([run("error"), run("error", "mac"), run("error", "mac"), run("error"), run("met")]), 2);
});

test("a streak of host_away runs alone is no precheck failure", () => {
  assert.equal(errorStreak([run("error", "mac"), run("error", "mac"), run("met")]), 0);
});

test("a measured run ends the streak", () => {
  assert.equal(errorStreak([run("error"), run("missed"), run("error")]), 1);
});
