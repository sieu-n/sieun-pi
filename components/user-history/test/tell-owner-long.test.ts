// c18 and c104 came back after their brief lines and prompt notes: on 10-22 06:29Z the owner answered a 168-word tell_owner in the AI harness
// chat with "also your messages are too long unslop. return to Slack DM message mode.", and the c18 clean room's first run on release-03705d8
// packed three facts into one 38-word sentence. tell_owner now refuses a long text once (longReply), and the very same text again goes out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn } from "../src/chat-guard.ts";
import { LONG_REPLY_MARK, longReply } from "../src/shared/reply-lint.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-22T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const result = (id: string, text: string, clock: string, isError: boolean): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError, timestamp: at(clock) }) as ThreadMessage;

/** The AI harness chat's 06:28:50Z answer the owner called too long, and the c18 clean room run1's 11:59Z status line. */
const TOO_LONG = [
  "Here's what we already know. gpt sol's study found no lost messages, since all 8,473 queue waits on us-metal02 ended, but job turns wait " +
    "about 10 min at p90 and up to 30 min, while your turns wait almost nothing. Messages held while a session is busy already go out bundled " +
    "(157 messages went out as 26 sends), so 20 popping one by one is probably messages that arrive mid-turn and get read one per turn, which " +
    "I'm checking. The 30000 ms error is the send confirmation timing out while the receiving session is busy, and the message usually still " +
    "gets there later. Prime itself got slow under load today, with connects taking 3 to 7 s and one session list taking 17 s, and chat-057a " +
    "is profiling that. I'm starting three jobs: one audits the queue and messaging for bugs and makes pending messages arrive in one turn, one " +
    "tests how Prime behaves when it's slow, and one builds the three panel groups in the harness dashboard.",
  "The crawler is mostly running today. Prod Postgres went down from 17:04 to 18:47 KST, census is at about 9,000 profiles a minute against " +
    "the 10k goal (p826), and most of the waiting fixes are held until a crawler-only release goes to prod (p912).",
];

test("the answers the owner called too long are refused once, naming the long sentence and where the rest goes", () => {
  const turn = tellTurn([owner("what's going on with the crawler today, anything i need to do?", "11:58:25")]);
  for (const text of TOO_LONG) {
    const out = tellOwner({ text }, turn);
    assert.equal(out.kind, "refused", text);
    assert.ok(out.text.startsWith(LONG_REPLY_MARK), out.text);
    assert.match(out.text, /board or a wiki page/);
  }
  assert.deepEqual(longReply(TOO_LONG[0]!), ['a 39-word sentence ("Messages held while a session is busy a…")', "168 words in all"]);
  assert.deepEqual(longReply(TOO_LONG[1]!), ['a 38-word sentence ("Prod Postgres went down from 17:04 to 1…")']);
});

test("short replies and the 33-word sentence the owner let stand on 10-19 go out", () => {
  const turn = tellTurn([owner("also can you use another alias not db", "09:34:16")]);
  for (const text of [
    "Yes, I'll use `/mcp/sudo` for that connection instead of `/mcp/db`.",
    "I'll use /mcp/insight, deploy it, and test it on claude.ai.",
    "Almost none are new. Of 515 related handles from 200 logged-out profile reads, 513 (99.6%) were already in census, since the endpoint " +
      "mostly returns big accounts (median 514k followers) we already have.",
    "yeah, still robotic. onboarding works now, but the campaign it makes comes out empty because the AI guessed too small a follower range, " +
      "so I'm making it base the range on who those brands actually work with.",
  ]) assert.deepEqual(tellOwner({ text }, turn), { kind: "sent", text: TELL_OWNER_DONE }, text);
});

test("a link, code span, URL or quote counts as one word", () => {
  const link = "[the account queue and job recovery page](wiki:https://us-metal02-dev.tail0c093d.ts.net:5176/page/sessions/2026/10/22/account-queue.html)";
  assert.deepEqual(longReply(`The page walks one real job through a 429, a park and its wake, ${link}.`), []);
  assert.deepEqual(longReply(`You wrote "${"word ".repeat(40).trim()}" and I did it.`), []);
});

test("the very same text sent again after the refusal goes out, so the check is a soft cap (c98)", () => {
  const text = TOO_LONG[1]!;
  const first = tellOwner({ text }, tellTurn([owner("how is the crawler?", "11:58:25")]));
  assert.equal(first.kind, "refused");
  const again = tellTurn([owner("how is the crawler?", "11:58:25"), tell("t1", text, "11:59:16"), result("t1", first.text, "11:59:17", true)]);
  assert.deepEqual(tellOwner({ text }, again), { kind: "sent", text: TELL_OWNER_DONE });
  assert.equal(tellOwner({ text: TOO_LONG[0]! }, again).kind, "refused", "a different text is checked again");
});

test("a long message held on a turn the owner did not start stays held, not refused", () => {
  const turn = { ...tellTurn([owner("ok", "10:00:00")]), owner: false, byOwner: false };
  assert.equal(tellOwner({ text: TOO_LONG[0]!, why: "update", about: "queue" }, turn).kind, "held");
});
