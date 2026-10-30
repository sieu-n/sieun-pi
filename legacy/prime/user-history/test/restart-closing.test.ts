// Guards the check-in's job restarts that failed with "Active session ... is closing": 57 lines from 10-17 to 10-27 in us-metal02's service.log,
// such as "chat 01a1164b: check-in could not restart job update never empties the box: Active session be55fae2d141 is closing" (10-27 14:37Z).
// A restart aborts, prompts and resumes the queue; each call that meets a close now waits it out and goes again, also when get_state reads the
// closing session fine and the call after the wait meets the close once more.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a17daa-5f0e-7aa1-9f3c-2d1e3b4c5d6e";
const ACTIVE = "be55fae2d141";

/** A daemon whose session is closing: each command type in `refuse` is refused with "is closing" that many times, while get_state reads fine. */
async function closingDaemon(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "restart-closing-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-27T14:30:00.000Z", cwd: dir }) + "\n");
  const calls: string[] = [];
  const refuse = new Map<string, number>();
  const socketPath = join(dir, "daemon.sock");
  const daemon = createServer(socket => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30, serverCapabilities: ["session_input_admission", "prompt_admission_cancellation", "owned_prompt_cancellation"], appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string; command?: { type: string } };
        buffer = buffer.slice(newline + 1);
        const type = (wire.type === "command" ? wire.command! : wire as { type: string }).type;
        if (type === "ack_result") continue;
        calls.push(type);
        const left = refuse.get(type) ?? 0;
        if (left > 0) {
          refuse.set(type, left - 1);
          socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: false, error: `Active session ${ACTIVE} is closing` }) + "\n");
          continue;
        }
        const state = { sessionId: ID, sessionFile: file, cwd: dir, model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, isBashRunning: false,
          isSessionActive: false, retryAttempt: 0, messageCount: 1, availableThinkingLevels: ["off"], sessionActions: { queuedCount: 0 } };
        const snapshot = { activeSessionId: ACTIVE, summary: { sessionId: ID, activeSessionId: ACTIVE, sessionFile: file, cwd: dir, messageCount: 1 }, state,
          messages: [], lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } };
        const data = type === "attach" ? { activeSessionId: ACTIVE, snapshot, lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } }
          : type === "get_queue" ? { steering: [], followUp: [] } : type === "get_messages" ? { messages: [] } : type === "get_session_context" ? { context: { messages: [] } }
          : type === "get_state" ? state : {};
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  const client = new DaemonClient(socketPath);
  let connected: Promise<unknown> | undefined;
  const catalog = { client, connect: () => connected ??= client.connect(2000).then(() => client.waitForHello(2000)), summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 1 }),
    hostOf: () => null, isOtherHost: () => false, localFile: async (summary: { sessionFile: string }) => summary.sessionFile, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(socketPath, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); client.close(); daemon.close(); });
  await hub.open(ID);
  calls.length = 0;
  return { hub, calls, refuse };
}

const count = (calls: readonly string[], type: string) => calls.filter(call => call === type).length;

test("a restart whose prompt meets the close twice waits it out and sends the prompt", async t => {
  const { hub, calls, refuse } = await closingDaemon(t);
  refuse.set("prompt", 2);
  await hub.restart(ID, "continue", true);
  assert.equal(count(calls, "prompt"), 3, calls.join(", "));
});

test("a restart whose abort meets the close twice waits it out and aborts", async t => {
  const { hub, calls, refuse } = await closingDaemon(t);
  refuse.set("abort", 2);
  await hub.restart(ID, "continue", true);
  assert.equal(count(calls, "abort"), 3, calls.join(", "));
  assert.equal(count(calls, "prompt"), 1, calls.join(", "));
});

test("a restart whose queue resume meets the close twice waits it out and resumes the queue", async t => {
  const { hub, calls, refuse } = await closingDaemon(t);
  refuse.set("resume_queue", 2);
  await hub.restart(ID, "continue", true);
  assert.equal(count(calls, "resume_queue"), 3, calls.join(", "));
  assert.equal(count(calls, "prompt"), 1, calls.join(", "));
});
