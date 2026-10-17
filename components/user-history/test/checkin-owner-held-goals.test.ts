import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInRecord, convergenceMisses } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * frontend bro, 10-16 to 10-18. p106 "Connections parts the owner accepts" read 0 of 5 and p118 "Email parts the owner accepts" 0 of 3. Every
 * part was built and walked on Staging, and the only open steps under them were the owner's review asks on For you t28 and t25 plus the push
 * steps. goal_gaps counted both in 14 check-ins in a row, and each read "first reading, no trend yet", because check-ins.json dropped the goal
 * memos whenever another chat's check-in wrote the file.
 */
const NOW = Date.parse("2026-10-17T22:15:00Z");
const MIN = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const connections = (children: PlanItem[]): PlanItem => step("p106", "Connections: multiple accounts per channel, clearer sections", "doing", {
  target: { metric: "Connections parts the owner accepts", target: 5, unit: "parts", current: 0, measuredAt: iso(NOW - 30 * MIN), source: "t28 asks one answer per part" },
  children: [step("p113", "The six Connections parts on Staging", "done"), ...children] });
const review = step("p115", "You look at the new Connections on Staging and say good or what to change", "blocked", { waitFor: "t28" });
const push = step("p182", "Connections parts reach the owner: walk the 5 parts on Staging and ask him", "doing", { job: "connections review push", duty: "checkin/goal_gaps" });
const boardOf = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: iso(NOW - 60 * MIN), plan,
  todos: [{ id: "t28", text: "Look at three screens and say good or what to change. Connections, one answer per part", from: "agent", done: false, step: "p115", at: iso(NOW - 3 * 24 * 60 * MIN) }] });
const pushJob: JobFact = { key: "k1", name: "connections review push", state: "working", activityAt: NOW };

test("a goal whose only open steps wait on the owner's For you answer is no goal gap, with or without a live push job", () => {
  for (const jobs of [[pushJob], []]) {
    const precheck = checkInPrecheck(undefined, jobs, boardOf([connections([review, push])]), NOW, { everyMs: 120 * MIN });
    const [p106] = precheck.goals;
    assert.equal(p106!.act, "owner", jobs.length ? "the live push job cannot move a number only the owner moves" : "no job needs to start");
    assert.deepEqual(p106!.asks, ["p115"]);
    const output = convergenceMisses("c1", precheck.steps, precheck, {}, 120 * MIN, NOW);
    assert.equal(output.metrics.goal_gaps, 0);
  }
});

test("a goal with open work besides the owner's ask stays a goal gap until its number moves", () => {
  const work = step("p190", "Fix the Instagram split on Staging", "doing", { job: "instagram split fix" });
  const precheck = checkInPrecheck(undefined, [pushJob], boardOf([connections([review, push, work])]), NOW, { everyMs: 120 * MIN });
  assert.equal(precheck.goals[0]!.act, "steer");
  assert.equal(convergenceMisses("c1", precheck.steps, precheck, {}, 120 * MIN, NOW).metrics.goal_gaps, 1);
});

test("check-ins.json keeps each chat's goal and job memos when another chat's memory is written", async () => {
  const record = checkInRecord(join(await mkdtemp(join(tmpdir(), "checkin-memory-")), "check-ins.json"));
  const goals = { p106: { readings: [{ value: 0, at: NOW - 30 * MIN }], still: 2 } };
  const jobs = { k1: { mark: NOW - 10 * MIN, since: NOW - 10 * MIN, pushed: NOW - 5 * MIN } };
  await record.set("frontend", { at: NOW, steps: {}, goals, jobs });
  await record.set("other", { at: NOW + MIN, steps: {} });
  const kept = await record.get("frontend");
  assert.deepEqual(kept?.goals, goals);
  assert.deepEqual(kept?.jobs, jobs);
});
