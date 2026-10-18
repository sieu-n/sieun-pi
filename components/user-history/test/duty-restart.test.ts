import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { type CheckInRun, Duties, NOT_STARTED } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { CHECK_IN_DUTY_ID, type DutyJobRef, parseDutyInput } from "../src/shared/chat-duties.ts";

// A run's record was appended only after its job started, and the start waits for a working slot in the Mac-wide turn queue. On 10-15 the
// cc3dcb8 and 1ba8ab0 releases each dropped a measured Skills and tools Run now, and about 8 restarts from 09:11Z to 09:41Z left no check-in
// recorded in any chat after 08:41Z. The record now comes first, and the next server starts the job a restart cut off.

const at = (hours: number, minutes = 0): number => new Date(2026, 9, 15, hours, minutes).getTime();
const writeOutput = `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { checks_failed: 0 } }))`;
const exists = (path: string) => access(path).then(() => true, () => false);

function jobs() {
  const starts: string[] = [];
  let next = 0;
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "AI harness", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working() { return true; },
    async start(_chat, name): Promise<DutyJobRef> { starts.push(name); return { id: `s${++next}`, name }; },
    async retire() {},
  };
  return { host, starts };
}

/** An admit that never answers, as the server's wait was when a restart killed it; `reached` resolves once a run waits in it. */
function hungAdmit() {
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  return { waiting, admit: () => { reached(); return new Promise<() => Promise<void>>(() => {}); } };
}

async function storeWithDuty() {
  const dir = await mkdtemp(join(tmpdir(), "duty-restart-"));
  const store = new DutyStore(dir);
  await store.update("c1", duties => {
    duties.push(parseDutyInput({ name: "Skills and tools", ownerWords: "every skill works", goal: "Every skill and tool check passes.", onMiss: "Fix the failing check.",
      metrics: [{ key: "checks_failed", label: "Checks that fail", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "04:30" },
      precheck: { command: ["node", "-e", writeOutput], cwd: tmpdir() } }, "d5", at(17)));
  });
  return store;
}

test("restart: a Run now measured while its job waits for a working slot keeps its record, and the next server starts the job once", async () => {
  const store = await storeWithDuty();
  const first = jobs();
  const hung = hungAdmit();
  const now = { at: at(17, 57) };
  const before = new Duties(store, { isChat: async () => true, jobs: first.host, now: () => now.at, tickMs: 0, admit: hung.admit });
  assert.equal(await before.runNow("c1", "d5"), true);
  await hung.waiting;
  const [waiting] = await store.runs("c1");
  assert.deepEqual([waiting?.verdict, waiting?.summary, waiting?.job], ["met", "checks_failed 0 (on target); all 1 on target", undefined], "measured green and recorded while the start waits");
  assert.ok(await exists(join(store.chatDir("c1"), "d5.pending.json")));
  before.close();

  now.at += 3 * 60_000;
  const second = jobs();
  const after = new Duties(store, { isChat: async () => true, jobs: second.host, now: () => now.at, tickMs: 0, admit: async () => async () => {} });
  await after.tick();
  await after.settled();
  assert.deepEqual(second.starts, ["skills and tools AI harness 17:57"]);
  const [resumed, ...rest] = await store.runs("c1");
  assert.equal(rest.length, 0, "one record for the run");
  assert.deepEqual([resumed?.verdict, resumed?.job?.id], ["met", "s1"]);
  assert.equal(await exists(join(store.chatDir("c1"), "d5.pending.json")), false);
  await after.tick();
  await after.settled();
  assert.equal(second.starts.length, 1, "started once");
  after.close();
});

test("restart: a check-in cut off in the turn-queue wait gets its job from the next server, also once its slot is an interval old", async () => {
  const store = await storeWithDuty();
  const hung = hungAdmit();
  const now = { at: at(17, 9) };
  const run: CheckInRun = { at: now.at, trigger: "schedule", everyMs: 2 * 60 * 60_000, classes: {}, findings: "### Stuck steps\n- p421 looks done",
    output: { metrics: { stuck_steps: 1, finished_open: 1, stalled_steps: 0, no_progress: 0 }, flagged: [] } };
  const before = new Duties(store, { isChat: async () => true, jobs: jobs().host, now: () => now.at, tickMs: 0, admit: hung.admit });
  void before.checkIn("c1", run);
  await hung.waiting;
  assert.deepEqual((await store.runs("c1")).map(entry => [entry.duty, entry.verdict, entry.job]), [[CHECK_IN_DUTY_ID, "missed", undefined]]);
  before.close();

  now.at += 10 * 60_000;
  const second = jobs();
  const after = new Duties(store, { isChat: async () => true, jobs: second.host, now: () => now.at, tickMs: 0, admit: async () => async () => {} });
  await after.tick();
  await after.settled();
  assert.deepEqual(second.starts, ["check-in AI harness 17:09"]);
  assert.equal((await store.runs("c1"))[0]?.job?.id, "s1");
  after.close();

  const late = hungAdmit();
  now.at += 60_000;
  const ended = jobs().host;
  ended.working = async () => false;
  const third = new Duties(store, { isChat: async () => true, jobs: ended, now: () => now.at, tickMs: 0, admit: late.admit });
  void third.checkIn("c1", { ...run, at: now.at });
  await late.waiting;
  third.close();
  now.at += 2 * 60 * 60_000;
  const fourth = jobs();
  const gone = new Duties(store, { isChat: async () => true, jobs: fourth.host, now: () => now.at, tickMs: 0, admit: async () => async () => {} });
  await gone.tick();
  await gone.settled();
  // 38 measured runs from 10-16 to 10-18 lost their job to "the server restarted and its slot passed".
  assert.deepEqual(fourth.starts, ["check-in AI harness 17:20"], "a slot one interval old still gets its job");
  const [resumed] = await store.runs("c1");
  assert.equal(resumed?.job?.id, "s1");
  assert.doesNotMatch(resumed!.summary, new RegExp(NOT_STARTED));
  gone.close();
});
