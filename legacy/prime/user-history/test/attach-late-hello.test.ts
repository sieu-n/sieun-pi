// Guards the 10-18 job wakes that failed on a late hello from this box's daemon: open 01a14fef near 17:09:25Z read "failed: Timed out after
// 3000ms waiting for the Prime Agent daemon handshake. Socket: /tmp/prime-agent-1001/daemon.sock", and 01a14f62 the same near 16:14:33Z, each
// while the supervisor was between a worker's crash and its "Recovered worker" line. The attach after the hello may take 30 s, so the hello may too.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a14fef-0000-7000-8000-000000000001";
const ACTIVE = "65760f41f9aa";

test("an open attaches when this box's daemon sends its hello 3.5 s late", async t => {
  const dir = await mkdtemp(join(tmpdir(), "late-hello-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T17:09:25.000Z", cwd: dir }) + "\n");
  const state = { sessionId: ID, sessionFile: file, cwd: dir, model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, messageCount: 1, availableThinkingLevels: ["off"], sessionActions: { queuedCount: 0 } };
  const snapshot = { activeSessionId: ACTIVE, summary: { sessionId: ID, activeSessionId: ACTIVE, sessionFile: file, cwd: dir, messageCount: 1 }, state,
    messages: [{ role: "user", content: [{ type: "text", text: "wake for run 39144476359" }], timestamp: 1 }],
    lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } };
  const socketPath = join(dir, "daemon.sock");
  const daemon = createServer(socket => {
    socket.on("error", () => {});
    setTimeout(() => socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30,
      serverCapabilities: [], appVersion: "0.9.8" }) + "\n"), 3500);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string; command?: { type: string } };
        buffer = buffer.slice(newline + 1);
        const type = (wire.type === "command" ? wire.command! : wire as { type: string }).type;
        if (type === "ack_result") continue;
        const data = type === "attach" ? { activeSessionId: ACTIVE, snapshot, lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } }
          : type === "get_queue" ? { steering: [], followUp: [] } : type === "get_messages" ? { messages: [] } : type === "get_session_context" ? { context: { messages: [] } } : state;
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 1 }),
    hostOf: () => null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(socketPath, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); daemon.close(); });

  const thread = await hub.open(ID);
  assert.ok(thread.live, "the thread attached");
});
