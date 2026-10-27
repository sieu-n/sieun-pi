// Guards 05:00:03Z on 10-27: one worker took 5886 ms over get_model_catalog, so api/models held a thread's model picker that long and d7 counted the minute dirty. After the first catalog each read answers from it and reads a new one behind it.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a1164b-0000-7000-8000-000000000001";
const ACTIVE = "0710b875bb3a";
const model = (id: string) => ({ provider: "anthropic", id, name: id, api: "anthropic-messages", baseUrl: "", input: ["text"], contextWindow: 200000, maxTokens: 64000,
  reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

test("a thread's model picker answers from the last catalog while a busy worker reads the next one", async t => {
  const dir = await mkdtemp(join(tmpdir(), "models-catalog-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-27T05:00:00.000Z", cwd: dir }) + "\n");
  const state = { sessionId: ID, sessionFile: file, cwd: dir, model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, messageCount: 0, availableThinkingLevels: ["off"], sessionActions: { queuedCount: 0 } };
  const snapshot = { activeSessionId: ACTIVE, summary: { sessionId: ID, activeSessionId: ACTIVE, sessionFile: file, cwd: dir, messageCount: 0 }, state, messages: [],
    lastEventSequence: 0, lastEventCursor: { generation: "g1", sequence: 0 } };
  let catalogs = 0;
  const held: (() => void)[] = [];
  const socketPath = join(dir, "daemon.sock");
  const daemon = createServer(socket => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30, serverCapabilities: ["model_catalog"], appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string; command?: { type: string } };
        buffer = buffer.slice(newline + 1);
        const type = (wire.type === "command" ? wire.command! : wire as { type: string }).type;
        if (type === "ack_result") continue;
        const answer = (data: unknown) => socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
        if (type === "get_model_catalog") {
          catalogs++;
          const data = { models: [model(catalogs === 1 ? "claude-opus-4-5" : "claude-opus-5-5")], configuredProviders: ["anthropic"] };
          if (catalogs === 1) answer(data); else held.push(() => answer(data));
          continue;
        }
        answer(type === "attach" ? { activeSessionId: ACTIVE, snapshot, lastEventSequence: 0, lastEventCursor: { generation: "g1", sequence: 0 } }
          : type === "get_queue" ? { steering: [], followUp: [] } : state);
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 0 }),
    hostOf: () => null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile, socketPathFor: () => socketPath, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(socketPath, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { for (const release of held) release(); await hub.close(); daemon.close(); });

  assert.ok((await hub.open(ID)).live, "the thread attached");
  assert.deepEqual((await hub.models(ID)).models.map(entry => entry.id), ["claude-opus-4-5"]);
  const waited = Symbol("waited");
  const second = await Promise.race([hub.models(ID), new Promise(resolve => setTimeout(resolve, 500, waited))]);
  assert.notEqual(second, waited, "the read waited on the worker's catalog");
  assert.deepEqual((second as { models: { id: string }[] }).models.map(entry => entry.id), ["claude-opus-4-5"]);
  assert.equal(catalogs, 2, "the read asked for a new catalog behind its answer");
  held.shift()!();
  await new Promise(resolve => setTimeout(resolve, 50));
  const third = await Promise.race([hub.models(ID), new Promise(resolve => setTimeout(resolve, 500, waited))]);
  assert.deepEqual((third as { models: { id: string }[] }).models.map(entry => entry.id), ["claude-opus-5-5"], "the next read carries the new catalog");
});
