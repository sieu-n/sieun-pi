// Guards d7's loop stalls on us-metal02 on 10-20: a CPU profile of the live chat from 04:36Z to 05:47Z had 10 runs of 0.7 to 1.6 s with no
// loop turn, each the 5-minute save of a box's session copy (19 MB for this box, 39 MB for the Mac), one JSON.stringify of every row.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { SessionPeer } from "../src/session-peer.ts";
import { longestLoopCpu, threadCpu } from "./loop-cpu.ts";

const ROWS = 12_000;
const row = (i: number): SessionSummary => ({ sessionId: `s-${i}`, cwd: "/home/sieun/src/sieun-pi", sessionFile: `/s/${i}.jsonl`, messageCount: i,
  name: `job ${i}`, firstMessage: "x".repeat(1500), modified: "2026-10-20T05:00:00.000Z" }) as unknown as SessionSummary;

function fakeClient(rows: SessionSummary[]): DaemonClient {
  return {
    isConnected: true,
    reconnect: async () => {}, waitForHello: async () => ({ appVersion: "0.9.8" }), resetTransportForReconnect: () => {},
    onMessage: () => () => {}, onClose: () => () => {}, close: () => {},
    request: async (command: { type: string; all?: boolean }) => ({ success: true, data: command.type === "list" ? { sessions: command.all ? rows : [] } : {} }),
  } as unknown as DaemonClient;
}

test("saving a 20 MB session copy gives the event loop a turn after at most a few tens of ms of CPU, and the file reads back the same", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "session-copy-slices-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = Array.from({ length: ROWS }, (_, i) => row(i));
  const onePiece = threadCpu(() => JSON.stringify({ version: 1, fullAt: 1, rows }));
  const file = join(dir, "session-copy.json");
  const peer = new SessionPeer({ name: "box", client: fakeClient(rows), file, deadlines: { socketMs: 1000, helloMs: 1000 }, changeMs: 10_000, reconnectMs: 10_000,
    log: () => {}, onChange: () => {} });
  t.after(() => peer.close());
  await peer.loaded();
  await peer.sync();
  const gap = await longestLoopCpu(() => peer.flushed());
  assert.ok(gap < Math.max(onePiece / 3, 15), `most CPU between loop turns ${gap.toFixed(1)} ms against ${onePiece.toFixed(1)} ms for one stringify`);
  const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; fullAt: number; rows: SessionSummary[] };
  assert.equal(saved.version, 1);
  assert.equal(saved.fullAt, peer.fullAt);
  assert.deepEqual(saved.rows, rows);
});
