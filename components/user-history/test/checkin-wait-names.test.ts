import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

/*
 * VP of CI 10-14: p135 waited for the waitFor below, and four check-ins up to 01:29 KST said its wait was over because todo t9 is answered.
 * "queue cuts t9" is the push name of the queue cuts job, and run 38414179195 was still queued. Step and todos from VP of CI's board, trimmed.
 */
const p135Wait = "run 38414179195 (queue cuts t9 on f0a8ed462f) green; then the release owner CASes its 4 shas (gate files)";
const answered = (id: string): OwnerTodo => ({ id, text: `Todo ${id}`, done: true, reply: "Go", answeredBy: "owner", from: "agent", at: "" }) as OwnerTodo;
const vpOfCi = (waitFor: string): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: ["t9", "t10", "t17", "t18"].map(answered), plan: [{
  id: "p135", status: "doing", children: [], job: "ci queue demand", waitFor,
  text: "Cut queue demand: 124 runs (about 25 h of heavy runner time) were queued at 17:56Z against 2 heavy runners",
}] satisfies PlanItem[] });
const met = (board: ChatBoard): string[] =>
  checkInPrecheck(undefined, [], board, Date.parse("2026-10-13T16:29:00Z"), { self: ["chat"] }).waitsMet.map(({ view }) => view.item.id);

test("c45: a t9 after a name word or inside a ref is a push name, not todo t9 (VP of CI 10-14: p135 and queue cuts t9)", () => {
  assert.deepEqual(met(vpOfCi(p135Wait)), [], "run 38414179195 is still queued; queue cuts t9 is a push name");
  for (const wait of ["queue cuts t9 on f0a8ed462f merged to staging", "ci/queue-cuts-t9 on staging", "the queue-cuts-t9 push"])
    assert.deepEqual(met(vpOfCi(wait)), [], `${wait}: t9 is a push name`);
});

test("c45: a clause that names a CI run id going green stays open whatever ids it names (VP of CI 10-14: p135)", () => {
  assert.deepEqual(met(vpOfCi("run 38414179195 green after todo t9")), [], "todo t9 is answered, but the run is not on the board");
  assert.deepEqual(met(vpOfCi("t17 answered, run 38414179195 green for t18")), []);
});

test("c45: a todo id standalone or after a small word still resolves (VP of CI 10-14: p135 controls)", () => {
  for (const wait of ["waits on t18 (For you)", "t17 answered", "todo t9", "For you t9", "the owner's answer on t18"])
    assert.deepEqual(met(vpOfCi(wait)), ["p135"], wait);
});

/*
 * Crawler VP 10-16: p535 waited for "land-39 p3 20880ecc10 green, plus metal's timing of the 80M-row cleanup", and the check-in said the wait
 * was over because goal p3 on its board is done. "land-39 p3" is part 3 of land 39. Trimmed from the Crawler VP board.
 */
const crawler = (waitFor: string): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [
  { id: "p3", status: "done", children: [], text: "Old goal" },
  { id: "p535", status: "doing", children: [], waitFor, text: "Census runs without IO pauses: cheaper census writes and gentler database cleanup" },
] satisfies PlanItem[] });

test("c45: a step id after a hyphenated land name is that land's part, not this board's step (Crawler VP 10-16: p535 and land-39 p3)", () => {
  assert.deepEqual(met(crawler("land-39 p3 20880ecc10 green, plus metal's timing of the 80M-row cleanup")), []);
  assert.deepEqual(met(crawler("train-8 p3 on staging")), []);
  assert.deepEqual(met(crawler("p3 is done")), ["p535"], "a standalone p3 still names the step");
});
