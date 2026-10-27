// Guards the 10-18 07:38Z to 08:01Z incident: frontend bro's attach from the Mac timed out 17 times, because its 9.9 MB snapshot came at 0.26 to 1.4 MB/s and the SDK gives a snapshot 30 s.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonAgentConnection, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

test("an attach to another box's session waits minutes for its snapshot, and this box's keeps the SDK's 30 s", async t => {
  const dir = await mkdtemp(join(tmpdir(), "remote-snapshot-"));
  const ids = { mac: "01a11ba8-0000-7000-8000-000000000001", box: "01a11ba8-0000-7000-8000-000000000002" };
  for (const id of Object.values(ids)) await writeFile(join(dir, id + ".jsonl"), JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-18T07:00:00.000Z", cwd: dir }) + "\n");
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  const timeouts = new Map<string, number | undefined>();
  t.mock.method(DaemonAgentConnection, "attach", async (_client: unknown, activeSessionId: string, options: { snapshotTimeoutMs?: number }) => {
    timeouts.set(activeSessionId, options.snapshotTimeoutMs);
    throw new Error("Unknown active session: " + activeSessionId);
  });
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: id === ids.mac ? "mac-worker" : "box-worker", workerState: "ready",
    sessionFile: join(dir, id + ".jsonl"), cwd: dir, lifecycle: "live", messageCount: 0 }),
    hostOf: (id: string) => id === ids.mac || id === "mac-worker" ? "mac" : null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    socketPathFor: () => join(dir, "mac.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await hub.open(ids.mac);
  await hub.open(ids.box);

  assert.ok((timeouts.get("mac-worker") ?? 0) >= 120_000, `the Mac attach's snapshot gets ${timeouts.get("mac-worker")} ms`);
  assert.equal(timeouts.get("box-worker"), undefined);
});
