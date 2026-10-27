// chat-2572 10-28: its 10-27 20:50Z check-in steered the job "mcp connection behavior" with "Owner's words for p34 "Explain normal and
// Insight connections" (verbatim): > Explain normal and Insight connections", a title the chat wrote. The owner had asked "client 입장에선 똑같이
// 뜨는데..? 둘다 따로 연결 가능한거야?" (message mvr3yiiy), and the steer also carried the metric name of the precheck, which the chat had renamed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalDueLine, goalPushes } from "../src/checkin-goals.ts";
import type { JobFact, StepView } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-27T20:50:19Z");
const asked = Date.parse("2026-10-27T19:58:18.442Z");
const ownerSaid = [{ text: "client 입장에선 똑같이 뜨는데..? \n둘다 따로 연결 가능한거야?", at: asked }];
const p35: PlanItem = { id: "p35", text: "Verify connection sharing and separation", status: "doing", job: "mcp connection behavior", children: [] };
const target = { metric: "Verified MCP connection answer delivered", target: 1, unit: "answer", current: 0, measuredAt: "2026-10-27T20:45:00Z", source: "check-in", direction: "up" as const };
const goal = (extra: Partial<PlanItem>): PlanItem => ({ id: "p34", text: "Explain normal and Insight connections", status: "doing", children: [p35], target, ...extra });
const job: JobFact = { key: "sub-mcp", name: "mcp connection behavior", state: "working" };
const views = (p34: PlanItem): StepView[] => [{ item: p35, owner: job, mine: false, changedAt: now - 600_000, cls: "doing", openTodos: [], goal: { id: "p34", text: p34.text } } as unknown as StepView];
const memo = { p34: { readings: [{ value: 0, at: now - 7_200_000 }, { value: 0, at: now - 3_600_000 }], still: 2 } };
const due = (p34: PlanItem): string => {
  const board = { v: 2, rev: 1, updatedAt: "2026-10-27T20:45:00Z", plan: [p34], todos: [] } as unknown as ChatBoard;
  const [push] = goalPushes(board, views(p34), memo as never, 2 * 3_600_000, now, undefined, undefined, undefined, undefined, undefined, ownerSaid).pushes;
  assert.equal(push?.act, "steer");
  return goalDueLine(push!) ?? "";
};

test("a goal with no requirement lines quotes no owner words and labels its title as the goal", () => {
  const line = due(goal({}));
  assert.match(line, /Goal p34: "Explain normal and Insight connections"/);
  assert.match(line, /Owner's words: none on the board for this goal/);
  assert.doesNotMatch(line, /\(verbatim/);
  assert.doesNotMatch(line, /> Explain normal and Insight connections/);
});

test("a requirement line the owner wrote is quoted with his message id; a line he never wrote is the chat's", () => {
  const line = due(goal({ requirements: [
    { text: "둘다 따로 연결 가능한거야?", status: "open" },
    { text: "Explain how normal and Insight connections differ", status: "open" },
  ] }));
  assert.match(line, /Owner's words \(verbatim, message mvr3yiiy, 10-27 19:58Z\):\n\n\s*> 둘다 따로 연결 가능한거야\?/);
  assert.match(line, /Requirements in the chat's words, not the owner's:\n\s*- Explain how normal and Insight connections differ/);
  assert.doesNotMatch(line, /> Explain how normal/);
});

test("the steer asks the check-in to read the goal's live title and metric right before it sends", () => {
  assert.match(due(goal({})), /Read board\.get\("p34"\) right before you send it, and send the goal's live title and target metric/);
});
