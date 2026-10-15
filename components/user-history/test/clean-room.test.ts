import assert from "node:assert/strict";
import { test } from "node:test";
import { checkinGoalPush, FIXTURE, flagHits, names, reportShape, stepIdLists } from "../scripts/clean-room/checkin-goal-push.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const board: ChatBoard = {
  v: 2, rev: 7, updatedAt: "2026-10-15T22:00:00.000Z", todos: [],
  plan: [
    { id: "p71", text: "Complete index of Instagram, Meta Ads and TikTok Shop (owner 10-09)", status: "doing", target: { metric: "Instagram Tier A indexed", target: 100, unit: "%", current: 14.9 },
      children: [{ id: "p23", text: "Speed Instagram census up", status: "doing", job: "census canary run", sessionId: "01a12faa-591f-751e-b070-756c5697072e", children: [] }] },
    { id: "p28", text: "Whole pipeline scaled", status: "done", target: { metric: "Prod Instagram profiles read ok per second, 24 h", target: 99, unit: "reads/s", current: 17.95 }, children: [] },
    { id: "p146", text: "Crawler ops", status: "doing", children: [{ id: "p157", text: "Land the limits chain", status: "blocked", children: [] }] },
  ],
} as unknown as ChatBoard;

test("the twin board points every owner at the fixture, reopens p28 with a push step, and leaves ownerless steps alone", () => {
  const { board: twin, changes } = checkinGoalPush.board!(board, { fixtures: { [FIXTURE]: "fixture-session" }, sandbox: "/tmp/sandbox" });
  const p23 = twin.plan[0]!.children[0]!;
  assert.equal(p23.job, FIXTURE);
  assert.equal(p23.sessionId, "fixture-session");
  const p28 = twin.plan[1]!;
  assert.equal(p28.status, "doing");
  assert.deepEqual(p28.children.map(step => [step.id, step.duty, step.job]), [["p158", "checkin/goal_gaps", FIXTURE]]);
  assert.equal(twin.plan[2]!.children[0]!.job, undefined);
  assert.match(twin.plan[0]!.note ?? "", /^Clean-room twin of Crawler VP's board/);
  assert.equal(board.plan[0]!.children[0]!.job, "census canary run", "the copy itself is not changed");
  assert.match(changes[0]!, /census canary run on 1/);
});

test("flag kinds count outside a duty link, and four step ids in one paragraph make a list", () => {
  assert.deepEqual(flagHits("set duty checkin/goal_gaps on the step"), []);
  assert.deepEqual(flagHits("- loose_goals: p542 has no steps"), ["loose_goals"]);
  assert.deepEqual(stepIdLists("p71 is at 14.9 of 100%.\n\np157, p380 and p401 are stuck."), []);
  assert.deepEqual(stepIdLists("- p157 now lands\n- p380 folds into p504\n- p551 folds into p313"), [["p157", "p380", "p504", "p551", "p313"]]);
});

test("a number counts only as a whole token", () => {
  assert.ok(names("Tier A indexed 14.9 of 100%", "14.9"));
  assert.ok(!names("114.9 rows", "14.9"));
  assert.ok(!names("14.95 rows", "14.9"));
  assert.ok(names("gap 81 reads/s", "81"));
  assert.ok(!names("gap 81.05 reads/s", "81"));
});

test("the 06:20 report shape fails and a three-line report with its detail path passes", () => {
  const before = "Stuck steps went from 3 to 1 in the 06:20 check-in.\n\nBoard changes:\n- p157 is now land.\n- p380 is folded.\n- p542 has a Plan step.\n\nDetail: /Users/x/checkin.flagged.md";
  assert.deepEqual(reportShape(before), { lines: 5, ok: false, namesGoal: false });
  const after = "p71 is at 14.9 of 100%, off pace; I started p71 push on its biggest blocker.\np28 is at 17.95 of 99 reads/s; I steered its owner.\nStuck steps 1.\n/Users/x/checkin.flagged.md";
  assert.deepEqual(reportShape(after), { lines: 3, ok: true, namesGoal: true });
});
