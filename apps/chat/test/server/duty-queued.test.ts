/**
 * A due duty behind a job that still works or waits for a model account measures and records its run but starts no second job, as Prime's
 * `Duties.launch` does. A job with no model answer yet gets the newer run's brief, or is stopped when nothing is due: on 11-22 the fable
 * auditor's 16:06Z sweep job waited 3 h 44 min for a Fable account and every sweep behind it skipped its precheck. The card says since when the
 * job waits. Such a run names the job, so the job's after-job measure lands on it too and the card reads the state after the job's work.
 * A job that answered gets each flagged item and missed metric it was not given, once, and a due run stops and replaces one that held the
 * duty past its stuck limit with no missed number closer to its target, unless it waits for a model account: from 11-25 21:10Z one job held
 * devops guy's d17 for 62 h while 7 runs started none and gave it nothing.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-queued.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyRow } from "../../web/src/lib/api/types.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { landAfter, type DutyFile } from "../../server/boards.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const metric = { key: "up", label: "Up", op: ">=" as const, target: 99, headline: true };

let s: Running;
let work: string;
const now = Date.now();
const file = (): { duties: Duty[]; runs: Record<string, DutyRunRecord[]> } => s.app.boards.dutyFile(ids.vent);
const runsOf = (duty: string): DutyRunRecord[] => file().runs[duty] ?? [];
const row = async (duty: string): Promise<DutyRow> => (await s.get<{ duties: DutyRow[] }>(`/api/threads/${ids.vent}/duties`)).duties.find(d => d.duty.id === duty)!;
const modes = (id: string): string[] => { try { return readFileSync(join(work, `${id}.modes`), "utf8").trim().split("\n"); } catch { return []; } };
const run = (duty: string) => s.send("POST", `/api/threads/${ids.vent}/duties`, { duty, action: "run" });

/** A duty that reads `up` (90 by default) and logs each precheck mode it ran in; its schedule is far off, so only Run now runs it. */
const duty = (id: string, up = 90) => ({
  id, name: `Duty ${id}`, ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "every", minutes: 10_000 },
  precheck: { command: ["node", "-e", `const fs = require("fs");
fs.appendFileSync(require("path").join(process.cwd(), "${id}.modes"), process.env.PRECHECK_MODE + "\\n");
fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ n: 1, metrics: { up: ${up} } }));`], cwd: "", timeoutMs: 30_000 },
  onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now, runCount: 1,
});
/** A duty like `duty` whose precheck reads `up` from `<id>.up` in its folder. */
const fixable = (id: string) => {
  const base = duty(id);
  return { ...base, precheck: { ...base.precheck, command: ["node", "-e", `const fs = require("fs"), path = require("path");
fs.appendFileSync(path.join(process.cwd(), "${id}.modes"), process.env.PRECHECK_MODE + "\\n");
fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ n: 1, metrics: { up: Number(fs.readFileSync(path.join(process.cwd(), "${id}.up"), "utf8")) } }));`] } };
};
/** A duty like `duty` that reads met and whose precheck output names no n. */
const noN = (id: string) => {
  const base = duty(id, 100);
  return { ...base, precheck: { ...base.precheck, command: base.precheck.command.map(part => part.replace("{ n: 1, ", "{ ")) } };
};
/** A duty like `duty` whose precheck writes the output kept in `<id>.out` in its folder. */
const flagging = (id: string) => {
  const base = duty(id);
  return { ...base, precheck: { ...base.precheck, command: ["node", "-e", `const fs = require("fs"), path = require("path");
fs.writeFileSync(process.env.OUTPUT_FILE, fs.readFileSync(path.join(process.cwd(), "${id}.out"), "utf8"));`] } };
};
const EVENTS = { kind: "line_over_pace", item: "posthog//Events", excerpt: "posthog Events: 1,256,967 events a cycle, 126% of 1,000,000 included" };
const missed = (id: string, at: number, job: string): DutyRunRecord => ({
  duty: id, at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: { up: { value: 90, target: 99, op: ">=", met: false } }, summary: "up 90",
  job: { id: job, name: `Duty ${id} job` },
});
const said = (job: string): string[] => (s.host as FixtureHost).threadsById.get(job)!.entries.flatMap(entry =>
  entry.kind === "agent.message" ? (entry.model ?? []).flatMap(message => message.role !== "user" ? [] : typeof message.content === "string" ? [message.content]
    : message.content.flatMap(part => part.type === "text" ? [part.text] : [])) : []);
