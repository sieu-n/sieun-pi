// Guards 12:32:33Z on 10-18 on us-metal02: the check of job 01a14efc opened it while its worker was stopping, the supervisor refused the attach
// with "Session worker is stopping", the worker exited 0.24 s later, and the open, the job's wake and the supervisor's line each counted a fault.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonAgentConnection, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const JOB = "01a14efc-5f0e-7aa1-9f3c-2d1e3b4c5d6e";

test("an open refused for a stopping worker waits until get_state reads the session gone, then attaches once and reads it saved", async t => {
  const dir = await mkdtemp(join(tmpdir(), "open-moving-"));
  await writeFile(join(dir, JOB + ".jsonl"), JSON.stringify({ type: "session", version: 3, id: JOB, timestamp: "2026-10-18T12:20:00.000Z", cwd: dir }) + "\n");
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  const calls: string[] = [];
  let exited = false;
  t.mock.method(DaemonAgentConnection, "attach", async (_client: unknown, activeSessionId: string) => {
    calls.push("attach");
    throw new Error(exited ? `Unknown active session: ${activeSessionId}` : "Session worker is stopping");
  });
  const client = { request: async (command: { type: string; activeSessionId: string }) => {
    calls.push(command.type);
    const answer = exited ? { success: false, error: `Unknown active session: ${command.activeSessionId}` } : { success: false, error: "Session worker is stopping" };
    exited = true;
    return answer;
  } };
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: "24d32cb90371", workerState: "ready", sessionFile: join(dir, id + ".jsonl"),
    cwd: dir, lifecycle: "live", messageCount: 0 }), hostOf: () => null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    connect: async () => {}, client, refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());

  assert.equal(await hub.view(JOB), null);
  assert.deepEqual(calls, ["attach", "get_state", "get_state", "attach"]);
});
