// Replays two dirty d7 minutes on us-metal02 on 10-21 whose call met a worker that was stopping or starting, and failed:
// 13:21Z, the reload of job 01a15c11 (alert bridge clean day) right after its check-in resumed it: "job 01a15c11: reload: Session worker is stopping";
// 11:21Z, in the restore after a Prime update, the check-in restart of chat 01a14d31 (metal-management): "chat 01a14d31: restart: Session worker is starting".
// The supervisor refuses those calls before a worker takes them, so the call waits until get_state answers and goes once more.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a15c11-e24a-73d3-a864-32f8de3513cd";
const ACTIVE = "5c11e24a73d3";
let refuseNext: (n: number) => void = () => {};
const idle = { isSessionActive: false, isStreaming: false, isCompacting: false, isBashRunning: false };

/** A daemon whose session worker is moving for its first `refusals` calls: each refuses with `Session worker is <doing>`. */
async function movingDaemon(t: { after(fn: () => unknown): void }, doing: "stopping" | "starting", refusals: number) {
  const dir = await mkdtemp(join(tmpdir(), "worker-move-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-21T13:20:00.000Z", cwd: dir }) + "\n");
  const calls: string[] = [];
  let left = refusals;
  refuseNext = n => { left = n; };
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
        if (left > 0) { left--; socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: false, error: `Session worker is ${doing}` }) + "\n"); continue; }
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
  return { hub, calls };
}

test("a job reload that meets a stopping worker waits it out and reloads", async t => {
  const { hub, calls } = await movingDaemon(t, "stopping", 2);
  assert.equal(await hub.reloadIdle(ID), "reloaded");
  assert.deepEqual(calls, ["get_state", "get_state", "get_state", "get_state", "reload"], "the refused busy read, a refused and a good read during the wait, then the reload asked once more");
});

test("a restart prompt that meets a starting worker waits it out and is sent once", async t => {
  const { hub, calls } = await movingDaemon(t, "starting", 0);
  await hub.open(ID);
  calls.length = 0;
  refuseNext(1);
  await hub.restart(ID, "continue");
  assert.equal(calls.filter(call => call === "prompt").length, 2, "the refused prompt and the one that went through");
  assert.ok(calls.indexOf("get_state") > calls.indexOf("prompt"), "the wait read get_state after the refusal");
});
