/**
 * A due duty behind a job that still works or waits for a model account measures and records its run but starts no second job, as Prime's
 * `Duties.launch` does. A job with no model answer yet gets the newer run's brief, or is stopped when nothing is due: on 11-22 the fable
 * auditor's 16:06Z sweep job waited 3 h 44 min for a Fable account and every sweep behind it skipped its precheck. The card says since when the
 * job waits. Such a run names the job, so the job's after-job measure lands on it too and the card reads the state after the job's work.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-queued.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyRow } from "../../web/src/lib/api/types.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { landAfter } from "../../server/boards.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const metric = { key: "up", label: "Up", op: ">=" as const, target: 99, headline: true };

let s: Running;
let work: string;
const now = Date.now();
const chatDir = () => join(s.app.store.dir, "boards", ids.vent);
const dutiesFile = () => join(chatDir(), "duties.json");
const file = () => JSON.parse(readFileSync(dutiesFile(), "utf8")) as { duties: Duty[]; runs: Record<string, DutyRunRecord[]> };
const runsOf = (duty: string): DutyRunRecord[] => file().runs[duty] ?? [];
const row = async (duty: string): Promise<DutyRow> => (await s.get<{ duties: DutyRow[] }>(`/api/threads/${ids.vent}/duties`)).duties.find(d => d.duty.id === duty)!;
const modes = (id: string): string[] => { try { return readFileSync(join(work, `${id}.modes`), "utf8").trim().split("\n"); } catch { return []; } };
const run = (duty: string) => s.send("POST", `/api/threads/${ids.vent}/duties`, { duty, action: "run" });

/** A duty that reads `up` (90 by default) and logs each precheck mode it ran in; its schedule is far off, so only Run now runs it. */
const duty = (id: string, up = 90) => ({
  id, name: `Duty ${id}`, ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "every", minutes: 10_000 },
  precheck: { command: ["node", "-e", `const fs = require("fs");
fs.appendFileSync(require("path").join(process.cwd(), "${id}.modes"), process.env.PRECHECK_MODE + "\\n");
fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: ${up} } }));`], cwd: "", timeoutMs: 30_000 },
  onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now, runCount: 1,
});
/** A duty like `duty` whose precheck reads `up` from `<id>.up` in its folder. */
const fixable = (id: string) => {
  const base = duty(id);
  return { ...base, precheck: { ...base.precheck, command: ["node", "-e", `const fs = require("fs"), path = require("path");
fs.appendFileSync(path.join(process.cwd(), "${id}.modes"), process.env.PRECHECK_MODE + "\\n");
fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: Number(fs.readFileSync(path.join(process.cwd(), "${id}.up"), "utf8")) } }));`] } };
};
const missed = (id: string, at: number, job: string): DutyRunRecord => ({
  duty: id, at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: { up: { value: 90, target: 99, op: ">=", met: false } }, summary: "up 90",
  job: { id: job, name: `Duty ${id} job` },
});
const said = (job: string): string[] => (s.host as FixtureHost).threadsById.get(job)!.entries.flatMap(entry =>
  entry.kind === "agent.message" ? (entry.model ?? []).flatMap(message => message.role !== "user" ? [] : typeof message.content === "string" ? [message.content]
    : message.content.flatMap(part => part.type === "text" ? [part.text] : [])) : []);
const aborted: string[] = [];
const answer = (stopReason: "stop" | "error") => ({ kind: "pi.assistant", model: [{ role: "assistant" as const, content: [], stopReason, timestamp: now }] });

