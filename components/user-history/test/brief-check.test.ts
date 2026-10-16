import assert from "node:assert/strict";
import { test } from "node:test";
import { briefCheck, briefCheckNote, ownerMessages } from "../src/shared/brief-check.ts";
import { serverNote } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as unknown as ThreadMessage;
const reply = (text: string, timestamp: number, stopReason = "toolUse") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp }) as unknown as ThreadMessage;

const ask = "are you not conveying the raw version of the message? like can you simulate what you send to the agent?";

test("brief check: a brief with no gate or wait passes, whatever its quote or Split line", () => {
  assert.deepEqual(briefCheck(`[task from parent]\nOwner's words (verbatim):\n1. 10:02 "${ask}"\n\nMy read: he wants the raw brief shown.\nSplit: inline, two file reads.\nAudit the briefs.`), []);
  assert.deepEqual(briefCheck("Audit the briefs."), [], "no owner block and no Split line pass");
  const note = briefCheckNote("ci fixes", [{ kind: "waits-for-leave", wait: { kind: "thread", phrase: "Fable's word" } }]);
  assert.match(note, /^\[brief check\] Your brief for \[ci fixes\]\(job:ci fixes\) has the job wait or sets a gate \(c47\):\n- It has the job wait/);
  assert.match(note, /receiver_name="ci fixes"/);
  assert.equal(serverNote(note), "brief check");
});

test("brief check: owner messages leave out server notes and board actions", () => {
  const messages = [user(ask + "\n[message id: abc]", 1_000), user("[board] chose Go on p3", 2_000), user("[reply check] Your reply had: x", 3_000),
    user("[check-in] Your last turn failed at 10:00 (429). The owner's message is still unanswered: \"x\". Answer it first.", 4_000), reply("ok", 4_100)];
  assert.deepEqual(ownerMessages(messages).map(message => message.at), [1_000]);
});
