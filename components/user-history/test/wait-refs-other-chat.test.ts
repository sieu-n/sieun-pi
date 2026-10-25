// CI and RepoOps 10-26: p420 waited for "the owner's answer on t17 in chat 01a16213-54c6-73fa-b399-20e2713c41ba (TypeSafe credits)", the owner's
// open top-up ask on that chat's board, and two check-ins flagged it as wait_met, because waitsMet read the chat's own t17, a key-lock todo
// answered on 10-09. Every check reads a wait's ids with `waitRefs`, so an id tied to another chat is read on that chat's board or not at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitsMet } from "../src/checkin-findings.ts";
import { stepView } from "../src/checkin-steps.ts";
import { heldByTodo, linkedBoards, linkedTodoRefs, waitRefs, withLinkedBoards } from "../src/shared/todo-hold.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const CI = "01a1180e-6567-747f-bf44-452520ebdd1b";
const TYPESAFE = "01a16213-54c6-73fa-b399-20e2713c41ba";
const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const now = Date.parse("2026-10-25T15:37:00Z");
const p420: PlanItem = { id: "p420", text: "Staging's hosted screening checks stop failing on a billing refusal", status: "blocked", children: [],
  job: "staging proof jev spend", waitFor: `the owner's answer on t17 in chat ${TYPESAFE} (TypeSafe credits)` };
const keyLock: OwnerTodo = { id: "t17", text: "Go ahead with the key-lock changes in the reviewed window?", done: true, from: "agent", at: "2026-10-09T20:03:18.053Z",
  reply: "unslop easy words please" };
const topUp = (done: boolean): OwnerTodo => ({ id: "t17", text: "Can you add credits or turn on auto-reload?", done, from: "agent", at: "2026-10-24T22:59:22.223Z" });
const board = (todos: OwnerTodo[], plan: PlanItem[] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-25T15:00:00Z", plan, todos }) as unknown as ChatBoard;
const ci = board([keyLock], [p420]);
const self = new Set([CI, "CI and RepoOps"]);
const met = (others: Map<string, ChatBoard | null>) =>
  waitsMet([stepView(p420, now - 3_600_000, self, [], [], [], now)], withLinkedBoards(ci, CI, others), [], self, others).map(({ view, over }) => [view.item.id, over]);

test("p420's wait on another chat's open t17 is not over, though this chat's own t17 is done", () => {
  assert.deepEqual(met(new Map([[TYPESAFE, board([topUp(false)])]])), []);
});

test("p420's wait is over once that chat's t17 is done, and not while its board cannot be read", () => {
  assert.deepEqual(met(new Map([[TYPESAFE, board([topUp(true)])]])), [["p420", [`t17 in chat ${TYPESAFE} is answered (read the answer: a hold is not a go)`]]]);
  assert.deepEqual(met(new Map([[TYPESAFE, null]])), []);
  assert.deepEqual(met(new Map()), []);
});

test("waitRefs ties each form of another chat's id to that chat, and leaves a plain id to this board", () => {
  const chats = [{ id: TYPESAFE, name: "TypeSafe credits" }, { id: SEP, name: "sep launch!! (Mac)" }, { id: "a", name: "ops guy" }, { id: "b", name: "ops guy" }];
  const read = (text: string) => waitRefs(text, chats);
  assert.deepEqual(read(`${SEP} t30 (owner brings the MacBook Pro online)`).refs, [{ id: "t30", chat: SEP }]);
  assert.deepEqual(read(`thread:${TYPESAFE} t11`).refs, [{ id: "t11", chat: TYPESAFE }]);
  assert.deepEqual(read(p420.waitFor!).refs, [{ id: "t17", chat: TYPESAFE }]);
  assert.deepEqual(read(`t11 on thread ${TYPESAFE}`).refs, [{ id: "t11", chat: TYPESAFE }]);
  assert.deepEqual(read("TypeSafe credits's t17 and t18").refs, [{ id: "t17", chat: TYPESAFE }, { id: "t18", chat: TYPESAFE }]);
  assert.deepEqual(read("sep launch!!'s For you t30").refs, [{ id: "t30", chat: SEP }]);
  assert.deepEqual(read("ops guy's p53").refs, [{ id: "p53", chat: null }]);
  assert.deepEqual(read("its t17").refs, [{ id: "t17", chat: null }]);
  assert.deepEqual(read("the owner's answer on t17"), { refs: [], rest: "the owner's answer on t17" });
});

test("d9's linked todos read the same forms, and this chat's own t17 holds no wait on another chat's t17", async () => {
  assert.deepEqual(linkedTodoRefs([p420]), [{ chat: TYPESAFE, id: "t17" }]);
  assert.deepEqual(linkedTodoRefs([{ ...p420, waitFor: `${SEP} t30` }]), [{ chat: SEP, id: "t30" }]);
  const others = await linkedBoards(ci, CI, async chat => chat === TYPESAFE ? board([topUp(false)]) : null);
  assert.deepEqual([...others.keys()], [TYPESAFE]);
  assert.equal(heldByTodo(p420, withLinkedBoards(ci, CI, others).todos), true);
  assert.equal(heldByTodo(p420, board([{ id: "t17", text: keyLock.text, done: false, from: "agent", at: keyLock.at }]).todos), false);
});
