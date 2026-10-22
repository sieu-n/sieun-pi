// AI harness chat 10-19: goal "Every duty in every chat is green" sat open at 102 of 109, and the owner said "ALL PLANS SHOULD BE EPHEMERAL" (msg mvfb7zt0).
import assert from "node:assert/strict";
import { test } from "node:test";
import { planRiskSteps } from "../src/checkin-findings.ts";
import { checkInPrompt } from "../src/chat-checkin.ts";
import type { GoalPush } from "../src/checkin-goals.ts";
import { applyBoardOp } from "../src/shared/chat-board.ts";
import { upkeepWords } from "../src/shared/upkeep-title.ts";
import type { ChatBoard } from "../src/shared/types.ts";

test("upkeep titles read as upkeep and task titles do not", () => {
  for (const title of ["Every duty in every chat is green, and the duty system keeps pushing fixes until it is", "Every minute on us-metal02 reads clean",
    "Keep this Mac usable: load under 20", "The dev branch's own test run goes green and stays green", "Rank our 10 biggest Rumble index gaps on a wiki page and keep it current"]) {
    assert.ok(upkeepWords(title), title);
  }
  for (const title of ["Fix the broken wiki search", "Fix: the alert service stops reading Grafana while the chat service stays up",
    "Make stopped jobs give their steps back, so the check-in's stuck count stays 0", "Keep-active limit cut to 30 minutes", "Census Postgres writer keeps up with 200+ reads a second"]) {
    assert.equal(upkeepWords(title), null, title);
  }
});

const board = { v: 2, rev: 1, updatedAt: "2026-10-19T13:40:00Z", todos: [], plan: [
  { id: "p453", text: "Every duty in every chat is green, and the duty system keeps pushing fixes until it is", status: "doing", note: "Done when 109 of 109", children: [
    { id: "p454", text: "Fix the cache read share metric", status: "doing", children: [] }] },
] } as unknown as ChatBoard;

test("plan_add saves an upkeep goal and flags it", () => {
  const { board: next, summary } = applyBoardOp(board, { op: "plan_add", text: "Keep the crawler working" }, "agent", "2026-10-19T14:00:00Z", () => "p999");
  assert.equal(next.plan.length, 2);
  assert.match(summary, /reads like upkeep/);
  assert.doesNotMatch(applyBoardOp(board, { op: "plan_add", text: "Fix the crawler login" }, "agent", "2026-10-19T14:00:00Z", () => "p999").summary, /upkeep/);
});

test("the check-in asks to make an open upkeep goal a duty metric, and a met goal's metric too", () => {
  const risks = planRiskSteps(board);
  assert.deepEqual(risks.map(item => item.id), ["p453"]);
  assert.match(checkInPrompt({ goals: [], end: [], risks }, null), /p453 .* reads like upkeep.*duty metric/);
  const met = { goal: board.plan[0]!, stale: false, act: "on_pace", words: [], trend: { kind: "met" } } as unknown as GoalPush;
  assert.match(checkInPrompt({ goals: [met], end: [], risks: [] }, null), /meets its target\. Close it now.*a duty keeps the metric/);
});
