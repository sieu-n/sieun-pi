// Guards 10-18 12:04Z to 12:22Z: two Mac attaches waiting 5 min for their snapshots held both background slots, and us-metal02's pins waited 43 to 218 s behind them.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonAgentConnection, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

test("a background attach on this box starts while two Mac attaches still wait for their snapshots", async t => {
  const dir = await mkdtemp(join(tmpdir(), "attach-lanes-"));
  const ids = { mac1: "01a11ba8-0000-7000-8000-000000000001", mac2: "01a14ebf-0000-7000-8000-000000000002", box: "01a14ede-0000-7000-8000-000000000003" };
  for (const id of Object.values(ids)) await writeFile(join(dir, id + ".jsonl"), JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-18T12:00:00.000Z", cwd: dir }) + "\n");
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  let release!: (error: Error) => void;
  const stuck = new Promise<never>((_, reject) => { release = reject; });
  stuck.catch(() => {});
  const attached: string[] = [];
  t.mock.method(DaemonAgentConnection, "attach", async (_client: unknown, activeSessionId: string) => {
    attached.push(activeSessionId);
    if (activeSessionId.startsWith("mac")) return stuck;
    throw new Error("Unknown active session: " + activeSessionId);
  });
  const worker = (id: string) => id === ids.mac1 ? "mac-1" : id === ids.mac2 ? "mac-2" : "box-1";
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: worker(id), workerState: "ready",
    sessionFile: join(dir, id + ".jsonl"), cwd: dir, lifecycle: "live", messageCount: 0 }),
    hostOf: (id: string) => id === ids.mac1 || id === ids.mac2 ? "mac" : null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    socketPathFor: () => join(dir, "mac.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => { release(new Error("Timed out waiting for snapshot")); hub.close(); });
  void hub.open(ids.mac1, true).catch(() => {});
  void hub.open(ids.mac2, true).catch(() => {});
  while (attached.length < 2) await new Promise(done => setTimeout(done, 5));
  assert.deepEqual([...attached].sort(), ["mac-1", "mac-2"]);
  const box = hub.open(ids.box, true).then(() => "opened");
  const waited = await Promise.race([box, new Promise(done => setTimeout(() => done("still queued"), 2000))]);

  assert.equal(waited, "opened", `attaches so far: ${attached.join(", ")}`);
});
