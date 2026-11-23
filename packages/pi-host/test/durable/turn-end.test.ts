/**
 * When a comm thread's tool round ends its turn (`turn-end.ts`): a round of only posts and closing calls, with at least one closing call,
 * once the turn has its answer in that round or an earlier one.
 * Run: cd packages/pi-host && node --import tsx --test --test-force-exit --test-isolation=none test/durable/turn-end.test.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { roundEndsTurn, TOLD } from "../../src/durable/turn-end.ts";

let n = 0;
type Draft = { name: string; arguments: Record<string, unknown> };
const input = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
/** One assistant round with its calls, ids c1, c2, … in order. */
function round(...calls: Draft[]): { message: Message; ids: string[] } {
  const ids = calls.map(() => `c${++n}`);
  const message = {
    role: "assistant", content: calls.map((call, i) => ({ type: "toolCall", id: ids[i]!, name: call.name, arguments: call.arguments })),
    api: "anthropic-messages", provider: "anthropic", model: "m", usage: {}, stopReason: "toolUse", timestamp: 0,
  } as unknown as Message;
  return { message, ids };
}
const result = (id: string, name: string, text: string, isError = false): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 }) as Message;

const post = { name: "tell_owner", arguments: { text: "yes" } };
const eyesOff = { name: "set_emoji", arguments: { message_id: "p1", emoji: "eyes", on: false } };
const eyesOn = { name: "set_emoji", arguments: { message_id: "p1", emoji: "eyes", on: true } };
const pray = { name: "set_emoji", arguments: { message_id: "p1", emoji: "pray", on: true } };
const mark = { name: "mark_message", arguments: { message_id: "ch_1/p1", completed: true } };
const ipython = { name: "ipython", arguments: { code: "await agent_message.send('task')" } };

test("a round that posts and closes together ends the turn, as fresh agents most often finish", () => {
  const r = round(post, eyesOff, mark);
  assert.equal(roundEndsTurn([input("p1"), r.message], r.ids[0]!), true);
  assert.equal(roundEndsTurn([input("p1"), r.message], r.ids[2]!), true);
});

test("a closing round after a post that went out earlier in the turn ends it, and one after a held or refused post does not", () => {
  const p = round(post);
  const c = round(eyesOff, mark);
  assert.equal(roundEndsTurn([input("p1"), p.message, result(p.ids[0]!, "tell_owner", TOLD), c.message], c.ids[1]!), true);
  assert.equal(roundEndsTurn([input("p1"), p.message, result(p.ids[0]!, "tell_owner", "Held: it reads long. Send the same text again to post it."), c.message], c.ids[1]!), false);
  assert.equal(roundEndsTurn([input("p1"), p.message, result(p.ids[0]!, "tell_owner", "Not sent: it splits one answer.", true), c.message], c.ids[1]!), false);
});

test("👀 taken off before the reply leaves the turn running, so the reply still goes out", () => {
  const first = round(eyesOff);
  assert.equal(roundEndsTurn([input("p1"), first.message], first.ids[0]!), false);
  const earlierTurn = round(post);
  assert.equal(roundEndsTurn([input("p0"), earlierTurn.message, result(earlierTurn.ids[0]!, "tell_owner", TOLD), input("p1"), first.message], first.ids[0]!), false,
    "a post of an earlier turn does not count");
});

test("a reaction answers a post that needs no words, and a round with any other call, or with no closing call, runs on", () => {
  const thanks = round(pray, mark);
  assert.equal(roundEndsTurn([input("ok thanks"), thanks.message], thanks.ids[1]!), true);
  const handOver = round(post, ipython);
  assert.equal(roundEndsTurn([input("p1"), handOver.message], handOver.ids[0]!), false);
  const checklist = round(post, eyesOn);
  assert.equal(roundEndsTurn([input("p1"), checklist.message], checklist.ids[0]!), false);
  const onlyPost = round(post);
  assert.equal(roundEndsTurn([input("p1"), onlyPost.message], onlyPost.ids[0]!), false);
  assert.equal(roundEndsTurn([input("p1")], "c999"), false, "a call whose round is not there");
});

test("a first checklist with open items and a mark in one round runs on to the hand-over, and ends the turn once the hand-over went out", () => {
  const checklist = { name: "tell_owner", arguments: { text: "checking before you ship\n- git\n  - [ ] main vs origin\n  - [ ] uncommitted files" } };
  const first = round(checklist, mark);
  assert.equal(roundEndsTurn([input("p1"), first.message], first.ids[1]!), false, "the work has not been handed over yet");
  const hand = round(ipython);
  const closing = round(mark);
  assert.equal(roundEndsTurn([input("p1"), first.message, result(first.ids[0]!, "tell_owner", TOLD), result(first.ids[1]!, "mark_message", "Marked ch_1/p1 completed. 0 pending."),
    hand.message, result(hand.ids[0]!, "ipython", "{'id': 'agentmsg_1'}"), closing.message], closing.ids[0]!), true);
  assert.equal(roundEndsTurn([input("p1"), first.message, result(first.ids[0]!, "tell_owner", TOLD), hand.message, result(hand.ids[0]!, "ipython", "NameError", true), closing.message], closing.ids[0]!), false,
    "a hand-over that failed does not count");
  const ticked = round({ name: "edit_message", arguments: { message_id: "reply:ch_1/p1", text: "ready to ship\n- git\n  - [x] main vs origin" } }, eyesOff);
  assert.equal(roundEndsTurn([input("[agent-message from sibling:w]"), ticked.message], ticked.ids[0]!), true, "a checklist with every item ticked ends it");
  const blocked = round({ name: "edit_message", arguments: { message_id: "reply:ch_1/p1", text: "not ready to ship\n- git\n  - [x] main vs origin\n  - [ ] 9 uncommitted files" } }, eyesOff, mark);
  assert.equal(roundEndsTurn([input("[agent-message from sibling:w]"), blocked.message], blocked.ids[2]!), true,
    "a last edit with an open item belongs to work handed over earlier, so it ends the turn (blind run 5, 11-21)");
});