before(async () => {
  s = await start();
  work = mkdtempSync(join(tmpdir(), "duty-queued-"));
  const host = s.host as FixtureHost;
  // d1: pi-pool holds its job for an account slot, so it sleeps with only an error answer. d2: its job got an answer and now waits in the
  // turn queue. d3: its job ended.
  // d4: pi-pool holds its job too, and its precheck now reads met. A held job's first turn runs to pi-durable, so a submit queues behind it.
  const asleep = host.addThread({ id: "job-asleep", name: "Duty d1 job", status: "sleeping", createdAt: now - HOUR });
  host.append(asleep, 1, answer("error"));
  asleep.running.set(1, { stop: () => aborted.push("job-asleep") });
  const held = host.addThread({ id: "job-held", name: "Duty d4 job", status: "sleeping", createdAt: now - HOUR });
  held.running.set(1, { stop: () => aborted.push("job-held") });
  const queued = host.addThread({ id: "job-queued", name: "Duty d2 job", status: "running", createdAt: now - HOUR });
  host.append(queued, 1, answer("stop"));
  queued.places.set(1, { state: "queued", position: 4, total: 9 });
  host.addThread({ id: "job-done", name: "Duty d3 job", createdAt: now - HOUR });
  // d5: its run of an hour ago started a job that pi-pool still holds, and its precheck reads `up` from d5.up, so the test can fix it.
  const d5job = host.addThread({ id: "job-d5", name: "Duty d5 job", status: "sleeping", createdAt: now - HOUR });
  host.append(d5job, 1, answer("error"));
  d5job.running.set(1, { stop: () => aborted.push("job-d5") });
  writeFileSync(join(work, "d5.up"), "90");
  await s.app.threads.refresh();
  mkdirSync(chatDir(), { recursive: true });
  writeFileSync(dutiesFile(), JSON.stringify({
    duties: [duty("d1"), duty("d2"), duty("d3"), duty("d4", 100), fixable("d5")].map(entry => ({ ...entry, precheck: { ...entry.precheck, cwd: work } })),
    runs: { d1: [missed("d1", now - HOUR, "job-asleep")], d2: [missed("d2", now - HOUR, "job-queued")], d3: [missed("d3", now - HOUR, "job-done")], d4: [missed("d4", now - HOUR, "job-held")],
      d5: [missed("d5", now - HOUR, "job-d5")] },
  }));
});
after(async () => {
  await s.close();
  rmSync(work, { recursive: true, force: true });
});

