// The quiet-wakes clean-room judge (c117 again, owner 10-27 18:43Z in api portal vp: "이딴거 마구 쳐 보내지마") fails the 10-27 recaps and passes a chat
// that ends its quiet turns with a few words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatLines } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";
import { judgeLines, noteFaults } from "../scripts/clean-room/quiet-wakes.ts";

const at = (clock: string): number => Date.parse(`2026-10-27T${clock}Z`);
const text = (body: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const relay = (body: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:duty watch]\n\n${body}`, display: true, timestamp: at(clock) }) as ThreadMessage;
const RECAP = "Staging still has none of our fixes, and the land waits on CI. You still have one decision open on t4: whether to send 정욱's organization the note about their failed calls.";
const turns = (closing: string): ThreadMessage[] => ["13:20", "13:50", "14:20"].flatMap(clock => [relay("the dev/sieun red is not ours", `${clock}:00`), text(closing, `${clock}:30`)]);

test("the 10-27 recap fails the quiet-turn check and a few words on the change pass", () => {
  assert.deepEqual(noteFaults(RECAP), ["2 sentences", "a reminder of an open question"]);
  assert.deepEqual(noteFaults("Added the 14:20 check to p3."), []);
  assert.deepEqual(noteFaults("Your call on t2 is still open."), ["a reminder of an open question"]);
});

test("the judge fails a chat that ends its quiet turns with the recap and passes one that ends them with a few words", async () => {
  const loud = turns(RECAP);
  const failed = await judgeLines(chatLines(loud), loud, at("13:07:00"));
  assert.equal(failed.find(check => check.id === "b")!.ok, false);
  assert.equal(failed.find(check => check.id === "d")!.ok, true);
  const quiet = turns("Added the newest check to p3.");
  const passed = await judgeLines(chatLines(quiet), quiet, at("13:07:00"));
  assert.deepEqual(passed.map(check => check.ok), [true, true, true, true]);
  const none = await judgeLines(chatLines(quiet), quiet, undefined);
  assert.deepEqual(none.map(check => check.ok), [null, null, null, null]);
});

test("a new question that names its own new todo is no reminder, and one that names an earlier todo again is", async () => {
  const tell = (id: string, body: string, clock: string): ThreadMessage[] => [
    ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text: body, why: "decision" } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage,
    ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: at(clock) }) as ThreadMessage];
  const fresh = [...tell("a", "Should owner corrections run once a day (t1)?", "13:08:00"), ...tell("b", "Stop the extra wiki dream runs (t3)?", "14:08:00")];
  assert.equal((await judgeLines(chatLines(fresh), fresh, at("13:07:00"))).find(check => check.id === "c")!.ok, true);
  const again = [...fresh, ...tell("c", "Any call on t1 yet?", "15:08:00")];
  assert.equal((await judgeLines(chatLines(again), again, at("13:07:00"))).find(check => check.id === "c")!.ok, false);
});
