import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The scenario reads ~/.prime/agent from HOME at import, so the fixture home is set first.
const home = mkdtempSync(join(tmpdir(), "chat-tools-reopen-"));
process.env.HOME = home;
process.env.AGENT_CHAT_DATA_DIR = join(home, ".prime/agent/browser-chat");
const { chatToolsReopen, EXPECTED_TOOLS, FOLLOW_UP, TASK } = await import("../scripts/clean-room/chat-tools-reopen.ts");

const chat = "01a14c00-0000-7000-8000-000000000001";
const at = (minute: number): string => new Date(Date.parse("2026-10-17T22:00:00.000Z") + minute * 60_000).toISOString();
const line = (minute: number, fields: Record<string, unknown>): string => JSON.stringify({ timestamp: at(minute), ...fields });
const user = (minute: number, text: string) => line(minute, { type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const call = (minute: number, id: string, name: string) => line(minute, { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: {} }] } });
const result = (minute: number, id: string, error = false, text = "ok") => line(minute, { type: "message", message: { role: "toolResult", toolCallId: id, isError: error, content: [{ type: "text", text }] } });
const stop = (minute: number) => line(minute, { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });

function runFolder(name: string, lines: string[], tools: string[], rev: number) {
  mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
  writeFileSync(join(home, ".prime/agent/sessions", `${chat}.jsonl`), lines.join("\n") + "\n");
  mkdirSync(join(home, ".prime/agent/browser-chat/boards"), { recursive: true });
  writeFileSync(join(home, ".prime/agent/browser-chat/boards", `${chat}.json`), JSON.stringify({ rev, plan: [], todos: [] }));
  const run = join(home, name);
  mkdirSync(join(run, "prompts", chat), { recursive: true });
  writeFileSync(join(run, "archive.json"), JSON.stringify({ at: Date.parse(at(10)), lines: 7, rev: 2, idle: "idle: last reply stopped" }));
  writeFileSync(join(run, "prompts", chat, "1.json"), JSON.stringify({ capturedAt: at(21), payload: { instructions: "This session is a chat.", tools: tools.map(tool => ({ name: tool })) } }));
  return run;
}
const before = [line(0, { type: "custom", customType: "chat_mode", data: { v: 1 } }), user(0, TASK), call(1, "a", "chat_board"), result(1, "a"), call(2, "b", "tell_owner"), result(2, "b"), stop(3),
  line(10, { type: "session_state", state: { status: "archived" } })];
const state = { scenario: "chat-tools-reopen", chat: { id: chat, name: "test counts" }, fixtures: {}, sandbox: home, everyMs: 7_200_000, release: "release-x",
  board: "", seeds: [TASK, FOLLOW_UP], setupAt: Date.parse(at(0)), windowStart: Date.parse(at(0)) };

test("a chat that keeps its five tools and uses chat_board and tell_owner again after the reopen passes", async () => {
  const run = runFolder("pass", [...before, user(20, FOLLOW_UP), call(21, "c", "chat_board"), result(21, "c"), call(22, "d", "tell_owner"), result(22, "d"), stop(23)], EXPECTED_TOOLS, 3);
  const { verdict, text } = await chatToolsReopen.evaluate(run, state);
  assert.equal(verdict, "pass", text);
});

test("a reopen with chat_board missing, or a continue between archive and reopen, fails", async () => {
  const lost = runFolder("lost", [...before, user(20, FOLLOW_UP), call(21, "c", "chat_board"), result(21, "c", true, "Tool chat_board not found"), stop(23)],
    EXPECTED_TOOLS.filter(tool => tool !== "chat_board"), 2);
  const judged = await chatToolsReopen.evaluate(lost, state);
  assert.equal(judged.verdict, "fail");
  assert.match(judged.text, /7\. not met: tools offered: ipython, tell_owner, correction_add, poteto_mode/);
  const woken = runFolder("woken", [...before, user(15, "continue"), stop(16), user(20, FOLLOW_UP)], EXPECTED_TOOLS, 2);
  assert.match((await chatToolsReopen.evaluate(woken, state)).text, /3\. not met: .*user "continue"/);
  rmSync(home, { recursive: true, force: true });
});
