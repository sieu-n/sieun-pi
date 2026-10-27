// The :5183 canary chat on pi-host keeps its own data dir, and pi-host runs with AGENT_CHAT_DATA_DIR set to it. On 2026-10-27 the extension
// read only its agent-chat-data-dir flag, which no create sets, so the canary chat's first chat_board call wrote its board into the live
// chat's ~/.prime/agent/browser-chat/boards.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CHAT = "01a17e5d-911d-7707-ae6f-12e3c2b90c46";

test("with no flag the extension keeps a chat's board in AGENT_CHAT_DATA_DIR", async t => {
  const root = mkdtempSync(join(tmpdir(), "chat-data-dir-env-"));
  const agentDir = join(root, "agent");
  const data = join(root, "browser-chat-pi");
  mkdirSync(data, { recursive: true });
  const saved = { ...process.env };
  Object.assign(process.env, { PRIME_AGENT_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, AGENT_CHAT_DATA_DIR: data, SIEUN_PI_HOSTS: join(root, "no-hosts.json") });
  t.after(() => { process.env = saved; rmSync(root, { recursive: true, force: true }); });
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const pi = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => { tools.set(tool.name, tool); }
    : key === "getFlag" ? () => undefined : () => undefined });
  const { default: historyExtension } = await import("../extension/index.ts");
  historyExtension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => CHAT, getHeader: () => ({ type: "session", id: CHAT }), getBranch: () => [], getEntries: () => [] } };
  await tools.get("chat_board")!.execute("call-1", { ops: [{ op: "plan_add", text: "Canary: the check-in reads pi-host schedules" }] }, undefined, undefined, ctx);
  assert.ok(existsSync(join(data, "boards", `${CHAT}.json`)), "the board is in AGENT_CHAT_DATA_DIR");
  assert.ok(!existsSync(join(agentDir, "browser-chat", "boards", `${CHAT}.json`)), "nothing lands in <agent dir>/browser-chat");
});
