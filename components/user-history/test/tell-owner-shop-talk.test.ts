// c18 came back after its brief line (75ef234f): on 10-18 the owner quoted `lands`, `rolls out` back to ops guy, and on 10-19 frontend bro's
// "Killed the zero-result filter check" and "The wiring is mostly fine" drew c138 and c135, so tell_owner refuses shop talk once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn } from "../src/chat-guard.ts";
import { SHOP_TALK_MARK, shopTalk } from "../src/shared/reply-lint.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-19T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const result = (id: string, text: string, clock: string, isError: boolean): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError, timestamp: at(clock) }) as ThreadMessage;

/** tell_owner texts the owner answered with c18, c135 or c138 on 10-18 and 10-19, and two from after c135 that still gave UTC. */
const SENT = [
  "Killed the zero-result filter check. Every morning a new one now tests prod search end to end, and today 88% of filters work.",
  "The wiring is mostly fine, we're just out of Claude.",
  "The fix lands in about 15 minutes.",
  "The job is landing a limiter that shrinks retries when connections stop answering.",
  "Usage shows real numbers again. Cache hit was 95.3% over 3,217 calls at 16:40Z UTC.",
  "지금(16:10Z UTC) 아웃박스에 못 간 메시지가 24개야.",
  "Prime's own exporter replaces that after its rollout.",
  "Vent's code finally reached dev a moment ago (4a68dc4b85).",
];

test("each message the owner called slop is refused once, naming the word and what to say instead", () => {
  const turn = tellTurn([owner("how is it going?", "13:50:00")]);
  for (const text of SENT) {
    const out = tellOwner({ text }, turn);
    assert.equal(out.kind, "refused", text);
    assert.ok(out.text.startsWith(SHOP_TALK_MARK), out.text);
  }
  assert.match(tellOwner({ text: SENT[4]! }, turn).text, /KST/);
});

test("the plain rewrites the owner let stand go out", () => {
  const turn = tellTurn([owner("how is it going?", "13:50:00")]);
  for (const text of [
    "yeah, still robotic. onboarding works now, but the campaign it makes comes out empty because the AI guessed too small a follower range, so I'm making it base the range on who those brands actually work with.",
    "and the search check I set up this morning was too narrow, so it's now one daily check of all of prod search.",
    "The 5174 header looks right and matches staging pixel for pixel, same logo, nav and spacing.",
    "The landing page header is fixed, and [landing header check](job:landing header check) took the screenshot at 06:44 KST.",
  ]) assert.deepEqual(tellOwner({ text }, turn), { kind: "sent", text: TELL_OWNER_DONE }, text);
});

test("a word the owner used in his message stays his word", () => {
  const turn = tellTurn([owner("serve the README the way it was in the d1 canary build (4f1c45a)", "21:07:00")]);
  assert.equal(tellOwner({ text: "The 4f1c45a README is up, with its screenshots." }, turn).kind, "sent");
  assert.deepEqual(shopTalk("It lands today.", "when does it land? lands today?"), []);
});

test("the very same text sent again after the refusal goes out, so the check is a soft cap (c98)", () => {
  const text = SENT[2]!;
  const first = tellOwner({ text }, tellTurn([owner("when is it fixed?", "04:00:00")]));
  assert.equal(first.kind, "refused");
  const again = tellTurn([owner("when is it fixed?", "04:00:00"), tell("t1", text, "04:00:05"), result("t1", first.text, "04:00:06", true)]);
  assert.deepEqual(tellOwner({ text }, again), { kind: "sent", text: TELL_OWNER_DONE });
  assert.equal(tellOwner({ text: "It rolls out tonight." }, again).kind, "refused", "a different text is checked again");
});

test("a message held on a turn the owner did not start stays held, not refused", () => {
  const turn = { ...tellTurn([owner("ok", "10:00:00")]), owner: false, byOwner: false };
  assert.equal(tellOwner({ text: "The fix lands at 14:30Z.", why: "update", about: "fix" }, turn).kind, "held");
});
