import assert from "node:assert/strict";
import { test } from "node:test";
import { applyThreadEvent, isThreadBusy, threadStateFromSnapshot } from "../src/shared/thread-state.ts";
import { allTurns, buildTurns, liveTurn, toolDurationMs, triggerSummary } from "../src/shared/turns.ts";
import type { AssistantMessage, CustomMessage, ThreadSnapshot, ThreadState, ToolResultMessage, UserMessage } from "../src/shared/types.ts";
import { ImageStore, Projector, TEXT_LIMIT, THINKING_LIMIT } from "../src/chat-projection.ts";
import { isListed, previewTitle, projectRow } from "../src/chat-catalog.ts";
import { duration } from "../src/client/format.ts";
import type { SessionSummary } from "prime-agent";

const info: ThreadSnapshot["info"] = { sessionId: "s1", cwd: "/tmp", model: null, thinkingLevel: "medium", availableThinkingLevels: ["low", "medium"], isStreaming: false, isCompacting: false,
  isBashRunning: false, retryAttempt: 0, messageCount: 0, context: null, usage: null, sessionAction: null, queuedActions: 0 };
const user = (text: string, timestamp: number): UserMessage => ({ role: "user", content: text, timestamp });
const assistant = (parts: AssistantMessage["content"], timestamp: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({ role: "assistant", content: parts, provider: "p", model: "m", stopReason, timestamp });
const result = (toolCallId: string, text: string, timestamp: number, durationMs?: number): ToolResultMessage =>
  ({ role: "toolResult", toolCallId, toolName: "ipython", content: [{ type: "text", text }], isError: false, timestamp, ...(durationMs === undefined ? {} : { durationMs }) });
const empty = (): ThreadState => threadStateFromSnapshot({ kind: "live", info, messages: [], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });

test("reducer follows the native message lifecycle and clears run state at agent_end", () => {
  let state = empty();
  state = applyThreadEvent(state, { type: "event", event: { type: "agent_start" } }, 1000);
  assert.equal(state.info.isStreaming, true);
  assert.equal(state.runStartedAt, 1000);
  state = applyThreadEvent(state, { type: "event", event: { type: "message_end", message: user("hi", 1001) } });
  state = applyThreadEvent(state, { type: "event", event: { type: "message_start", message: assistant([{ type: "text", text: "" }], 1002) } });
  state = applyThreadEvent(state, { type: "event", event: { type: "message_update", message: assistant([{ type: "text", text: "Hel" }], 1002) } });
  assert.equal(state.streaming?.content[0]?.type === "text" ? state.streaming.content[0].text : "", "Hel");
  assert.equal(state.messages.length, 1);
  state = applyThreadEvent(state, { type: "event", event: { type: "tool_execution_start", toolCallId: "c1", toolName: "ipython" } }, 1500);
  state = applyThreadEvent(state, { type: "event", event: { type: "tool_execution_update", toolCallId: "c1", toolName: "ipython", partial: "half" } });
  assert.deepEqual(state.tools, [{ toolCallId: "c1", toolName: "ipython", status: "running", startedAt: 1500, partial: "half" }]);
  assert.equal(isThreadBusy(state), true);
  state = applyThreadEvent(state, { type: "event", event: { type: "message_end", message: assistant([{ type: "toolCall", id: "c1", name: "ipython", arguments: {} }], 1002, "toolUse") } });
  assert.equal(state.streaming, null);
  state = applyThreadEvent(state, { type: "event", event: { type: "message_end", message: result("c1", "done", 1600, 100) } });
  assert.deepEqual(state.tools, [], "a tool result retires its run");
  state = applyThreadEvent(state, { type: "event", event: { type: "message_end", message: assistant([{ type: "text", text: "Hello" }], 1700) } });
  state = applyThreadEvent(state, { type: "event", event: { type: "agent_end" } });
  assert.equal(state.info.isStreaming, false);
  assert.equal(state.runStartedAt, null);
  assert.equal(state.messages.length, 4);
  assert.equal(isThreadBusy(state), false);
  state = applyThreadEvent(state, { type: "event", event: { type: "session_info_changed", name: "Named" } });
  assert.equal(state.info.name, "Named");
  state = applyThreadEvent(state, { type: "event", event: { type: "session_info_changed", name: undefined } });
  assert.equal("name" in state.info, false);
  state = applyThreadEvent(state, { type: "status", connection: "reconnecting", error: "socket closed" });
  assert.equal(state.connection, "reconnecting");
  const replaced = applyThreadEvent(state, { type: "snapshot", snapshot: { kind: "live", info, messages: [user("x", 1)], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null } });
  assert.equal(replaced.messages.length, 1);
  assert.equal(replaced.connection, "reconnecting", "a snapshot keeps the transport status");
});

test("turns fold thinking and tool calls of one reply into one work row and keep the final text as the reply", () => {
  const messages = [
    user("Do it", 1),
    assistant([{ type: "thinking", thinking: "plan" }, { type: "text", text: "Looking." }, { type: "toolCall", id: "c1", name: "ipython", arguments: { code: "1+1" } }], 2, "toolUse"),
    result("c1", "2", 3, 40),
    assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }], 4, "toolUse"),
    result("c2", "a b", 5),
    assistant([{ type: "text", text: "Done." }], 6),
    user("Thanks", 7),
    assistant([{ type: "text", text: "" }], 8, "aborted"),
  ];
  const turns = buildTurns(messages);
  assert.equal(turns.length, 2);
  const [first, second] = turns;
  assert(first && second);
  assert.deepEqual(first.work.map(item => item.kind), ["thinking", "note", "tool", "tool"]);
  const tool = first.work[2];
  assert(tool && tool.kind === "tool");
  assert.equal(toolDurationMs(tool, 1000), 40, "native durationMs wins");
  const untimed = first.work[3];
  assert(untimed && untimed.kind === "tool");
  assert.equal(toolDurationMs(untimed, 1000), null, "no native duration and not running means no duration");
  assert.equal(first.reply?.message.timestamp, 6);
  assert.equal(first.startedAt, 1);
  assert.equal(first.endedAt, 6);
  assert.equal(second.reply?.message.stopReason, "aborted", "aborted replies stay visible");
  const streaming = assistant([{ type: "text", text: "Str" }], 9);
  const live = liveTurn(turns.at(-1), streaming, [{ toolCallId: "c9", toolName: "bash", status: "running", startedAt: 100 }], messages.length);
  assert(live);
  assert.equal(live.live, true);
  assert.equal(live.reply?.live, true);
  assert.equal(liveTurn(turns.at(-1), null, [], messages.length), null);
  const all = allTurns(messages, streaming, []);
  assert.equal(all.length, 2);
  assert.equal(all[1]?.live, true);
  assert.equal(all[1]?.work.length, 0);
});

