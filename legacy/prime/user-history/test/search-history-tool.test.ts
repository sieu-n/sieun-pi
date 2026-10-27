// search_history in every Prime session (packages/pi-history API.md, "Agent tool"): the tool passes its session as the caller, so the socket
// answers with that session's chat family only, and read=<ref> returns the messages around a hit.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../../../../packages/pi-history/src/server.ts";
import { makeIndex } from "../../../../packages/pi-history/test/fixture.ts";

const CHAT = "01a10001-0000-7000-8000-000000000000";
const JOB = "01a10002-0000-7000-8000-000000000000";
const OTHER = "01a10003-0000-7000-8000-000000000000";
const at = Date.parse("2026-10-23T13:20:00Z");

test("search_history answers one line per hit from the caller's chat family, and read=<ref> the messages around it", async t => {
  const root = mkdtempSync(join(tmpdir(), "search-history-tool-"));
  const saved = { ...process.env };
  Object.assign(process.env, { PRIME_AGENT_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_CHAT_DATA_DIR: root,
    SIEUN_PI_HOSTS: join(root, "no-hosts.json"), PI_HISTORY_SOCKET: join(root, "history.sock") });
  writeFileSync(join(root, "chat-jobs.json"), JSON.stringify({ jobs: { [JOB]: { chat: "frontend bro", chatId: CHAT } } }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({ box: "us-metal02", peers: join(root, "no-hosts.json"), durableIndexes: [] }));
  makeIndex(join(root, "history.db"), [{ session: CHAT, name: "frontend bro" }, { session: JOB, name: "relay timeout job" }, { session: OTHER, name: "crawler VP" }], [
    { session: CHAT, at, kind: "user", text: "why did the relay time out?" },
    { session: JOB, at: at + 1000, kind: "tool_result", tool: "bash", text: "relay mac did not answer in 15000 ms" },
    { session: OTHER, at: at + 2000, kind: "assistant", text: "relay notes from another chat" },
  ]).close();
  const history = await startServer({ dbPath: join(root, "history.db"), socket: join(root, "history.sock"), settingsFile: join(root, "settings.json") });
  t.after(async () => { await history.close(); process.env = saved; rmSync(root, { recursive: true, force: true }); });

  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const pi = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) => { tools.set(tool.name, tool); }
    : () => undefined });
  const { default: historyExtension } = await import("../extension/index.ts");
  historyExtension(pi as never);
  const tool = tools.get("search_history");
  assert.ok(tool, "the extension registers search_history");
  const ctx = { sessionManager: { getSessionId: () => JOB, getSessionFile: () => join(root, "agent", "sessions", `${JOB}.jsonl`) } };

  const found = (await tool.execute("call-1", { query: "relay" }, undefined, undefined, ctx)).content[0]!.text;
  const lines = found.split("\n");
  assert.match(lines[0]!, /^2 of 2 hits, [\d.]+ ms, scope family\.$/);
  assert.match(lines[1]!, /^2026-10-23 13:20Z us-metal02 relay timeout job \(01a10002\) tool_result \(bash\): relay mac did not answer in 15000 ms ref=us-metal02:01a10002-[^@]+@\d+#\d+$/);
  assert.match(lines[2]!, /frontend bro \(01a10001\) user: why did the relay time out\?/);
  assert.doesNotMatch(found, /another chat/);

  const ref = /ref=(\S+)/.exec(lines[1]!)![1]!;
  const read = (await tool.execute("call-2", { read: ref, query: "" }, undefined, undefined, ctx)).content[0]!.text;
  assert.match(read, /^us-metal02 relay timeout job/);
  assert.match(read, /> 2026-10-23 13:20Z \S* tool_result \(bash\): relay mac did not answer in 15000 ms/);
});
