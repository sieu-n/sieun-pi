import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyThreadEvent, isThreadBusy, threadStateFromSnapshot } from "../src/shared/thread-state.ts";
import { allTurns, buildTurns, currentRun, exchangesOf, liveTurn, ownRun, toolDurationMs, triggerSummary, workCounts } from "../src/shared/turns.ts";
import { CACHE_COLD_GAP_MS, cacheHealth } from "../src/shared/cache-health.ts";
import { matchCommands } from "../src/client/command-match.ts";
import type { AssistantMessage, Command, CustomMessage, ThreadSnapshot, ThreadState, ToolResultMessage, UserMessage } from "../src/shared/types.ts";
import { ImageStore, Projector, TEXT_LIMIT, THINKING_LIMIT } from "../src/chat-projection.ts";
import { isListed, projectRow, sessionTitle } from "../src/chat-catalog.ts";
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
      api: "a", provider: "p", model: "m", stopReason: "toolUse", timestamp: 2, usage: { input: 3, output: 40, cacheRead: 9000, cacheWrite: 120, totalTokens: 9163, cost: { input: 0, output: 0.001, cacheRead: 0.002, cacheWrite: 0.0005, total: 0.0035 } } },
    { role: "toolResult", toolCallId: "c1", toolName: "ipython", content: [{ type: "text", text: big }], isError: false, timestamp: 3, details: { durationMs: 12 } },
    { role: "custom", customType: "harness_digest", content: "hidden", display: false, timestamp: 4 },
    { role: "custom", customType: "agent_message", content: "shown", display: true, timestamp: 5 },
  ] as never);
  assert.equal(projected.length, 4, "non-display custom messages are dropped");
  const [userMessage, assistantMessage, toolMessage] = projected;
  assert(assistantMessage?.role === "assistant");
  assert.deepEqual(assistantMessage.usage, { input: 3, output: 40, cacheRead: 9000, cacheWrite: 120, totalTokens: 9163, cost: 0.0035 }, "native per-call usage keeps its names, cost is cost.total");
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
  assert.equal(sessionTitle({}), "New chat");
  assert.equal(sessionTitle({ firstMessage: "", cwd: "/w/auto-sns-agent" }), "auto-sns-agent", "no name and no first message: the folder, as in the terminal agents view");
  assert.equal(sessionTitle({ sessionName: "  spec\n work ", firstMessage: "ignored" }), "spec work", "the native name wins, as in the terminal agents view");
  assert.equal(sessionTitle({ firstMessage: "(large message)" }), "(large message)", "the native first message is shown as the daemon sends it");
});

test("a thread's title stays its first stored user message after a compaction or a resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "title-"));
  const file = join(dir, "s.jsonl");
  const user = (text: string) => JSON.stringify({ type: "message", id: text.slice(0, 4), parentId: null, timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "s" }), user("Real   first\nquestion"), JSON.stringify({ type: "compaction", id: "c1" }), user("continue there was wifi break"), ""].join("\n"));
  assert.equal(sessionTitle({ firstMessage: "continue there was wifi break", sessionFile: file }), "Real first question", "the daemon's in-memory first message never replaces the stored one");
  assert.equal(sessionTitle({ firstMessage: "draft", sessionFile: join(dir, "missing.jsonl") }), "draft", "no file yet: the daemon's first message");
  rmSync(dir, { recursive: true, force: true });
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
  const turns = buildTurns([agent, assistant([{ type: "text", text: "Noted." }], 2), bash, assistant([{ type: "text", text: "Tests pass." }], 4), user]);
  assert.deepEqual(turns.map(turn => [turn.prompt?.index ?? null, turn.trigger?.index ?? null]), [[null, 0], [4, null]]);
  assert.deepEqual(turns[0]?.work.map(item => item.kind), ["exchange"], "a completion after the run settled nests in the open turn");
  assert.deepEqual(triggerSummary(agent), { label: "Message", detail: "from child:worker", body: "Done. See the report." });
  assert.deepEqual(triggerSummary(bash), { label: "Background command finished", detail: "exit 0", body: "npm test" });
});

