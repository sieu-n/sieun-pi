import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyDutyOps } from "../scripts/board-apply.ts";
import { finishedOpen, looksDone } from "../src/checkin-done.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { applyBoardOp, emptyBoard, nextIds } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

/*
 * 10-15 on the Crawler VP's board: p314 closed at 09:17Z, then the chat moved the new alert step p361 under it at 10:12Z, which reopened p314.
 * The job closed p361 at 11:04Z and p314 stayed todo with its close evidence in the note until the 12:30Z check-in closed it; p202 did the
 * same with p378 (closed 11:04Z, reopened 11:23Z). Four check-ins counted p314 in finished_open.
 */
const T = "2026-10-15T09:17:13.000Z";
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const NOTE = "09:16Z on staging: both staging watch-targets-overdue alerts are off Grafana's firing list, and staging Prometheus reads 0 for every monitor kind.";
const step = (id: string, status: PlanItem["status"], children: PlanItem[] = [], extra: Partial<PlanItem> = {}): PlanItem =>
  ({ id, text: `Alert step ${id}`, status, children, ...extra });
const board = (): ChatBoard => ({ ...emptyBoard(T), plan: [step("p189", "doing", [
  step("p314", "done", [step("p317", "done"), step("p318", "done")], { note: NOTE, job: "alert land follow through" }),
  step("p361", "doing", [], { job: "alert follow through" }),
  step("p200", "doing", [], { job: "crawler ops train" }),
])] });
function run(start: ChatBoard, ops: BoardOp[]): { board: ChatBoard; summaries: string[] } {
  let current = start;
  const summaries: string[] = [];
  for (const op of ops) { const next = applyBoardOp(current, op, "agent", T, nextIds(current)); current = next.board; summaries.push(next.summary); }
  return { board: current, summaries };
}
const status = (plan: readonly PlanItem[], id: string): string | undefined => {
  for (const item of plan) { if (item.id === id) return item.status; const below = status(item.children, id); if (below) return below; }
  return undefined;
};

test("a done step the board reopened for a new step is done again when that step closes, so finished_open reads 0", () => {
  const moved = run(board(), [{ op: "plan_update", id: "p361", parent: "p314" }]);
  assert.match(moved.summaries[0]!, /moved it under p314, reopened p314$/);
  assert.equal(status(moved.board.plan, "p314"), "todo");
  const closed = run(moved.board, [{ op: "plan_update", id: "p361", status: "done", note: "The monitor tier reads 0 overdue." }]);
  assert.equal(status(closed.board.plan, "p314"), "done");
  assert.match(closed.summaries[0]!, /marked it done, updated its note, closed p314 again now that no open step is left under it$/);
  assert.deepEqual(finishedOpen(closed.board, Date.parse(T)), []);
});

test("a reopened step the agent sets a status on, or gives a wait, stays open when its new step closes", () => {
  const moved = run(board(), [{ op: "plan_update", id: "p361", parent: "p314" }]).board;
  assert.equal(status(run(moved, [{ op: "plan_update", id: "p314", status: "doing" }, { op: "plan_update", id: "p361", status: "done" }]).board.plan, "p314"), "doing");
  assert.equal(status(run(moved, [{ op: "plan_update", id: "p314", waitFor: "land 38 reaches prod" }, { op: "plan_update", id: "p361", status: "dropped" }]).board.plan, "p314"), "todo");
});

test("a duty job's board-apply closes the last new step and the board closes the reopened step with it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "reclose-"));
  await mkdir(join(dataDir, "boards"), { recursive: true });
  const moved = run(board(), [{ op: "plan_update", id: "p361", parent: "p314" }]).board;
  await writeFile(join(dataDir, "boards", `${CHAT}.json`), JSON.stringify({ ...moved, plan: moved.plan.map(goal => ({ ...goal, children: goal.children.map(item =>
    item.id === "p314" ? { ...item, note: `${NOTE} The resume fix 6eba057792 still rides land 38 with the train.` } : item) })) }));
  const out = await applyDutyOps(dataDir, CHAT, [{ op: "plan_update", id: "p361", status: "done", note: "Staging reads 0 overdue on a8f85b4206, land run 38646579034 green." }]);
  assert.match(out, /closed p314 again/);
  assert.equal(status((await new BoardStore(dataDir).read(CHAT))!.plan, "p314"), "done");
});

test("a count before a ship word counts other things that shipped, so the step does not look done (Crawler VP 10-15, p504 to p506)", () => {
  const note = "Cause found and fixed in code: nothing refused a commit that adds an unbacked limit, so 738 landed in a day. Object b99156d373 makes " +
    "commit.mjs refuse them (sent to the chat for a probe slot).";
  assert.equal(looksDone({ status: "doing", note, children: [] }), null);
  assert.equal(looksDone({ status: "doing", note: "Land 36 landed as staging a8f85b4206.", children: [] }), 'its note says "landed"');
  assert.equal(looksDone({ status: "doing", note: "PR #187 merged.", children: [] }), 'its note says "merged"');
});
