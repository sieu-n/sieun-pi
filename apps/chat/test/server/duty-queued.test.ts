/**
 * A due duty behind a job that still works or waits for a model account starts nothing, as a check-in does (b6b7bf30): on 11-22 the fable
 * auditor's sweep jobs waited hours for a Fable account and each due sweep started one more. The card says since when the job waits.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-queued.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyRow } from "../../web/src/lib/api/types.ts";
import { STILL_WORKING, type Duty, type DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
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

/** A duty that reads 90 and logs each precheck mode it ran in; its schedule is far off, so only Run now runs it. */
const duty = (id: string) => ({
  id, name: `Duty ${id}`, ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "every", minutes: 10_000 },
  precheck: { command: ["node", "-e", `const fs = require("fs");
fs.appendFileSync(require("path").join(process.cwd(), "${id}.modes"), process.env.PRECHECK_MODE + "\\n");
fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 90 } }));`], cwd: "", timeoutMs: 30_000 },
  onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now, runCount: 1,
});
const missed = (id: string, at: number, job: string): DutyRunRecord => ({
  duty: id, at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: { up: { value: 90, target: 99, op: ">=", met: false } }, summary: "up 90",
  job: { id: job, name: `Duty ${id} job` },
});
const answer = (stopReason: "stop" | "error") => ({ kind: "pi.assistant", model: [{ role: "assistant" as const, content: [], stopReason, timestamp: now }] });

before(async () => {
  s = await start();
  work = mkdtempSync(join(tmpdir(), "duty-queued-"));
  const host = s.host as FixtureHost;
  // d1: pi-pool holds its job for an account slot, so it sleeps with only an error answer. d2: its job got an answer and now waits in the
  // turn queue. d3: its job ended.
  const asleep = host.addThread({ id: "job-asleep", name: "Duty d1 job", status: "sleeping", createdAt: now - HOUR });
  host.append(asleep, 1, answer("error"));
  const queued = host.addThread({ id: "job-queued", name: "Duty d2 job", status: "running", createdAt: now - HOUR });
  host.append(queued, 1, answer("stop"));
  queued.places.set(1, { state: "queued", position: 4, total: 9 });
  host.addThread({ id: "job-done", name: "Duty d3 job", createdAt: now - HOUR });
  await s.app.threads.refresh();
  mkdirSync(chatDir(), { recursive: true });
  writeFileSync(dutiesFile(), JSON.stringify({
    duties: ["d1", "d2", "d3"].map(id => ({ ...duty(id), precheck: { ...duty(id).precheck, cwd: work } })),
    runs: { d1: [missed("d1", now - HOUR, "job-asleep")], d2: [missed("d2", now - HOUR, "job-queued")], d3: [missed("d3", now - HOUR, "job-done")] },
  }));
});
after(async () => {
  await s.close();
  rmSync(work, { recursive: true, force: true });
});

test("a due duty behind a job that sleeps for an account runs no precheck, starts no job and records one skipped run", async () => {
  await run("d1");
  await until(() => Promise.resolve(runsOf("d1")), runs => runs.length === 2);
  const [skipped, older] = runsOf("d1");
  assert.equal(skipped!.verdict, "skipped");
  assert.equal(skipped!.summary, STILL_WORKING);
  assert.deepEqual(skipped!.metrics, {});
  assert.equal(skipped!.ms, 0);
  assert.equal(skipped!.job, undefined);
  assert.equal(older!.job?.id, "job-asleep");
  assert.deepEqual(modes("d1"), []);
  const first = file().duties.find(d => d.id === "d1")!.lastRunAt!;
  assert.ok(first >= now);
  // A second skip of the same wait replaces the first, so the duty's measured runs stay in its newest 20.
  await new Promise(done => setTimeout(done, 5));
  await run("d1");
  await until(() => Promise.resolve(file().duties.find(d => d.id === "d1")!.lastRunAt!), at => at > first);
  await until(() => Promise.resolve(runsOf("d1")), runs => runs[0]!.at > skipped!.at);
  assert.deepEqual(runsOf("d1").map(entry => entry.verdict), ["skipped", "missed"]);
  assert.deepEqual(modes("d1"), []);
  // The card's last verdict is the newest run that measured.
  assert.equal((await row("d1")).last?.verdict, "missed");
});

test("a job in the turn queue keeps the next run from starting another", async () => {
  await run("d2");
  await until(() => Promise.resolve(runsOf("d2")), runs => runs.length === 2);
  assert.equal(runsOf("d2")[0]!.verdict, "skipped");
  assert.deepEqual(modes("d2"), []);
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
});
