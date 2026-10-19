// On 10-19 at 16:22:14-17Z 17 idle unload kills timed out after 30 s on us-metal02, the service log named each by the first 8 characters of
// its session id, and nothing else was written, so rb-p161-p143 (01a154b8-96c6-765e-ac87-ffc09f8fc16d) went archived at 16:22:16Z with no
// record of the unload's ask, and four sessions of tree 01a154b8 matched one log line. Each kill now writes a receipt before it goes out and
// one after its answer, and every unload line names the full session id.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { type DaemonAnswer, IdleUnloader } from "../src/idle-unload.ts";
import { UNLOAD_RECEIPTS, type UnloadReceipt, writeReceipt } from "../src/unloaded.ts";

const MIN = 60_000;
const ID = "01a154b8-96c6-765e-ac87-ffc09f8fc16d";
const row = { id: ID, sessionId: ID, sessionName: "", lifecycle: "live", activeSessionId: ID, workerState: "ready", runtimeKind: "subagent", parentSessionId: "01a154b8-0000-7000-8000-000000000000",
  activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 3, repliedSinceTask: true,
  lastActivityAt: new Date(Date.now() - 3 * MIN).toISOString(), sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as unknown as SessionSummary;

async function sweep(kill: DaemonAnswer) {
  const dir = await mkdtemp(join(tmpdir(), "unload-receipts-"));
  const lines: string[] = [];
  const order: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => [row], localRows: () => [], idleMs: () => 15 * MIN, chats: async () => new Set(), dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async () => new Map(), own: async () => new Map(), restNow: async () => false, release: async () => true, title: () => null,
    request: async (_row, type) => { order.push(type); return type === "get_state" ? { success: true, data: { isSessionActive: false } } : kill; },
    stopped: async () => { order.push("stopped"); },
    receipt: async entry => { order.push(`receipt ${entry.phase}`); await writeReceipt(dir, entry); },
    log: line => lines.push(line), now: () => Date.now(),
  });
  await unloader.sweep();
  await unloader.settled();
  const receipts = (await readFile(join(dir, UNLOAD_RECEIPTS), "utf8")).trim().split("\n").map(line => JSON.parse(line) as UnloadReceipt);
  await rm(dir, { recursive: true, force: true });
  return { lines, order, receipts };
}

test("a kill that times out leaves a sent and a failed receipt with the full session id, and its log line names the full id", async () => {
  const timeout = 'Error: Timed out after 30000ms waiting for the Prime Agent daemon response to "kill".';
  const { lines, order, receipts } = await sweep({ success: false, error: timeout });
  assert.deepEqual(order, ["get_state", "receipt sent", "kill", "receipt failed"], "the sent receipt is on disk before the kill goes out");
  assert.deepEqual(receipts.map(entry => [entry.phase, entry.sessionId, entry.activeSessionId, entry.why]), [["sent", ID, ID, "idle"], ["failed", ID, ID, "idle"]]);
  assert.equal(receipts[1]!.error, timeout);
  assert.ok(lines.some(line => line.startsWith(`idle unload: ${ID}: Error: Timed out`)), lines.join("\n"));
});

test("a kill that lands leaves a sent and a stopped receipt before the stop is recorded", async () => {
  const { order, receipts, lines } = await sweep({ success: true });
  assert.deepEqual(order, ["get_state", "receipt sent", "kill", "receipt stopped", "stopped"]);
  assert.deepEqual(receipts.map(entry => entry.phase), ["sent", "stopped"]);
  assert.ok(lines.some(line => line.includes(ID)), "the sweep line names the session by its full id when it has no name");
});
