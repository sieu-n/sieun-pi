// Owner, 10-27 18:43Z in api portal vp: "이딴거 마구 쳐 보내지마" (c117 again). From 13:07Z that chat ended about 11 turns he did not start (job
// reports, CI messages, check-ins, wakes) with a status recap that reminded him of todo t4, and each one lit the chat as unread in the sidebar.
// Only what a chat sends him counts as unread now: a reply on his turn or a tell_owner message, never a fold of job lines and notes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatFeed, unreadCount } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-27T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const text = (body: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const relay = (from: string, body: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from ${from}]\n\n${body}`, display: true, timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, body: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text: body, why: "decision" } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const told = (id: string, clock: string): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: at(clock) }) as ThreadMessage;

const ASK = "Should we send 정욱's org a short note on their failed API calls once our fixes reach prod? The draft is on t4, and I'd wait until the fixes are live.";
const RECAP = "Staging still has none of our fixes, and the land waits on CI. You still have one decision open on t4: whether to send 정욱's organization the note about their failed calls.";
const WAKES = ["child:portal customer failures", "CI and RepoOps", "check-in", "CI and RepoOps", "child:portal customer failures", "d10 c119 branch rename",
  "CI and RepoOps", "child:portal customer failures", "check-in", "CI and RepoOps", "child:portal customer failures"];

const day = (): ThreadMessage[] => {
  const messages: ThreadMessage[] = [owner("just curious, is convex good for logging these api usage shit..?", "06:46:56"), text("For billing it's right.", "06:47:30"),
    relay("child:portal customer failures", "Customer 5xx share is still up on prod.", "13:06:30"), tell("d1", ASK, "13:07:00"), told("d1", "13:07:01")];
  WAKES.forEach((from, n) => {
    const minute = String(20 + n * 2).padStart(2, "0");
    messages.push(relay(from, "the dev/sieun red is not ours", `1${3 + Math.floor(n / 3)}:${minute}:00`), text(RECAP, `1${3 + Math.floor(n / 3)}:${minute}:30`));
  });
  return messages;
};

test("the 10-27 recaps on turns the owner did not start leave api portal vp unread at 0 after he read the t4 ask", () => {
  const messages = day();
  const feed = chatFeed({ messages, streaming: null, wait: null });
  assert.equal(feed.at(-1)!.kind, "fold", "the recaps still show, folded");
  assert.equal(unreadCount(messages, at("13:10:00")), 0);
});

test("a tell_owner message and a reply on his turn still count as unread", () => {
  const messages = day();
  assert.equal(unreadCount(messages, at("13:00:00")), 1, "the t4 ask he had not read");
  messages.push(owner("what was issue and is it fixed? tldr pls", "18:44:09"), text("A crawler change broke one API test, and the fix is one line.", "18:44:40"));
  assert.equal(unreadCount(messages, at("18:44:10")), 1);
});
