// mac-management 10-19 22:20Z: from 21:44Z to 22:00Z the check-in on us-metal02 restarted the Mac jobs "email template", "dev tip reds" and
// "new frontend plan" twice each while they sat 39th to 44th for a working slot in the Mac's pi-pool, and each restart aborted the waiting
// model request with no output ("Request was aborted"). The check-in read only its own box's pool.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobPushes } from "../src/checkin-jobs.ts";
import { hostsQueueRead, queueReader, withQueuePlaces } from "../src/chat-turn-queue.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { AgentQueueReading } from "../src/shared/types.ts";

const now = Date.parse("2026-10-19T21:44:50Z");
const everyMs = 15 * 60_000;
const macJob = "01a155a9-646f-7390-9fa2-5f8da62c1452";
const boxReading: AgentQueueReading = { enabled: true, workingMax: 24, workingMaxSet: null, treeWorkingMax: 60, working: [], queued: [] };
const macPool = (entries: { queued?: string[]; working?: string[] }) => ({ machine: {}, pool: { queue: {
  enabled: true, working_max: 30, tree_working_max: 16,
  working: (entries.working ?? []).map(session => ({ session, tree: "01a15427-145f-751d-ba15-d27b6c30f65f", kind: "slot", since: now / 1000 - 600 })),
  queued: (entries.queued ?? []).map((session, index) => ({ session, tree: "01a15427-145f-751d-ba15-d27b6c30f65f", since: now / 1000 - 260, position: 42 + index,
    total: 42 + index, wait_s: 260 })) } } });
const fact: JobFact = { key: "rlm-child-dev-tip-reds", name: "dev tip reds", state: "working", sessionId: macJob };
const quietSince = { [fact.key]: { mark: 0, since: Date.parse("2026-10-19T19:52:00Z") } };
const coordinated = () => true;

test("a Mac job queued in the Mac's pool reads as queued from the box, and the check-in neither restarts nor nudges it", async () => {
  const places = await queueReader(hostsQueueRead(async () => boxReading, () => [async () => macPool({ queued: [macJob] })]))();
  const [read] = withQueuePlaces([fact], places, []);
  assert.equal(read?.queued?.position, 42);
  const { pushes, memos } = jobPushes([read!], [], quietSince, everyMs, now, coordinated, () => 0);
  assert.deepEqual(pushes, []);
  assert.equal(memos[fact.key]?.since, now, "the wait does not count as time with no progress");
  // The slot came at 22:23Z and the turn ended without a report: the next check-in counts from the last one that saw the wait.
  const after = jobPushes([fact], [], memos, everyMs, now + everyMs - 60_000, coordinated, () => 0);
  assert.deepEqual(after.pushes, []);
});

test("a job whose run holds a working slot, streaming or in a tool call, is in its turn and not pushed", async () => {
  const places = await queueReader(hostsQueueRead(async () => boxReading, () => [async () => macPool({ working: [macJob] })]))();
  const [read] = withQueuePlaces([fact], places, []);
  assert.equal(read?.inTurn, true);
  assert.deepEqual(jobPushes([read!], [], quietSince, everyMs, now, coordinated, () => 0).pushes, []);
});

test("without the Mac's pool the same quiet job is restarted, as on 10-19", () => {
  const [read] = withQueuePlaces([fact], { queued: new Map(), working: new Set() }, []);
  assert.equal(jobPushes([read!], [], quietSince, everyMs, now, coordinated, () => 0).pushes[0]?.act, "restart");
});

test("a box whose relay or pool does not answer adds nothing, and this box's reading stays", async () => {
  const read = hostsQueueRead(async () => ({ ...boxReading, queued: [{ session: "box", tree: "t", since: 1, position: 1, total: 1, waitMs: 0 }] }),
    () => [async () => { throw new Error("relay mac answered 502"); }, async () => ({ pool: { error: "pi-pool: not found" } })]);
  assert.deepEqual((await read()).queued.map(entry => entry.session), ["box"]);
});