const aborted: string[] = [];
const answer = (stopReason: "stop" | "error", text?: string) =>
  ({ kind: "pi.assistant", model: [{ role: "assistant" as const, content: text ? [{ type: "text" as const, text }] : [], stopReason, timestamp: now }] });
/** A job that answered once and still runs a turn, started `hours` ago; a stop of its turn lands in `aborted`. */
const working = (id: string, duty: string, hours: number, text?: string) => {
  const thread = (s.host as FixtureHost).addThread({ id, name: `Duty ${duty} job`, status: "running", createdAt: now - hours * HOUR });
  (s.host as FixtureHost).append(thread, 1, answer("stop", text));
  thread.running.set(1, { stop: () => aborted.push(id) });
  return thread;
};

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
  // d7: pi-pool holds its job, which an earlier run handed the sig d7/n, and its precheck still writes no n.
  const holds = host.addThread({ id: "job-holds", name: "Duty d7 job", status: "sleeping", createdAt: now - HOUR });
  holds.running.set(1, { stop: () => aborted.push("job-holds") });
  // d6: its job answered once and its root turn ended, and pi-pool parks the call of a subagent under its tree for an account, as it parked
  // five duty jobs on 11-26. The fake pool's tree record says the wait; its state.json record says since when.
  const parked = host.addThread({ id: "job-parked", name: "Duty d6 job", status: "sleeping", createdAt: now - 3 * HOUR });
  host.append(parked, 1, answer("stop"));
  parked.running.set(1, { stop: () => aborted.push("job-parked") });
  // d8: its job answered and works, an hour old. d9: its job started 13 h ago, past a daily duty's 12 h, and its turn ended on a wake it set,
  // as d17's job slept on a wake for 2026-11-28T03:00Z.
  // d10: as old, and pi-pool parks its tree for an account. d11: as old, and a run an hour ago read its number closer to the target.
  working("job-works", "d8", 1);
  host.append(host.addThread({ id: "job-stuck", name: "Duty d9 job", createdAt: now - 13 * HOUR }), 1, answer("stop", "up is 90. I wait for the vendor to answer."));
  working("job-old-parked", "d10", 13);
  working("job-moving", "d11", 13);
  working("job-hung", "d12", 13);
  for (const id of ["d8", "d9"]) writeFileSync(join(work, `${id}.out`), JSON.stringify({ n: 1, metrics: { up: 90 } }));
  writeFileSync(join(work, "d12.up"), "90");
  const pool = process.env.PI_POOL_DIR!;
  const fake = JSON.parse(readFileSync(join(pool, "fake-pi-pool.json"), "utf8"));
  const state = JSON.parse(readFileSync(join(pool, "state.json"), "utf8"));
  for (const job of ["job-parked", "job-old-parked"]) {
    fake.trees[`pi-durable:${job}`] = { priority: "low", pins: {}, current: {}, wait: { anthropic: { account: "claude-limited", slot_at: now / 1000 + 600 } } };
    state.sessions[`pi-durable:${job}`] = { vends: {}, wait: { anthropic: { account: "claude-limited", slot_at: now / 1000 + 600, since: (now - 2 * HOUR) / 1000 } } };
  }
  writeFileSync(join(pool, "fake-pi-pool.json"), JSON.stringify(fake));
  writeFileSync(join(pool, "state.json"), JSON.stringify(state));
  await s.app.threads.refresh();
  await s.app.boards.addWake("job-stuck", { on: { kind: "time", at: now + 24 * HOUR }, note: "look at the bill again" });
  await s.app.boards.saveDuties(ids.vent, {
    duties: [duty("d1"), duty("d2"), duty("d3"), duty("d4", 100), fixable("d5"), duty("d6"), noN("d7"), flagging("d8"), flagging("d9"), duty("d10"), duty("d11"), fixable("d12")]
      .map(entry => ({ ...entry, precheck: { ...entry.precheck, cwd: work } })),
    runs: { d1: [missed("d1", now - HOUR, "job-asleep")], d2: [missed("d2", now - HOUR, "job-queued")], d3: [missed("d3", now - HOUR, "job-done")], d4: [missed("d4", now - HOUR, "job-held")],
      d5: [missed("d5", now - HOUR, "job-d5")], d6: [missed("d6", now - 3 * HOUR, "job-parked")],
      d7: [{ ...missed("d7", now - HOUR, "job-holds"), flagged: [{ kind: "no_sample_size", excerpt: "add n", handOff: true, sig: "d7/n" }] }],
      d8: [missed("d8", now - HOUR, "job-works")], d9: [missed("d9", now - 13 * HOUR, "job-stuck")], d10: [missed("d10", now - 13 * HOUR, "job-old-parked")],
      d11: [{ ...missed("d11", now - HOUR, "job-moving"), metrics: { up: { value: 95, target: 99, op: ">=", met: false } } }, missed("d11", now - 13 * HOUR, "job-moving")],
      d12: [missed("d12", now - 13 * HOUR, "job-hung")] },
  } as DutyFile);
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

