import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, classLine } from "../src/chat-checkin.ts";
import { applyBoardOp, BoardError, emptyBoard, nextIds, parseBoardOps } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "../src/shared/types.ts";

/**
 * c47 reopened 10-12 (owner: "stop making up these bullshit rules on waiting", then "NEVER wait for something"). On Crawler VP's board p42, p46
 * and p47 waited for "Fable's 32b-on-staging announcement (about 14:15Z)"; each check-in told the chat to "act on it or set a new waitUntil",
 * and the chat moved the waitUntil later 2 to 3 times, so the steps sat through 12 to 17 check-ins with no action.
 */
const T0 = "2026-10-12T11:00:00.000Z";
const T1 = "2026-10-12T13:12:02.049Z";
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, T1, nextIds(board)).board;
  return board;
}
const stepOf = (board: ChatBoard, id: string) => board.plan.flatMap(goal => [goal, ...goal.children]).find(item => item.id === id)!;
/** p2 has p42's 11:08Z state: it waits for land 32b on staging until 13:30Z. */
function crawler(): ChatBoard {
  return run(emptyBoard(T0), [
    { op: "plan_add", text: "B2 storage costs and metrics" },
    { op: "plan_add", parent: "p1", text: "Add B2 storage metrics, panels and a growth alert", status: "doing",
      waitFor: "land 32b on staging, then the combined PROBE B push with B2 layer 95eb44e6eb", waitUntil: "2026-10-12T13:30:00.000Z" },
  ]);
}
const PUSH = { op: "plan_update", id: "p2", waitFor: "Fable's 32b-on-staging announcement (about 14:15Z), then lab compose additions pushes the combined PROBE B",
  waitUntil: "2026-10-12T14:30:00.000Z" };

test("c47: the agent cannot move a step's waitUntil later, even with new waitFor words; the refusal says what to do instead", () => {
  assert.throws(() => run(crawler(), [PUSH]), error => error instanceof BoardError && error.kind === "forbidden" &&
    /p2 .* already waits until 2026-10-12T13:30:00\.000Z/.test(error.message) && /\(c47\)/.test(error.message) &&
    /check whether what it waits for already happened/.test(error.message) && /For you todo with step "p2"/.test(error.message));
  assert.throws(() => run(crawler(), [{ op: "plan_set", items: [{ id: "p1", text: "B2 storage costs and metrics", children: [
    { id: "p2", text: "Add B2 storage metrics", status: "doing", waitUntil: "2026-10-12T15:00:00Z" }] }] }]),
  error => error instanceof BoardError && /already waits until/.test(error.message), "plan_set cannot move it later either");
});

test("c47: an earlier waitUntil, a cleared wait, a first wait and a wait the owner holds on a For you todo still apply", () => {
  assert.equal(stepOf(run(crawler(), [{ ...PUSH, waitUntil: "2026-10-12T13:15:00Z" }]), "p2").waitUntil, "2026-10-12T13:15:00.000Z");
  const cleared = run(crawler(), [{ op: "plan_update", id: "p2", waitUntil: null, status: "blocked", note: "Land 32b failed on the signed-in e2e test; ci unblock now fixes it." }]);
  assert.equal(stepOf(cleared, "p2").waitUntil, undefined);
  const first = run(emptyBoard(T0), [{ op: "plan_add", text: "Goal" }, { op: "plan_add", parent: "p1", text: "Read the nightly count", waitUntil: "2026-10-13T01:00:00Z" }]);
  assert.equal(stepOf(first, "p2").waitUntil, "2026-10-13T01:00:00.000Z");
  const asked = run(crawler(), [{ op: "todo_add", text: "Rotate the B2 key for p2 now?", choices: ["Rotate it", "Not yet"], step: "p2" }]);
  assert.equal(stepOf(run(asked, [PUSH]), "p2").waitUntil, "2026-10-12T14:30:00.000Z", "the owner holds the step on t1");
});

test("c47: the check-in tells the chat to act on a due or stalled step, never to set a new waitUntil", async () => {
  const board = crawler();
  const start = Date.parse(T1);
  const first = checkInPrecheck(undefined, [], board, start, { self: ["c-self"] });
  const at = Date.parse("2026-10-12T14:00:00Z");
  const due = checkInPrecheck(first.memory, [], board, at, { self: ["c-self"] });
  const line = classLine(due.steps.find(view => view.item.id === "p2")!, at)!;
  assert.match(line, /is due since .*: act on it now/);
  assert.doesNotMatch(line, /new waitUntil/);
  const text = checkInPrecheckText(due, [], [], at);
  assert.doesNotMatch(text, /new waitUntil|slot forward/);
  const skill = await readFile(new URL("../../../skills/board/SKILL.md", import.meta.url), "utf8");
  assert.doesNotMatch(skill, /give it a new waitUntil/);
  assert.match(skill, /the board refuses a later waitUntil \(c47\)/);
});
