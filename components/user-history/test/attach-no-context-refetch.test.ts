// Guards the 10-18 08:40 to 08:47Z incident: a kept Mac tunnel took 7 to 22 MB right after each 1 to 3 KB request, 123 MB in 98 s before a restart. Each read of an attached session's snapshot after one of its events had come asked the daemon for get_messages and get_session_context, each the whole context with every image, past the relay's slim; on a box scratch thread that was two 7.7 MB answers where the slim attach snapshot was 0.18 MB.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a11ba8-0000-7000-8000-000000000001";
const ACTIVE = "5f62f184170b";

test("a working session's open and its resyncs read the snapshots the daemon sent and never ask for the whole context again", async t => {
  const dir = await mkdtemp(join(tmpdir(), "no-context-refetch-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T08:40:00.000Z", cwd: dir }) + "\n");
  const state = { sessionId: ID, sessionFile: file, cwd: dir, model: null, thinkingLevel: "off", isStreaming: true, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, messageCount: 1, availableThinkingLevels: ["off"], sessionActions: { queuedCount: 0 } };
  const snapshot = (sequence: number) => ({ activeSessionId: ACTIVE, summary: { sessionId: ID, activeSessionId: ACTIVE, sessionFile: file, cwd: dir, messageCount: 1 }, state,
    messages: [{ role: "user", content: [{ type: "text", text: "i just sent you message feedback, did you miss?" }], timestamp: 1 }],
    lastEventSequence: sequence, lastEventCursor: { generation: "g1", sequence } });
  const event = (sequence: number) => JSON.stringify({ type: "session_event", activeSessionId: ACTIVE, meta: { sequence, cursor: { generation: "g1", sequence } },
    event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "on it" }] }, assistantMessageEvent: { type: "text_delta", delta: "on it" } } }) + "\n";
  const asked: string[] = [];
  let attached: Socket | undefined;
  const socketPath = join(dir, "mac.sock");
  const daemon = createServer(socket => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30, serverCapabilities: [], appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string; command?: { type: string } };
        buffer = buffer.slice(newline + 1);
        const type = (wire.type === "command" ? wire.command! : wire as { type: string }).type;
        if (type === "ack_result") continue;
        asked.push(type);
        const data = type === "attach" ? { activeSessionId: ACTIVE, snapshot: snapshot(1), lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } }
          : type === "get_queue" ? { steering: [], followUp: [] } : type === "get_messages" ? { messages: [] } : type === "get_session_context" ? { context: { messages: [] } } : state;
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
        // The session works: an event follows its attach snapshot at once, as a reply's tokens do.
        if (type === "attach") { attached = socket; socket.write(event(2)); }
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 1 }),
    hostOf: () => "mac", localFile: async (summary: { sessionFile: string }) => summary.sessionFile, socketPathFor: () => socketPath, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); daemon.close(); });

  const thread = await hub.open(ID);
  assert.ok(thread.live, "the thread attached");
  attached!.write(JSON.stringify({ type: "session_resynced", activeSessionId: ACTIVE, snapshot: snapshot(3), meta: { sequence: 3, cursor: { generation: "g1", sequence: 3 } } }) + "\n" + event(4));
  await new Promise(resolve => setTimeout(resolve, 500));

  assert.deepEqual(asked.filter(type => type === "get_messages" || type === "get_session_context"), [], `the box asked ${asked.join(", ")}`);
});