test("a run with nothing new due leaves a waiting job that holds a hand-off sig the run flags again", async () => {
  // On 11-26 Crawler guy's d7 verify run stopped the waiting job that held d7/n, and the sig then read as handed, so nobody added the n.
  await run("d7");
  await until(() => Promise.resolve(runsOf("d7")), runs => runs.length === 2);
  const [measured] = runsOf("d7");
  assert.equal(measured!.verdict, "met");
  assert.deepEqual(measured!.job, { id: "job-holds", name: "Duty d7 job" });
  assert.match(measured!.summary, /its job Duty d7 job still waits for a model account and holds this run's hand-offs, so this run left it/);
  assert.deepEqual(measured!.flagged, [], "the run hands the job no sig it already holds");
  assert.ok(!aborted.includes("job-holds"));
  assert.deepEqual(said("job-holds"), []);
});

test("a duty whose job ended runs its precheck and starts a job", async () => {
  await run("d3");
  await until(() => Promise.resolve(runsOf("d3")), runs => runs.length === 2 && !!runs[0]!.job);
  assert.equal(runsOf("d3")[0]!.verdict, "missed");
  assert.equal(modes("d3")[0], "run");
});

test("a due run stops a job that slept on its own wake past the duty's limit with no move, and starts a new job with its last report", async () => {
  assert.equal(s.app.boards.wakes("job-stuck", 1).length, 1);
  await run("d9");
  await until(() => Promise.resolve(runsOf("d9")), runs => runs.length === 2 && !!runs[0]!.job);
  const [fresh, older] = runsOf("d9");
  assert.match(fresh!.summary, /replaced its job Duty d9 job, which held the duty 13 h with no missed number closer to its target$/);
  assert.deepEqual(fresh!.replaced, { id: "job-stuck", name: "Duty d9 job" });
  assert.notEqual(fresh!.job!.id, "job-stuck", "the run started a job of its own");
  assert.deepEqual(fresh!.given, ["metric|up"]);
  assert.equal((s.host as FixtureHost).threadsById.get("job-stuck")!.row.archived, true, "an archive ends the old job and its subagents in pi-host");
  assert.equal(s.app.boards.wakes("job-stuck", 1).length, 0, "no wake starts the old job again");
  const [brief] = said(fresh!.job!.id);
  assert.match(brief!, /^# The Duty d9 duty of the chat/);
  assert.match(brief!, /## The job before you\n\nThis run stopped the job "Duty d9 job": it held this duty for 13 h with no missed number closer to its target\./);
  assert.ok(brief!.includes("> up is 90. I wait for the vendor to answer."), "the new job reads the old job's last report");
  assert.equal(older!.after?.verdict, "missed", "the old job's run is judged by this run's measure");
});

test("a tick gives a red duty whose working job held it past the limit a push run, which stops and replaces the job", async () => {
  await s.app.boards.tick();
  await until(() => Promise.resolve(runsOf("d12")), runs => runs.length === 2 && !!runs[0]!.job);
  assert.equal(runsOf("d12")[0]!.trigger, "push", "a daily duty's job is replaced at the first push after 12 h, not at the next day's slot");
  assert.deepEqual(runsOf("d12")[0]!.replaced, { id: "job-hung", name: "Duty d12 job" });
  assert.deepEqual(aborted.filter(id => id === "job-hung"), ["job-hung"], "its running turn is stopped");
  // The same tick pushed neither the job that waits for a model account nor the one that moved its number an hour ago.
  assert.deepEqual([runsOf("d10").length, (await row("d10")).running, runsOf("d11").length, (await row("d11")).running], [1, false, 2, false]);
});

test("a job past the limit that waits for a model account, or that moved its number, is not replaced", async () => {
  const clock = new Date(now - 2 * HOUR + 9 * HOUR).toISOString().slice(11, 16);
  await run("d10");
  await until(() => Promise.resolve(runsOf("d10")), runs => runs.length === 2);
  assert.match(runsOf("d10")[0]!.summary, new RegExp(`its job Duty d10 job is waiting for a model account since ${clock} KST, so this run started none$`));
  assert.deepEqual(runsOf("d10")[0]!.job, { id: "job-old-parked", name: "Duty d10 job" });
  await run("d11");
  await until(() => Promise.resolve(runsOf("d11")), runs => runs.length === 3);
  assert.match(runsOf("d11")[0]!.summary, /its job Duty d11 job still works, so this run started none$/);
  assert.deepEqual(aborted.filter(id => id === "job-old-parked" || id === "job-moving"), []);
});

test("a job that answered once and whose subagent pi-pool parks for an account reads as waiting since the pool's wait began", async () => {
  const clock = new Date(now - 2 * HOUR + 9 * HOUR).toISOString().slice(11, 16);
  await run("d6");
  await until(() => Promise.resolve(runsOf("d6")), runs => runs.length === 2);
  const [measured] = runsOf("d6");
  assert.deepEqual(measured!.job, { id: "job-parked", name: "Duty d6 job" });
  assert.match(measured!.summary, new RegExp(`its job Duty d6 job is waiting for a model account since ${clock} KST, so this run started none`));
  assert.deepEqual(said("job-parked"), [], "a job that answered gets no steer");
  assert.ok(!aborted.includes("job-parked"));
  await s.app.boards.tick();
  await until(async () => (await row("d6")).waitingForAccountSince, since => since === now - 2 * HOUR);
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

test("a job that answered and works gets a run's new flagged item once, and the run records what it gave", async () => {
  // d17 on 11-27: the run flagged PostHog Events for the first time beside a job that worked, and said "so this run started none".
  await run("d8");
  await until(() => Promise.resolve(runsOf("d8")), runs => runs.length === 2);
  assert.match(runsOf("d8")[0]!.summary, /its job Duty d8 job still works, so this run started none$/, "a run with nothing new gives the job nothing");
  assert.deepEqual(said("job-works"), []);
  writeFileSync(join(work, "d8.out"), JSON.stringify({ n: 1, metrics: { up: 90 }, flagged: [EVENTS] }));
  await until(() => row("d8"), d8 => !d8.running);
  await run("d8");
  await until(() => Promise.resolve(runsOf("d8")), runs => runs.length === 3);
  const [gave] = runsOf("d8");
  assert.match(gave!.summary, /its job Duty d8 job still works and got 1 new item of this run, so this run started none$/);
  assert.deepEqual(gave!.given, ["line_over_pace|posthog//Events"]);
  assert.deepEqual(gave!.job, { id: "job-works", name: "Duty d8 job" });
  const steers = said("job-works");
  assert.equal(steers.length, 1);
  assert.match(steers[0]!, /^The Duty d8 run of \d\d:\d\d KST measured while you work: up 90 .*It found 1 flagged item that your brief and the runs since did not give you\./);
  assert.ok(steers[0]!.includes("posthog Events: 1,256,967 events a cycle"));
  assert.ok(steers[0]!.includes(gave!.detail!.replace(/\.json$/, ".findings.md")), "the steer names the run's findings file");
  // The next run flags the same item: the job has it.
  await until(() => row("d8"), d8 => !d8.running);
  await run("d8");
  await until(() => Promise.resolve(runsOf("d8")), runs => runs.length === 4);
  assert.match(runsOf("d8")[0]!.summary, /still works, so this run started none$/);
  assert.equal(runsOf("d8")[0]!.given, undefined);
  assert.equal(said("job-works").length, 1, "an item goes to the job once");
  assert.ok(!aborted.includes("job-works"));
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
