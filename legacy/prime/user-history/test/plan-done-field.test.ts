// Guards the AI harness VP chat's board up to 11-04: 217 plan_update ops carried a `done` text, which the parser dropped while it applied the
// rest, so p717 closed at 04:11Z on 11-04 with its quiet_agent_gb reading lost.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardError, parseBoardOps, PLAN_DONE_FIELD } from "../src/shared/chat-board.ts";

test("a plan op with a done field is refused whole, so its evidence is never dropped while the step closes", () => {
  const evidence = "quiet_agent_gb read 1.67 GB against 5 GB at 11:27 KST 11-04.";
  for (const op of [{ op: "plan_update", id: "p717", status: "done", done: evidence }, { op: "plan_add", text: "Keep quiet agents small", done: evidence }])
    assert.throws(() => parseBoardOps([op]), (error: unknown) => error instanceof BoardError && error.message === PLAN_DONE_FIELD);
  assert.deepEqual(parseBoardOps([{ op: "plan_update", id: "p717", status: "done", note: evidence }]), [{ op: "plan_update", id: "p717", status: "done", note: evidence }]);
  assert.deepEqual(parseBoardOps([{ op: "todo_update", id: "t3", done: true }]), [{ op: "todo_update", id: "t3", done: true }]);
});
