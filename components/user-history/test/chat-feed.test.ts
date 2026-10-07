import assert from "node:assert/strict";
import { test } from "node:test";
import { chatFeed, chatItemsOf, settledPending, PENDING_SKEW_MS, type PendingSend } from "../src/shared/chat-feed.ts";
import type { AssistantMessage, CustomMessage, ThreadMessage, UserMessage } from "../src/shared/types.ts";

const user = (text: string, timestamp: number): UserMessage => ({ role: "user", content: text, timestamp });
const assistant = (parts: AssistantMessage["content"], timestamp: number, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage =>
  ({ role: "assistant", content: parts, provider: "p", model: "m", stopReason, timestamp, ...(errorMessage === undefined ? {} : { errorMessage }) });
const custom = (customType: string, content: string, timestamp: number): CustomMessage => ({ role: "custom", customType, content, timestamp });
const send = (id: string, text: string, at: number): PendingSend => ({ id, text, images: [], at });

test("chatFeed maps a chat conversation to flat lines in message order", () => {
  const messages: ThreadMessage[] = [
    user("start two jobs", 1000),
    assistant([{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "c1", name: "ipython", arguments: {} }], 1100, "toolUse"),
    { role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1200 },
    assistant([{ type: "text", text: "Both started. I will tell you when they report." }], 1300),
    custom("agent_message", "[agent-message from readme-lines]\nThere is no README.md at the repo root.\nOnly AGENTS.md and CLAUDE.md.", 1400),
    assistant([{ type: "text", text: "readme-lines says there is no README." }], 1500),
    user("what is running?", 1600),
  ];
  const feed = chatFeed({ messages, streaming: null });
  assert.deepEqual(feed.map(item => item.kind), ["user", "agent", "job", "agent", "user"]);
  assert.deepEqual(feed.map(item => item.id), ["m0", "m3", "m4", "m5", "m6"]);
  const job = feed[2];
  assert.ok(job?.kind === "job");
  assert.equal(job.from, "readme-lines");
  assert.equal(job.title, "There is no README.md at the repo root.");
  assert.equal(job.body, "There is no README.md at the repo root.\nOnly AGENTS.md and CLAUDE.md.");
  assert.equal(feed[0]?.kind === "user" ? feed[0].text : "", "start two jobs");
});

test("assistant messages with no text, tool results and non-prompt customs produce nothing", () => {
  assert.deepEqual(chatItemsOf(assistant([{ type: "toolCall", id: "c1", name: "ipython", arguments: {} }], 1, "toolUse"), 0), []);
  assert.deepEqual(chatItemsOf(assistant([{ type: "text", text: "   " }], 1), 0), []);
  assert.deepEqual(chatItemsOf({ role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1 }, 0), []);
  assert.deepEqual(chatItemsOf(custom("system_note", "ignored", 1), 0), []);
  assert.deepEqual(chatItemsOf({ role: "bashExecution", command: "ls", output: "", cancelled: false, truncated: false, timestamp: 1 }, 0), []);
  assert.deepEqual(chatItemsOf({ role: "branchSummary", summary: "s", timestamp: 1 }, 0), []);
});

test("interim assistant text before a tool call is still an agent line", () => {
  const items = chatItemsOf(assistant([{ type: "text", text: "One moment." }, { type: "toolCall", id: "c1", name: "ipython", arguments: {} }], 5, "toolUse"), 2);
  assert.deepEqual(items, [{ kind: "agent", id: "m2", text: "One moment.", at: 5 }]);
});

test("errors and stopped replies become notices, keeping any text as an agent line", () => {
  assert.deepEqual(chatItemsOf(assistant([{ type: "text", text: "" }], 7, "error", "Model request failed"), 1),
    [{ kind: "notice", id: "m1-error", text: "Error: Model request failed", at: 7 }]);
  assert.deepEqual(chatItemsOf(assistant([{ type: "text", text: "Half an ans" }], 8, "aborted"), 2),
    [{ kind: "agent", id: "m2", text: "Half an ans", at: 8 }, { kind: "notice", id: "m2-stop", text: "Reply stopped", at: 8 }]);
  assert.deepEqual(chatItemsOf(assistant([], 9, "error"), 3), [{ kind: "notice", id: "m3-error", text: "Error: the model returned an error", at: 9 }]);
});

test("other wake-up customs and compaction become one notice line each", () => {
  assert.deepEqual(chatItemsOf(custom("prime-agent.update_restart", "<restart>Prime Agent updated</restart>", 1), 0), [{ kind: "notice", id: "m0", text: "Prime Agent restarted", at: 1 }]);
  assert.deepEqual(chatItemsOf(custom("async_bash_completion", "[async-bash exit:0]\nCommand: \"ls\"", 2), 1), [{ kind: "notice", id: "m1", text: "Background command finished, exit 0", at: 2 }]);
  assert.deepEqual(chatItemsOf({ role: "compactionSummary", summary: "s", tokensBefore: 10, timestamp: 3 }, 2), [{ kind: "notice", id: "m2", text: "Older messages were summarized to free space", at: 3 }]);
  const empty = chatItemsOf(custom("agent_message", "[agent-message from w1]", 4), 3);
  assert.ok(empty[0]?.kind === "job" && empty[0].title === "(empty message)" && empty[0].from === "w1");
});

test("a streaming reply is one agent line with streaming set, and no line while it has no text", () => {
  const messages: ThreadMessage[] = [user("hi", 1)];
  assert.deepEqual(chatFeed({ messages, streaming: assistant([{ type: "text", text: "" }], 2) }).map(item => item.kind), ["user"]);
  const feed = chatFeed({ messages, streaming: assistant([{ type: "text", text: "Hel" }], 2) });
  assert.deepEqual(feed[1], { kind: "agent", id: "streaming", text: "Hel", at: 2, streaming: true });
  const stopped = chatFeed({ messages, streaming: assistant([{ type: "text", text: "Hel" }], 2, "aborted") });
  assert.equal(stopped.length, 2, "a streaming message never adds a notice; the committed message does");
});

test("a pending send shows as a pending user line until the thread echoes the same text after it", () => {
  const T = 10 * PENDING_SKEW_MS;
  const pending = [send("a", "ok", T + 5000), send("b", "ok", T + 6000)];
  const before = chatFeed({ messages: [user("ok", 1000)], streaming: null }, pending);
  assert.deepEqual(before.map(item => item.kind === "user" ? [item.id, item.pending ?? false] : null), [["m0", false], ["pa", true], ["pb", true]], "an older identical message does not settle a new send");
  const one = chatFeed({ messages: [user("ok", 1000), user("ok", T + 5100)], streaming: null }, pending);
  assert.deepEqual(one.map(item => item.id), ["m0", "m1", "pb"]);
  const both = chatFeed({ messages: [user("ok", 1000), user("ok", T + 5100), user("ok", T + 6100)], streaming: null }, pending);
  assert.deepEqual(both.map(item => item.id), ["m0", "m1", "m2"]);
  assert.deepEqual([...settledPending([user("ok", 5000 - PENDING_SKEW_MS)], [send("a", "ok", 5000)])], ["a"], "a daemon clock a little behind the phone still settles the send");
  assert.deepEqual([...settledPending([user("other", 5100)], [send("a", "ok", 5000)])], []);
});

test("a job message the snapshot clipped names where its full text is", () => {
  const clipped: CustomMessage = { role: "custom", customType: "agent_message", content: [{ type: "text", text: "[agent-message from w10]\nLong report", truncated: true }], timestamp: 1 };
  assert.deepEqual(chatItemsOf(clipped, 4), [{ kind: "job", id: "m4", from: "w10", title: "Long report", body: "Long report", at: 1, clipped: { message: 4, part: 0 } }]);
  assert.equal("clipped" in chatItemsOf({ role: "custom", customType: "agent_message", content: "[agent-message from w10]\nShort", timestamp: 1 }, 0)[0]!, false);
});