test("projection trims payloads, keeps native names, and marks truncation", () => {
  const projector = new Projector(new ImageStore(1024 * 1024));
  const big = "x".repeat(TEXT_LIMIT + 50);
  const projected = projector.messages([
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(THINKING_LIMIT + 5), thinkingSignature: "sig" }, { type: "toolCall", id: "c1", name: "ipython", arguments: { code: big } }],
      api: "a", provider: "p", model: "m", stopReason: "toolUse", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [{ type: "text", text: big }], isError: false, timestamp: 3, details: { durationMs: 12 } },
    { role: "custom", customType: "harness_digest", content: "hidden", display: false, timestamp: 4 },
    { role: "custom", customType: "agent_message", content: "shown", display: true, timestamp: 5 },
  ] as never);
  assert.equal(projected.length, 4, "non-display custom messages are dropped");
  const [userMessage, assistantMessage, toolMessage] = projected;
  assert(userMessage?.role === "user" && Array.isArray(userMessage.content));
  const image = userMessage.content[1];
  assert(image?.type === "image" && /^api\/images\/[a-f0-9]{64}$/.test(image.url), "image bytes leave the payload");
  assert(assistantMessage?.role === "assistant");
  const thinking = assistantMessage.content[0];
  assert(thinking?.type === "thinking" && thinking.truncated === true && thinking.thinking.length === THINKING_LIMIT && !("thinkingSignature" in thinking));
  const call = assistantMessage.content[1];
  assert(call?.type === "toolCall" && call.truncated === true && call.name === "ipython");
  assert(toolMessage?.role === "toolResult" && toolMessage.durationMs === 12 && toolMessage.content[0]?.type === "text" && toolMessage.content[0].truncated === true);
  assert.equal(JSON.stringify(projected).includes(big), false);
});

