// Guards Prime load-h (10-27): its daemon counts only queued input against the pending message limit and adds a top-level `queuedLanes`
// {steering, followUp} to get_state, list and roster rows. The agent outbox reads room from the sum of the lanes when a row carries them, since a
// crc.2 supervisor over load-h workers lists `queuedLanes.steering` 1 beside `sessionActions.queuedCount` 0, and keeps `unfinishedActionCount`
// for crc.2, whose `queuedCount` reads the visible queue only. The fixtures are chat-057a's load-x wire captures (x/fixtures and x/evidence, 10-27).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { targetStateOf } from "../src/send-once.ts";

const TARGET = "01a115e2-4b8e-7d2c-9f31-6a0c2e5d8b17";
const ROW = { activeSessionId: "f65859311731", sessionId: "f65859311731", activity: "working", isSessionActive: true, isCompacting: false,
  isBashRunning: false, hasRunningRlmChildren: false, attachedClients: 0, messageCount: 4, rlmDepth: 0, runtimeKind: "agent", workerState: "ready" };

/** get_state data from the load.0 build: 6 unfinished actions, of which 3 queued steers and 2 queued follow-ups count against the limit. */
const NEW_STATE = { ...ROW, isStreaming: true, isRunningTools: true, unfinishedActionCount: 6, queuedLanes: { steering: 3, followUp: 2 },
  sessionActions: { queuedCount: 5, steering: ["a", "b", "c"], followUps: ["d", "e"] } };
/** A load.0 list row: the lanes and a queuedCount built from them, and no preview strings. */
const NEW_LIST_ROW = { ...ROW, isStreaming: true, isRunningTools: false, unfinishedActionCount: 3, queuedLanes: { steering: 1, followUp: 1 },
  sessionActions: { queuedCount: 2, steering: [], followUps: [] } };
/** A load.0 roster_subscribe row: the lanes and no sessionActions at all. */
const NEW_ROSTER_ROW = { ...ROW, isStreaming: true, isRunningTools: false, unfinishedActionCount: 3, queuedLanes: { steering: 1, followUp: 1 } };
/** get_state data from crc.2: no queuedLanes, and queuedCount reads the visible queue while all 6 unfinished actions count against the limit. */
const OLD_STATE = { ...ROW, isStreaming: true, isRunningTools: false, unfinishedActionCount: 6,
  sessionActions: { queuedCount: 5, steering: ["a", "b", "c"], followUps: ["d", "e"] } };

test("targetStateOf reads the limit's count from the sum of top-level queuedLanes when a row carries them, else from unfinishedActionCount", () => {
  assert.deepEqual(targetStateOf(NEW_STATE), { queued: ["a", "b", "c", "d", "e"], busy: true, unfinished: 5 });
  assert.deepEqual(targetStateOf(NEW_LIST_ROW), { queued: [], busy: true, unfinished: 2 });
  assert.deepEqual(targetStateOf(OLD_STATE), { queued: ["a", "b", "c", "d", "e"], busy: true, unfinished: 6 });
  assert.deepEqual(targetStateOf({ isStreaming: false, queuedLanes: { steering: 0, followUp: 0 }, sessionActions: { queuedCount: 0 } }), { queued: [], busy: false, unfinished: 0 });
  assert.deepEqual(targetStateOf({ unfinishedActionCount: 2, queuedLanes: { steering: 0, followUp: 0 }, sessionActions: { queuedCount: 0 } }),
    { queued: [], busy: true, unfinished: 0 }, "running actions keep the worker busy but take no slot");
  assert.deepEqual(targetStateOf(undefined), { queued: [], busy: false });
});

test("a roster row with lanes and no sessionActions counts the sum of its lanes", () => {
  assert.deepEqual(targetStateOf(NEW_ROSTER_ROW), { queued: [], busy: true, unfinished: 2 });
  assert.deepEqual(targetStateOf({ queuedLanes: { steering: 4 } }), { queued: [], busy: false, unfinished: 4 }, "a missing lane reads 0");
});

const FIXTURES = new URL("./fixtures/prime-load-h-1027/", import.meta.url);
async function fixture(name: string): Promise<any> { return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8")); }

test("the load.0 wire captures read the sum of their lanes for room", async () => {
  assert.deepEqual(targetStateOf((await fixture("get-state-response.json")).data), { queued: Array(5).fill("<prompt-text>"), busy: true, unfinished: 5 });
  assert.deepEqual(targetStateOf((await fixture("list-response-row-with-queued-input.json")).data.sessions[0]), { queued: [], busy: true, unfinished: 4 });
  assert.deepEqual(targetStateOf((await fixture("roster-subscribe-response-row.json")).data.roster[0].summary), { queued: [], busy: true, unfinished: 4 });
  assert.deepEqual(targetStateOf((await fixture("roster-update-event.json")).changed[0].summary), { queued: [], busy: true, unfinished: 5 });
  for (const name of ["session-unavailable-refusal-get-state.json", "session-unavailable-refusal-steer.json"])
    assert.deepEqual(targetStateOf((await fixture(name)).data), { queued: [], busy: false }, name);
});

test("a crc.2 supervisor's list row over load.0 workers counts the queued steer its lanes show, though its queuedCount reads 0", async () => {
  assert.deepEqual(targetStateOf((await fixture("list-row-mixed-crc2-supervisor.json")).row), { queued: [], busy: true, unfinished: 1 });
});

async function outbox(t: TestContext, data: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "outbox-room-"));
  const sent: string[] = [], lines: string[] = [], reads = { count: 0 };
  const box = new AgentOutbox(join(dir, "agent-outbox"), { log: line => { lines.push(line); }, sleep: () => new Promise(resolve => setTimeout(resolve, 2)),
    send: async (_session, text) => { sent.push(text); return "sent"; }, target: async () => { reads.count++; return targetStateOf(data); }, fileOf: async () => null });
  // The outbox writes its entries until it closes, so a folder removed before the close came back ENOTEMPTY and failed release 59cf440f on 10-27.
  t.after(async () => { await box.close(); await rm(dir, { recursive: true, force: true }); });
  return { box, sent, lines, reads };
}

test("a send the daemon refused as full goes out once a load-h daemon reads 5 queued, though 22 actions are unfinished", async t => {
  const { box, sent, lines } = await outbox(t, { ...NEW_STATE, unfinishedActionCount: 22 });
  const receipt = await box.queue({ session: TARGET, text: "report", from: { id: "01a11d24-ac9b-757d-ac51-9b2b7598782f", name: "ops guy" }, role: "sibling",
    behind: false, pending: 20, limit: 20 });
  assert.equal(receipt.deliveryStatus, "queued");
  for (let i = 0; i < 400 && sent.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1, "the send went out within 2 s");
  assert.ok(lines.some(line => line.includes("the target has room, 5 of 20 unfinished")), lines.join("\n"));
});

test("an older daemon's 22 unfinished actions still hold the send, whatever its queuedCount reads", async t => {
  const { box, sent, reads } = await outbox(t, { ...OLD_STATE, unfinishedActionCount: 22 });
  await box.queue({ session: TARGET, text: "report", from: { id: "01a11d24-ac9b-757d-ac51-9b2b7598782f", name: "ops guy" }, role: "sibling", behind: false, pending: 20, limit: 20 });
  for (let i = 0; i < 400 && reads.count < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(reads.count >= 4, "the outbox read get_state for room again and again");
  assert.equal(sent.length, 0);
});