test("a due duty behind a job that waits for an account measures, starts no job and steers the newer brief into the waiting job", async () => {
  await run("d1");
  await until(() => Promise.resolve(runsOf("d1")), runs => runs.length === 2);
  const [measured, older] = runsOf("d1");
  assert.equal(measured!.verdict, "missed");
  assert.equal(measured!.metrics.up?.value, 90);
  assert.deepEqual(measured!.job, { id: "job-asleep", name: "Duty d1 job" });
  assert.match(measured!.summary, /its job Duty d1 job still waits for a model account and got this run's brief/);
  assert.equal(older!.job?.id, "job-asleep");
  assert.equal(older!.after, undefined);
  assert.deepEqual(modes("d1"), ["run"]);
  const steers = said("job-asleep");
  assert.equal(steers.length, 1);
  assert.match(steers[0]!, /^A newer Duty d1 run measured while you waited for a model account/);
  assert.ok(steers[0]!.includes(measured!.detail!.replace(/\.json$/, ".findings.md")), "the steer names the newer run's findings file");
  assert.deepEqual(aborted, []);
  // The next slot measures again and hands the waiting job that run's brief too.
  const first = file().duties.find(d => d.id === "d1")!.lastRunAt!;
  await new Promise(done => setTimeout(done, 5));
  await run("d1");
  await until(() => Promise.resolve(file().duties.find(d => d.id === "d1")!.lastRunAt!), at => at > first);
  await until(() => Promise.resolve(runsOf("d1")), runs => runs.length === 3);
  assert.deepEqual(runsOf("d1").map(entry => entry.verdict), ["missed", "missed", "missed"]);
  assert.deepEqual(modes("d1"), ["run", "run"]);
  assert.equal(said("job-asleep").length, 2);
  assert.equal((await row("d1")).last?.at, runsOf("d1")[0]!.at);
});

test("a job that answered and waits in the turn queue keeps the next run from starting another, and gets no steer", async () => {
  await run("d2");
  await until(() => Promise.resolve(runsOf("d2")), runs => runs.length === 2);
  const [measured] = runsOf("d2");
  assert.equal(measured!.verdict, "missed");
  assert.deepEqual(measured!.job, { id: "job-queued", name: "Duty d2 job" });
  assert.match(measured!.summary, /its job Duty d2 job still works, so this run started none/);
  assert.deepEqual(modes("d2"), ["run"]);
  assert.deepEqual(said("job-queued"), []);
});

test("a run with nothing due stops the job that still waits for an account", async () => {
  await run("d4");
  await until(() => Promise.resolve(runsOf("d4")), runs => runs.length === 2);
  const [measured] = runsOf("d4");
  assert.equal(measured!.verdict, "met");
  assert.deepEqual(measured!.job, { id: "job-held", name: "Duty d4 job" });
  assert.match(measured!.summary, /stopped its job Duty d4 job, which still waited for a model account, since nothing is due/);
  assert.deepEqual(aborted, ["job-held"]);
  assert.deepEqual(said("job-held"), []);
});

test("a duty whose job ended runs its precheck and starts a job", async () => {
  await run("d3");
  await until(() => Promise.resolve(runsOf("d3")), runs => runs.length === 2 && !!runs[0]!.job);
  assert.equal(runsOf("d3")[0]!.verdict, "missed");
  assert.equal(modes("d3")[0], "run");
});

test("the card says since when the duty's job waits for a model account, and drops it once the job runs", async () => {
  await s.app.boards.tick();
  const waits = async () => Object.fromEntries((await s.get<{ duties: DutyRow[] }>(`/api/threads/${ids.vent}/duties`)).duties.map(d => [d.duty.id, d.waitingForAccountSince]));
  await until(waits, by => by.d1 !== undefined && by.d2 !== undefined);
  const by = await waits();
  assert.equal(by.d1, now - HOUR);
  assert.equal(by.d2, now - HOUR);
  assert.equal(by.d3, undefined);
  // d2's job leaves the queue and works: it already answered once, so it no longer waits.
  const host = s.host as FixtureHost;
  host.threadsById.get("job-queued")!.places.set(1, { state: "working", kind: "slot" });
  await s.app.boards.tick();
  await until(waits, next => next.d2 === undefined);
  assert.equal((await waits()).d1, now - HOUR);
  // The waiting duty's card reads its newest measured run, not a skip.
  const d1 = await row("d1");
  assert.equal(d1.last?.verdict, "missed");
  assert.equal(d1.last?.at, runsOf("d1")[0]!.at);
  assert.equal(d1.card.job?.name, "Duty d1 job");
});

test("the job's after-job measure lands on every run that handed it a brief, so the card reads met once the job's work is in", async () => {
  // Run A started job-d5 an hour ago; runs B and C hand it their briefs while pi-pool still holds it.
  for (const count of [2, 3]) {
    await until(() => row("d5"), d5 => !d5.running);
    await new Promise(done => setTimeout(done, 5));
    await run("d5");
    await until(() => Promise.resolve(runsOf("d5")), runs => runs.length === count);
  }
  assert.deepEqual(runsOf("d5").map(entry => [entry.verdict, entry.job?.id, entry.after]), [["missed", "job-d5", undefined], ["missed", "job-d5", undefined], ["missed", "job-d5", undefined]]);
  assert.equal((await row("d5")).last?.streak, 3);
  // The job does its work and ends.
  writeFileSync(join(work, "d5.up"), "100");
  const job = (s.host as FixtureHost).threadsById.get("job-d5")!;
  job.running.delete(1);
  job.row.status = "idle";
  await s.app.threads.refresh();
  await s.app.boards.tick();
  await until(() => Promise.resolve(runsOf("d5")), runs => runs.every(entry => entry.after));
  const runs = runsOf("d5");
  assert.equal(new Set(runs.map(entry => entry.after!.at)).size, 1, "one after-job measure, written onto each run");
  for (const entry of runs) {
    assert.equal(entry.after!.verdict, "met");
    assert.equal(entry.verdict, "missed", "each run keeps its own verdict");
    assert.equal(entry.metrics.up?.value, 90, "each run keeps its own numbers");
  }
  assert.deepEqual(modes("d5"), ["run", "run", "after"]);
  const d5 = await row("d5");
  assert.equal(d5.last?.verdict, "met");
  assert.equal(d5.last?.at, runs[0]!.at);
  assert.equal(d5.last?.afterJob, true);
  assert.equal(d5.last?.streak, 0);
  assert.equal(d5.card.streak, 0);
});

test("an after-job measure lands only on runs started before it, so an older reading never turns a later met run red", () => {
  const job = "job-x";
  const run = (at: number, verdict: "met" | "missed"): DutyRunRecord => ({ ...missed("dx", at, job), verdict, metrics: { up: { value: verdict === "met" ? 100 : 90, target: 99, op: ">=", met: verdict === "met" } } });
  const runs = [run(now - HOUR, "met"), run(now - 3 * HOUR, "missed"), run(now - 4 * HOUR, "missed")];
  const after = { at: now - 2 * HOUR, verdict: "missed" as const, metrics: { up: { value: 40, target: 99, op: ">=" as const, met: false } }, summary: "up 40" };
  assert.deepEqual(landAfter(runs, job, after).map(entry => entry.at), [now - 3 * HOUR, now - 4 * HOUR]);
  assert.equal(runs[0]!.after, undefined, "the met run measured after the reading keeps its own");
  assert.equal(landAfter(runs, job, { ...after, at: now }).length, 1, "a later measure lands on the run that has none");
});
