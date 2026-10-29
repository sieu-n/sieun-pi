/**
 * A duty run's after-job measure, as Prime's duty runner takes it: once the run's job has ended, the precheck runs again in `after` mode and
 * its measure becomes the run's verdict and streak on the card. A job still at work, or one with a wake set, keeps the run's own verdict, and a
 * last job's run that never got one takes the next run's measure.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-after-job.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyRow } from "../../web/src/lib/api/types.ts";
import type { DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const metric = { key: "up", label: "Up", op: ">=" as const, target: 99, headline: true };
const result = (value: number) => ({ up: { value, target: 99, op: ">=" as const, met: value >= 99 } });

let s: Running;
let work: string;
const now = Date.now();
const chatDir = () => join(s.app.store.dir, "boards", ids.vent);
const dutiesFile = () => join(chatDir(), "duties.json");
const runsOf = (duty: string): DutyRunRecord[] => (JSON.parse(readFileSync(dutiesFile(), "utf8")) as { runs: Record<string, DutyRunRecord[]> }).runs[duty] ?? [];
const row = async (duty: string): Promise<DutyRow> => (await s.get<{ duties: DutyRow[] }>(`/api/threads/${ids.vent}/duties`)).duties.find(d => d.duty.id === duty)!;

/** A precheck that reads 90 on a run and 100 after its job, as when the job fixed the metric, and logs each mode it ran in. */
const duty = (id: string) => ({
  id, name: `Duty ${id}`, ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "daily", at: "07:04" },
  precheck: { command: ["node", "-e", `const fs = require("fs"); const mode = process.env.PRECHECK_MODE;
fs.appendFileSync(require("path").join(process.cwd(), "${id}.modes"), mode + "\\n");
fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: mode === "after" ? 100 : 90 } }));`], cwd: "", timeoutMs: 30_000 },
  onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now - HOUR, runCount: 2,
});
const missed = (id: string, at: number, job?: string): DutyRunRecord => ({
  duty: id, at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: result(90), summary: "up 90", ...(job ? { job: { id: job, name: `Duty ${id} job` } } : {}),
} as DutyRunRecord);
const modes = (id: string): string[] => { try { return readFileSync(join(work, `${id}.modes`), "utf8").trim().split("\n"); } catch { return []; } };

before(async () => {
  s = await start();
  work = mkdtempSync(join(tmpdir(), "duty-after-"));
  const host = s.host as FixtureHost;
  host.addThread({ id: "job-ended", name: "Duty d1 job", createdAt: now - HOUR });
  host.addThread({ id: "job-working", name: "Duty d2 job", status: "running", createdAt: now - HOUR });
  host.addThread({ id: "job-waking", name: "Duty d3 job", createdAt: now - HOUR });
  await s.app.threads.refresh();
  const duties = ["d1", "d2", "d3", "d4"].map(id => ({ ...duty(id), precheck: { ...duty(id).precheck, cwd: work } }));
  mkdirSync(chatDir(), { recursive: true });
  writeFileSync(dutiesFile(), JSON.stringify({ duties, runs: {
    d1: [missed("d1", now - HOUR, "job-ended"), missed("d1", now - 25 * HOUR)],
    d2: [missed("d2", now - HOUR, "job-working")],
    d3: [missed("d3", now - HOUR, "job-waking")],
    d4: [missed("d4", now - 25 * HOUR, "job-gone")],
  } }));
  mkdirSync(s.app.boards.wakeDir, { recursive: true });
  writeFileSync(join(s.app.boards.wakeDir, "job-waking--1-time-1.json"), JSON.stringify({ session: "job-waking--1", on: { kind: "time", at: now + HOUR }, note: "", since: now }));
});
after(async () => {
  await s.close();
  rmSync(work, { recursive: true, force: true });
});

test("a run whose job ended is measured again in after mode, and the card reads met after its job with the streak gone", async () => {
  assert.deepEqual((await row("d1")).last, { verdict: "missed", at: now - HOUR, streak: 2, afterJob: false });
  await s.app.boards.afterJob(ids.vent, "d1");
  const [newest] = runsOf("d1");
  assert.equal(newest!.verdict, "missed");
  assert.equal(newest!.after?.verdict, "met");
  assert.deepEqual(newest!.after?.metrics, result(100));
  assert.deepEqual(modes("d1"), ["after"]);
  assert.deepEqual((await row("d1")).last, { verdict: "met", at: now - HOUR, streak: 0, afterJob: true });
  // The precheck keeps no state from an after-job measure, and a second look measures nothing again.
  assert.throws(() => readFileSync(join(chatDir(), "duties", "d1.state.json")));
  await s.app.boards.afterJob(ids.vent, "d1");
  assert.deepEqual(modes("d1"), ["after"]);
});

test("a job still at work, a job with a wake set and a job pi-host no longer lists keep the run's own verdict", async () => {
  for (const id of ["d2", "d3", "d4"]) await s.app.boards.afterJob(ids.vent, id);
  for (const id of ["d2", "d3", "d4"]) {
    assert.equal(runsOf(id)[0]!.after, undefined, id);
    assert.deepEqual(modes(id), [], id);
  }
  assert.equal((await row("d2")).last?.afterJob, false);
});

test("the job's end measures its run once its subagents are idle too", async () => {
  const host = s.host as FixtureHost;
  const job = host.threadsById.get("job-working")!;
  job.row.status = "idle";
  const child = host.addChild(job, 1, "helper", now, "running");
  await s.app.threads.refresh();
  await s.app.boards.afterJob(ids.vent, "d2");
  assert.equal(runsOf("d2")[0]!.after, undefined);
  child.status = "idle";
  await s.app.boards.afterJob(ids.vent, "d2");
  assert.equal(runsOf("d2")[0]!.after?.verdict, "met");
});

test("a last job's run with no after-job measure takes the next run's measure", async () => {
  await s.send("POST", `/api/threads/${ids.vent}/duties`, { duty: "d4", action: "run" });
  await until(() => Promise.resolve(runsOf("d4")), runs => runs.length === 2 && !!runs[0]!.job);
  const [newest, older] = runsOf("d4");
  assert.equal(newest!.verdict, "missed");
  assert.equal(older!.after?.verdict, "missed");
  assert.equal(older!.after?.at, newest!.at);
});

test("a missed run's own job ends and the server measures the run after it on its own", async () => {
  await until(() => Promise.resolve(runsOf("d4")), runs => runs[0]!.after !== undefined, 20_000);
  const [newest] = runsOf("d4");
  assert.equal(newest!.after?.verdict, "met");
  assert.deepEqual(modes("d4"), ["run", "after"]);
  assert.deepEqual((await row("d4")).last, { verdict: "met", at: newest!.at, streak: 0, afterJob: true });
});
