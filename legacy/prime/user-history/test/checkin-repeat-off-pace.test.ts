// Crawler VP check-in 10-21 12:38 KST: Flagged again listed p828, p826, p681 and p146 as goals_off_pace for 6 check-ins in a row and asked for a
// board op on each, while each had a live owner job and the goal section said it was pushed with no new reading, so send nothing. check-ins.md
// item 11 does not judge goals_off_pace, so Flagged again leaves it out and each goal stays a line in the goal section.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses, type CheckInMemory } from "../src/chat-checkin.ts";
import { flagStreaks } from "../src/checkin-repeats.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const start = Date.parse("2026-10-21T00:38:00Z");
const goal = (id: string, metric: string, current: number, target: number, unit: string, job?: string): PlanItem => ({ id, text: metric, status: "doing",
  target: { metric, target, unit, current, measuredAt: "2026-10-21T00:00:00Z", source: "a probe", cadence: "daily" },
  children: [{ id: `${id}s`, text: `Push ${metric}`, status: "doing", note: "Done when the target is met.", duty: "checkin/goal_gaps", ...job ? { job } : {}, children: [] }] });
const plan = [
  goal("p828", "Instagram creators with 1,000+ followers indexed", 22_240_127, 200_000_000, "creators", "census seed order"),
  goal("p826", "Instagram profiles a minute on prod", 4_224, 10_000, "profiles/min", "census canary"),
  goal("p681", "US TikTok Shop products read this week", 55.4, 100, "%", "tiktok shop products"),
  goal("p146", "Documented API routes that work on prod", 97.4, 100, "%", "crawler prod read-backs"),
  goal("p868", "crawler risks firing", 2, 0, "risks"),
];
plan[4]!.target!.direction = "down";
const board = { v: 2, rev: 1, updatedAt: "2026-10-21T00:00:00Z", plan, todos: [] } as unknown as ChatBoard;
const live = (name: string, at: number): JobFact => ({ key: `sub-${name}`, name, state: "working", activityAt: at - 60_000 });

/** Six check-ins 30 minutes apart over the same board, each carrying the last one's memory and streaks, as chats.ts does. */
function sixRuns() {
  let memory: CheckInMemory | undefined;
  let streaks: Record<string, number> | undefined;
  let text = "";
  for (let run = 0; run < 6; run++) {
    const now = start + run * 30 * 60_000;
    const facts = ["census seed order", "census canary", "tiktok shop products", "crawler prod read-backs"].map(name => live(name, now));
    const precheck = checkInPrecheck(memory, facts, board, now);
    const { flagged } = convergenceMisses("chat", precheck.steps, precheck, {}, 30 * 60_000, now);
    streaks = flagStreaks(streaks, flagged);
    text = checkInPrecheckText(precheck, facts, flagged, now, streaks);
    memory = precheck.memory;
  }
  return { text, streaks: streaks! };
}

test("Flagged again leaves out the four off-pace goals with a live owner and keeps each in the goal section", () => {
  const { text, streaks } = sixRuns();
  for (const id of ["p828", "p826", "p681", "p146"]) {
    assert.equal(streaks[`goals_off_pace ${id}`], 6, `${id} is still counted each run`);
    assert.match(text, new RegExp(`### Goals[^#]*- ${id} `), `${id} keeps its line in the goal section`);
  }
  const again = text.split("### ").find(part => part.startsWith("Flagged again")) ?? "";
  assert.doesNotMatch(again, /goals_off_pace/);
});

test("a goal no live job works on still heads Flagged again", () => {
  const { text } = sixRuns();
  const again = text.split("### ").find(part => part.startsWith("Flagged again")) ?? "";
  assert.match(again, /goal_gaps: p868 .*\(flagged in 6 check-ins in a row\)/);
});
