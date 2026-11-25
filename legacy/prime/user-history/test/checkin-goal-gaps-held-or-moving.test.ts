// sep launch!! on 11-25 at 17:40Z: goal p2 (176 of 181 steps) had p199, p218, p223 and p224 waiting on the owner's For you t93, t91, t95 and
// t96, and p225 on the designer bro thread of another chat, which worked on it. The end state read 5 of 5 open steps moving or held, while
// goal_gaps read p2 "no live job owns it" in 3 check-ins in a row and asked for a push job whose only possible move was to nag the owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { goalGap, goalLine, type GoalPush, pushNeeded } from "../src/checkin-goals.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const NOW = Date.parse("2026-11-25T17:40:44Z");
const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const DESIGNER = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const blocked = (id: string, text: string, todo: string): PlanItem =>
  ({ id, text, status: "blocked", waitFor: `The owner's answer on ${todo}`, waitForAt: "2026-11-24T05:05:36.624Z", children: [] }) as PlanItem;
const todo = (id: string, done = false): OwnerTodo => ({ id, text: `Answer ${id}`, done, from: "agent", at: "2026-11-20T19:29:03.042Z" }) as OwnerTodo;
const board = (todos: OwnerTodo[] = ["t91", "t93", "t95", "t96"].map(id => todo(id))): ChatBoard => ({ v: 2, rev: 4856, updatedAt: "2026-11-25T17:40:00Z", todos, plan: [{
  id: "p2", text: "The 5180 app works for real on local and staging: every app, the DM extension and the daily brand pipeline", status: "doing", sessionId: CHAT,
  target: { metric: "steps done", target: 181, unit: "steps", current: 176, measuredAt: "2026-11-25T16:45:10.000Z", direction: "up", source: "board count" },
  children: [
    { id: "p3", text: "Every app has its Playwright spec", status: "done", children: [] },
    blocked("p199", "X DMs send for real customers", "t93"),
    blocked("p218", "The real app gets the new 5180 onboarding with sign-up last", "t91"),
    blocked("p223", "Scale workspaces can invite their 100 included seats", "t95"),
    blocked("p224", "TikTok DMs pass the staging check with a real test creator account", "t96"),
    { id: "p225", text: "5180 shows the product database move and every search fix since move 22", status: "doing", job: DESIGNER, sessionId: DESIGNER,
      waitFor: "designer bro's render-check job walking the 11 move-23 checks", waitForAt: "2026-11-25T17:40:30Z", children: [] }] }] } as unknown as ChatBoard);
const designer = (state: JobFact["state"]): JobFact => ({ key: `thread:${DESIGNER}`, sessionId: DESIGNER, name: "designer bro, works on 5180 only", state, chat: true,
  activityAt: NOW - 30_000 });
const still = { readings: [{ value: 176, at: Date.parse("2026-11-25T05:30:15Z") }, { value: 176, at: Date.parse("2026-11-25T16:45:10Z") }], still: 3 };
const p2 = (facts: JobFact[], b = board()): GoalPush =>
  checkInPrecheck({ at: NOW - 3_600_000, steps: {}, goals: { p2: still } } as never, facts, b, NOW, { jobs: [], self: [CHAT] } as never)
    .goals.find(push => push.goal.id === "p2")!;

test("a goal whose open steps all wait on the owner's For you todos or move with another chat's live thread is no goal_gap", () => {
  const push = p2([designer("working")]);
  assert.equal(push.act, "waiting", `p2 read ${push.act}: ${goalLine(push)}`);
  assert.equal(goalGap(push), false);
  assert.equal(pushNeeded(push), false);
  assert.match(push.waits ?? "", /p225 with a live owner, p199, p218, p223 and p224 on the owner in For you/);
});

test("the goal counts again once one open step has nobody moving it", () => {
  assert.equal(p2([designer("ended")]).act, "start", "the designer bro thread stopped and nothing carries p225");
  const answered = board(["t91", "t93", "t95"].map(id => todo(id)).concat(todo("t96", true)));
  assert.equal(p2([designer("working")], answered).act, "start", "t96 is answered, so p224 waits on nobody");
});