test("Default view keeps one final reply per turn and folds everything else into its work", () => {
  const midRun: CustomMessage = { role: "custom", customType: "agent_message", content: "[agent-message from child:a]\n\nhalf done", timestamp: 4 };
  const outcome: CustomMessage = { role: "custom", customType: "refinement_outcome", content: "saved a memory", timestamp: 9 };
  const messages = [
    user("Do it", 1),
    assistant([{ type: "text", text: "Starting." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], 2, "toolUse"),
    result("c1", "a", 3),
    midRun,
    assistant([{ type: "text", text: "Interim." }], 5, "toolUse"),
    assistant([{ type: "text", text: "Final answer." }], 8),
    outcome,
  ];
  const [turn, ...rest] = buildTurns(messages);
  assert(turn);
  assert.equal(rest.length, 0, "a message that lands mid-run and a later system note do not open turns");
  assert.equal(turn.reply?.message.timestamp, 8);
  assert.deepEqual(turn.work.map(item => item.kind), ["note", "tool", "trigger", "note", "system"]);
  assert.deepEqual(workCounts(turn.work), { tools: 1, notes: 4 });
  assert.equal(turn.endedAt, 8, "a note after the reply does not stretch the duration");
  const idle = liveTurn(turn, null, [], messages.length);
  assert.equal(idle, null);
  const between = liveTurn(turn, null, [], messages.length, true);
  assert.equal(between?.live, true, "a running thread keeps its last turn live between model calls");
});

test("messages after a settled run nest as exchanges and the prompt's own reply stays the Response", () => {
  const fromChild = (name: string, body: string, timestamp: number): CustomMessage =>
    ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\n\n${body}`, timestamp });
  const heartbeat: CustomMessage = { role: "custom", customType: "heartbeat_prompt", content: "[heartbeat daily]\n\nCheck the queue.", timestamp: 20 };
  const messages = [
    user("Ship it", 1),
    assistant([{ type: "text", text: "Started two workers." }], 2),
    fromChild("a", "a is done", 3),
    assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "git log" } }], 4, "toolUse"),
    result("c1", "ok", 5),
    assistant([{ type: "text", text: "One of two done." }], 6),
    fromChild("b", "b is done", 7),
    assistant([{ type: "text", text: "Both done." }], 8),
    heartbeat,
    assistant([{ type: "text", text: "Queue empty." }], 21),
  ];
  const [turn, beat, ...rest] = buildTurns(messages);
  assert(turn && beat);
  assert.equal(rest.length, 0);
  assert.equal(beat.trigger?.index, 8, "a heartbeat is a scheduled prompt and opens its own turn");
  assert.deepEqual(turn.work.map(item => item.kind), ["exchange", "exchange"]);
  assert.equal(turn.reply?.message.timestamp, 2, "a later agent message does not take the prompt's reply away");
  assert.deepEqual(ownRun(turn).work, [], "the work row holds only the prompt's own run");
  const [first, second] = exchangesOf(turn);
  assert(first && second);
  assert.equal(first.reply?.message.timestamp, 6, "each exchange keeps its own reply");
  assert.equal(second.reply?.message.timestamp, 8);
  assert.deepEqual(first.work.map(item => item.kind), ["tool"]);
  assert.deepEqual(workCounts(first.work), { tools: 1, notes: 0 });

  const settled = messages.slice(0, 7);
  const [open] = buildTurns(settled);
  assert(open);
  const streaming = assistant([{ type: "text", text: "Checking b" }], 9);
  const live = liveTurn(open, streaming, [], settled.length);
  assert(live);
  assert.equal(currentRun(live).trigger?.index, 6, "the stream lands in the latest exchange");
  assert.equal(currentRun(live).reply?.live, true);
  assert.equal(live.reply?.message.timestamp, 2, "the prompt's reply stays while an exchange streams");
  assert.equal(ownRun(live).live, false, "only the exchange shows as running");
  assert.equal(currentRun(open).reply, null, "the committed turn is not mutated");
});

test("a subagent exit notice nests as an exchange, and a failed call with no text keeps the reply", () => {
  const exited: CustomMessage = { role: "custom", customType: "rlm_child_terminal_notice", content: "[child-exited: cancelled child:g-staging]\n\nDeleted by parent orchestrator", timestamp: 3 };
  const failure: AssistantMessage = { ...assistant([], 6), stopReason: "error", errorMessage: "rate limited" };
  const messages = [user("Status?", 1), assistant([{ type: "text", text: "The full report." }], 2), exited, assistant([{ type: "text", text: "Expected exit." }], 4), failure];
  const [turn, ...rest] = buildTurns(messages);
  assert(turn);
  assert.equal(rest.length, 0);
  assert.equal(turn.reply?.message.timestamp, 2, "the answer to the prompt stays the Response");
  const [exchange] = exchangesOf(turn);
  assert.equal(exchange?.reply?.message.timestamp, 4);
  assert.equal(exchange?.failure?.message.errorMessage, "rate limited", "the error shows under the reply it followed");
  assert.deepEqual(triggerSummary(exited), { label: "Subagent exited", detail: "g-staging, cancelled", body: "Deleted by parent orchestrator" });
});

test("cache health flags a warm call that reads nothing from the cache and ignores cold starts", () => {
  const call = (timestamp: number, usage: { input: number; cacheRead: number; cacheWrite: number }, model = "m"): AssistantMessage =>
    ({ ...assistant([{ type: "text", text: "x" }], timestamp, "toolUse"), model, usage: { ...usage, output: 10, totalTokens: 0, cost: 0.01 } });
  const healthy = [call(0, { input: 50_000, cacheRead: 0, cacheWrite: 0 }), call(1000, { input: 200, cacheRead: 50_000, cacheWrite: 300 })];
  assert.equal(cacheHealth(healthy).level, "ok", "the first call is a cold start");
  const afterIdle = [...healthy, call(1000 + CACHE_COLD_GAP_MS + 1, { input: 51_000, cacheRead: 0, cacheWrite: 0 })];
  assert.equal(cacheHealth(afterIdle).level, "ok", "a call after five idle minutes is a cold start");
  assert.equal(cacheHealth(afterIdle).last?.warm, false);
  const broken = [...healthy, call(2000, { input: 2, cacheRead: 0, cacheWrite: 51_000 })];
  const health = cacheHealth(broken);
  assert.equal(health.level, "bad");
  assert.match(health.reasons[0] ?? "", /read nothing from the cache/);
  const low = [...healthy, call(2000, { input: 200, cacheRead: 40_000, cacheWrite: 11_000 })];
  assert.equal(cacheHealth(low).level, "warn", "a 78% hit and a 21% cache write are unusual");
  assert.deepEqual(cacheHealth(low).totals, { input: 50_400, output: 30, cacheRead: 90_000, cacheWrite: 11_300, cost: 0.03 });
  assert.equal(cacheHealth([...healthy, call(2000, { input: 60_000, cacheRead: 0, cacheWrite: 0 }, "other")]).level, "ok", "a model switch starts a new cache");
});

test("slash menu matches skills without the skill: prefix and by description", () => {
  const commands: Command[] = [
    { name: "compact", source: "session", description: "Compact the session context" },
    { name: "skill:poteto-mode", source: "skill", description: "poteto's agent style" },
    { name: "skill:how", source: "skill", description: "Explain how a subsystem works" },
    { name: "skill:swarm", source: "skill", description: "parallel fan-out" },
  ];
  assert.deepEqual(matchCommands(commands, "poteto").map(command => command.name), ["skill:poteto-mode"]);
  assert.deepEqual(matchCommands(commands, "skill:p").map(command => command.name), ["skill:poteto-mode"]);
  assert.deepEqual(matchCommands(commands, "how").map(command => command.name), ["skill:how"]);
  assert.deepEqual(matchCommands(commands, "fan-out").map(command => command.name), ["skill:swarm"], "description matches come last");
  assert.deepEqual(matchCommands(commands, "co").map(command => command.name), ["compact"]);
  assert.equal(matchCommands(commands, "").length, 4);
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
