// Guards 18:57:35Z on 10-30 on us-metal02: the idle unload was stopping job 01a18e22 (bundle bound at commit) while its wake opened it. The
// attach met "Active session 73eb82401fc1 is closing", get_state answered after 174 ms, the one retry met "is closing" again, and the open and
// the job's wake failed: "open 01a18e22 saved 91 messages: ... worker closing, waited 174ms, queue 0ms, failed: Active session 73eb82401fc1 is
// closing". The open now waits again until the attach meets no close.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonAgentConnection, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { afterMove } from "../src/worker-move.ts";

const JOB = "01a18e22-e3ba-7308-aed1-95317d08ca94";
const ACTIVE = "73eb82401fc1";
const CLOSING = `Active session ${ACTIVE} is closing`;

test("a retry that meets the close again waits once more and then runs, while get_state reads the closing session fine", async () => {
  const calls: string[] = [];
  let refusals = 2;
  const slept: number[] = [];
  const result = await afterMove(async () => {
    calls.push("act");
    if (refusals-- > 0) throw new Error(CLOSING);
    return "opened";
  }, async () => { calls.push("get_state"); return { success: true, data: {} }; }, doing => calls.push(`waited ${doing}`), async ms => { slept.push(ms); });
  assert.equal(result, "opened");
  assert.deepEqual(calls, ["act", "get_state", "waited closing", "act", "get_state", "waited closing", "act"]);
  assert.deepEqual(slept, [1_000]);
});

test("an open whose retry meets the close again opens once the close ends, so the job's wake reads it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "open-closing-"));
  await writeFile(join(dir, JOB + ".jsonl"), JSON.stringify({ type: "session", version: 3, id: JOB, timestamp: "2026-10-30T18:50:00.000Z", cwd: dir }) + "\n");
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  const calls: string[] = [];
  let closing = 2;
  t.mock.method(DaemonAgentConnection, "attach", async (_client: unknown, activeSessionId: string) => {
    calls.push("attach");
    throw new Error(closing-- > 0 ? CLOSING : `Unknown active session: ${activeSessionId}`);
  });
  const client = { request: async (command: { type: string }) => { calls.push(command.type); return { success: true, data: { isSessionActive: false } }; } };
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: join(dir, id + ".jsonl"),
    cwd: dir, lifecycle: "live", messageCount: 0 }), hostOf: () => null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    connect: async () => {}, client, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());

  assert.equal(await hub.view(JOB), null);
  assert.deepEqual(calls, ["attach", "get_state", "attach", "get_state", "attach"]);
});
