// Guards Prime load-h (10-27): its daemon counts only queued input against the pending message limit and says so with
// `sessionActions.queuedCount` and `queuedLanes`. The agent outbox reads that count for room when the daemon sends `queuedLanes`, and keeps
// `unfinishedActionCount` for an older daemon, whose `queuedCount` leaves out the actions it still holds against the limit.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { targetStateOf } from "../src/send-once.ts";

const TARGET = "01a115e2-4b8e-7d2c-9f31-6a0c2e5d8b17";

/** get_state data as a load-h daemon answers it: 22 unfinished actions, of which 3 queued steers count against the limit. */
const NEW_DAEMON = { isStreaming: true, isCompacting: false, isRunningTools: true, unfinishedActionCount: 22,
  sessionActions: { queuedCount: 3, queuedLanes: { steering: 3, followUp: 0 }, steering: ["a", "b", "c"], followUps: [] } };
/** get_state data as crc.2 answers it: no queuedLanes, and queuedCount reads the visible queue while 22 actions count against the limit. */
const OLD_DAEMON = { isStreaming: true, isCompacting: false, isRunningTools: false, unfinishedActionCount: 22,
  sessionActions: { queuedCount: 3, steering: ["a", "b", "c"], followUps: [] } };

test("targetStateOf reads the limit's count from queuedCount when the daemon sends queuedLanes, else from unfinishedActionCount", () => {
  assert.deepEqual(targetStateOf(NEW_DAEMON), { queued: ["a", "b", "c"], busy: true, unfinished: 3 });
  assert.deepEqual(targetStateOf(OLD_DAEMON), { queued: ["a", "b", "c"], busy: true, unfinished: 22 });
  assert.deepEqual(targetStateOf({ isStreaming: false, sessionActions: { queuedCount: 0, queuedLanes: { steering: 0, followUp: 0 } } }), { queued: [], busy: false, unfinished: 0 });
  assert.deepEqual(targetStateOf({ unfinishedActionCount: 2, sessionActions: { queuedCount: 0, queuedLanes: { steering: 0, followUp: 0 } } }),
    { queued: [], busy: true, unfinished: 0 }, "running actions keep the worker busy but take no slot");
  assert.deepEqual(targetStateOf(undefined), { queued: [], busy: false });
});

async function outbox(t: TestContext, data: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-room-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [], lines: string[] = [], reads = { count: 0 };
  const box = new AgentOutbox(join(dir, "agent-outbox"), { log: line => { lines.push(line); }, sleep: () => new Promise(resolve => setTimeout(resolve, 2)),
    send: async (_session, text) => { sent.push(text); return "sent"; }, target: async () => { reads.count++; return targetStateOf(data); }, fileOf: async () => null });
  t.after(() => box.close());
  return { box, sent, lines, reads };
}

test("a send the daemon refused as full goes out once a load-h daemon reads 3 queued, though 22 actions are unfinished", async t => {
  const { box, sent, lines } = await outbox(t, NEW_DAEMON);
  const receipt = await box.queue({ session: TARGET, text: "report", from: { id: "01a11d24-ac9b-757d-ac51-9b2b7598782f", name: "ops guy" }, role: "sibling",
    behind: false, pending: 20, limit: 20 });
  assert.equal(receipt.deliveryStatus, "queued");
  await box.outbox.idle();
  assert.equal(sent.length, 1);
  assert.ok(lines.some(line => line.includes("the target has room, 3 of 20 unfinished")), lines.join("\n"));
});

test("an older daemon's 22 unfinished actions still hold the send, whatever its queuedCount reads", async t => {
  const { box, sent, reads } = await outbox(t, OLD_DAEMON);
  await box.queue({ session: TARGET, text: "report", from: { id: "01a11d24-ac9b-757d-ac51-9b2b7598782f", name: "ops guy" }, role: "sibling", behind: false, pending: 20, limit: 20 });
  for (let i = 0; i < 400 && reads.count < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(reads.count >= 4, "the outbox read get_state for room again and again");
  assert.equal(sent.length, 0);
});
