// 10-27: the :5183 canary on pi-host read the corrections ledger in its own data dir, which is empty, so its sessions got no corrections
// block. pi-host and the canary set AGENT_CHAT_SHARED_DIR to the live chat's data dir, whose corrections.json prime-sync keeps, and read it
// without writing it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_FLAG } from "../src/chat-guard.ts";

const CHAT = "01a17e5d-911d-7707-ae6f-12e3c2b90c46";
const RULE = "Every canary session reads the owner's ledger.";

test("a canary chat session gets the shared ledger's corrections and cannot write that ledger", async t => {
  const root = mkdtempSync(join(tmpdir(), "canary-corrections-"));
  const agentDir = join(root, "agent");
  const data = join(root, "browser-chat-pi");
  const shared = join(root, "browser-chat");
  mkdirSync(data, { recursive: true });
  mkdirSync(shared, { recursive: true });
  const ledger = { corrections: [{ id: "c900", at: "2026-10-27T10:00:00.000Z", words: "canary reads the ledger", rule: RULE, theme: "canary",
    enforcedBy: "brief", ref: "pending", status: "active", chat: { id: "x", name: "x" }, repeats: [] }] };
  writeFileSync(join(shared, "corrections.json"), JSON.stringify(ledger));
  const saved = { ...process.env };
  Object.assign(process.env, { PRIME_AGENT_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, AGENT_CHAT_DATA_DIR: data,
    AGENT_CHAT_SHARED_DIR: shared, SIEUN_PI_HOSTS: join(root, "no-hosts.json") });
  t.after(() => { process.env = saved; rmSync(root, { recursive: true, force: true }); });
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const entries: unknown[] = [];
  const pi = new Proxy({}, { get: (_target, key) => key === "on" ? (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); }
    : key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(tool.name, tool); }
    : key === "getFlag" ? (flag: string) => flag === CHAT_FLAG ? true : undefined
    : key === "appendEntry" ? (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); }
    : key === "getActiveTools" ? () => [] : () => undefined });
  const { default: historyExtension } = await import("../extension/index.ts");
  historyExtension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => CHAT, getHeader: () => ({ type: "session", id: CHAT }), getBranch: () => [], getEntries: () => entries,
    getSessionName: () => "chat-6694", getSessionFile: () => join(root, "s.jsonl") } };
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  let messages: unknown[] = [{ role: "user", content: "hello", timestamp: Date.parse("2026-10-27T17:17:00Z") }];
  for (const handler of handlers.get("context") ?? []) {
    const result = await handler({ type: "context", messages }, ctx) as { messages?: unknown[] } | undefined;
    if (result?.messages) messages = result.messages;
  }
  assert.match(JSON.stringify(messages), /c900 Every canary session reads the owner's ledger\./, "the shared rule reaches the chat's context");
  const answer = await tools.get("correction_add")!.execute("call-1", { words: "w", rule: "r", theme: "t", enforcedBy: "brief", ref: "pending" }, undefined, undefined, ctx);
  assert.match(answer.content[0]!.text, /^Not recorded/);
  assert.deepEqual(JSON.parse(readFileSync(join(shared, "corrections.json"), "utf8")), ledger, "the shared ledger is unchanged");
});