test("catalog rows hide empty drafts and saved rows whose file is gone", () => {
  const base = { id: "a", lifecycle: "live", activity: "idle", isSessionActive: false, sessionId: "a", cwd: "/tmp", isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 3,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] }, sessionFile: "/tmp/a.jsonl" } as unknown as SessionSummary;
  assert.equal(isListed(base, () => true), true);
  assert.equal(isListed(base, () => false), false, "a moved or deleted file is not listed");
  assert.equal(isListed({ ...base, activeSessionId: "live-1" }, () => false), true, "resident sessions are listed even if the file moved");
  assert.equal(isListed({ ...base, messageCount: 0 }, () => true), false, "empty unnamed drafts are hidden");
  assert.equal(isListed({ ...base, messageCount: 0, sessionName: "Kept" }, () => true), true);
  const row = projectRow({ ...base, firstMessage: '<skill name="x" location="/private/x/SKILL.md">\nbody\n</skill>\n\nReal question', lastActivityAt: "2026-01-02T00:00:00Z" }, undefined, 0);
  assert.equal(row.name, "Real question");
  assert.equal(row.kind, "saved");
  assert.equal(row.unread, true);
  assert.equal(projectRow({ ...base, lastActivityAt: "2026-01-02T00:00:00Z" }, Date.parse("2026-01-03T00:00:00Z"), 0).unread, false);
  assert.equal(previewTitle(""), "New chat");
});

test("durations never show 0s for a timed call", () => {
  assert.equal(duration(40), "0.1s");
  assert.equal(duration(420), "0.4s");
  assert.equal(duration(1031), "1s");
  assert.equal(duration(134000), "2m 14s");
  assert.equal(duration(3_600_000), "1h 0m");
});

test("agent messages and background completions start a turn as a trigger, never as the user's prompt", () => {
  const agent: CustomMessage = { role: "custom", customType: "agent_message", content: "[agent-message from child:worker]\n\nDone. See the report.", timestamp: 1 };
  const bash: CustomMessage = { role: "custom", customType: "async_bash_completion", content: '[bash-done pid:42 exit:0]\n\nCommand: "npm test"', timestamp: 3 };
  const user: UserMessage = { role: "user", content: "real question", timestamp: 5 };
  const turns = buildTurns([agent, bash, user]);
  assert.deepEqual(turns.map(turn => [turn.prompt?.index ?? null, turn.trigger?.index ?? null]), [[null, 0], [null, 1], [2, null]]);
  assert.deepEqual(triggerSummary(agent), { label: "Message", detail: "from child:worker", body: "Done. See the report." });
  assert.deepEqual(triggerSummary(bash), { label: "Background command finished", detail: "exit 0", body: "npm test" });
});

test("a skill invocation projects to what the user typed plus the skill name", () => {
  const projector = new Projector(new ImageStore(1024 * 1024));
  const [message] = projector.messages([
    { role: "user", content: [{ type: "text", text: '<skill name="poteto-mode" location="/x/SKILL.md">\n' + "rules ".repeat(5000) + "\n</skill>\n\nfix the sidebar" }], timestamp: 1 },
  ] as never);
  assert(message?.role === "user");
  assert.equal(message.skill, "poteto-mode");
  assert.deepEqual(message.content, [{ type: "text", text: "fix the sidebar" }]);
});
