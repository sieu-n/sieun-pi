/**
 * A duty run and an after-job measure whose precheck still runs when the chat server dies: systemd stops the server's whole control group,
 * as this test kills the first server's process group. The precheck runs outside that group, and the next server process records it once.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-restart.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const self = fileURLToPath(import.meta.url);
const appsChat = join(dirname(self), "..", "..");
const metric = { key: "up", label: "Up", op: ">=" as const, target: 99, headline: true };
const result = (value: number) => ({ up: { value, target: 99, op: ">=" as const, met: value >= 99 } });

/** A precheck that logs each mode it starts in, then takes 1.5 s, and reads `run` on a run and 100 after its job. */
const duty = (work: string, now: number, run: number) => ({
  id: "d1", name: "Restart duty", ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "daily", at: "07:04" },
  precheck: { command: ["node", "-e", `const fs = require("fs"); const mode = process.env.PRECHECK_MODE;
fs.appendFileSync(require("path").join(process.cwd(), "modes"), mode + "\\n");
setTimeout(() => fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: mode === "after" ? 100 : ${run} } })), 1500);`], cwd: work, timeoutMs: 30_000 },
  onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now - HOUR, runCount: 2,
});
const jobRun = (at: number): DutyRunRecord => ({
  duty: "d1", at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: result(90), summary: "up 90", job: { id: "job-ended", name: "Duty d1 job" },
} as DutyRunRecord);

/**
 * The first server: it writes the duty, starts a run or the after-job measure of an ended job, and stays up until the test kills it. In
 * `ended` the run misses, and the server hangs in the submit of the duty job's brief, after its precheck ended and its job was made.
 */
async function firstServer(mode: string, dataDir: string, work: string): Promise<void> {
  const now = Date.now();
  const s = await start({ dataDir });
  mkdirSync(s.app.boards.dir(agents.vent), { recursive: true });
  writeFileSync(join(work, "duties-path"), s.app.boards.dutiesPath(agents.vent));
  writeFileSync(s.app.boards.dutiesPath(agents.vent), JSON.stringify({ duties: [duty(work, now, mode === "ended" ? 90 : 99.5)], runs: mode === "after" ? { d1: [jobRun(now - HOUR)] } : {} }));
  if (mode === "ended") {
    (s.host as FixtureHost).beforeSubmit = async (_thread, input) => {
      if (!input.requestId?.startsWith("duty:")) return;
      writeFileSync(join(work, "submitting"), "");
      await new Promise(() => {});
    };
  }
  if (mode !== "after") {
    await s.app.boards.dutyAction(agents.vent, { action: "run", duty: "d1" });
  } else {
    (s.host as FixtureHost).addThread({ id: "job-ended", name: "Duty d1 job", createdAt: now - HOUR });
    await s.app.threads.refresh();
    void s.app.boards.afterJob(agents.vent, "d1");
  }
}

const child = process.env.DUTY_RESTART_CHILD;
if (child) await firstServer(child, process.env.DUTY_RESTART_DATA!, process.env.DUTY_RESTART_WORK!);

const modes = (work: string): string[] => { try { return readFileSync(join(work, "modes"), "utf8").trim().split("\n"); } catch { return []; } };
type Pending = { launch: { exit: string; script: string; output: string }; job?: { id: string; name: string } };
const readFile = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { runs: Record<string, DutyRunRecord[]>; pending?: Record<string, Pending> };
const fileOf = (s: Running) => readFile(s.app.boards.dutiesPath(agents.vent));

/**
 * Starts the first server in its own process group, waits until its precheck started (or for `ended` until it hangs in the job's submit),
 * kills the group, and starts the next server on its data. `before` reads the duties file between the two and can give the next server's
 * host, as pi-host keeps the threads the first server made.
 */
async function restartMidPrecheck(mode: "run" | "after" | "ended", before?: (dataDir: string, work: string) => FixtureHost):
  Promise<{ s: Running; work: string; cleanup: () => Promise<void> }> {
  const dataDir = mkdtempSync(join(tmpdir(), "duty-restart-data-"));
  const work = mkdtempSync(join(tmpdir(), "duty-restart-work-"));
  const log = openSync(join(work, "first-server.log"), "w");
  const first = spawn(process.execPath, ["--import", "tsx", self], {
    cwd: appsChat, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, DUTY_RESTART_CHILD: mode, DUTY_RESTART_DATA: dataDir, DUTY_RESTART_WORK: work },
  });
  closeSync(log);
  const exited = new Promise(resolve => first.once("exit", resolve));
  try {
    await until(() => Promise.resolve(mode === "ended" ? existsSync(join(work, "submitting")) : modes(work).length > 0), ready => ready, 60_000);
  } catch (error) {
    throw new Error(`${String(error)}; first server log: ${readFileSync(join(work, "first-server.log"), "utf8").slice(-2000)}`);
  } finally {
    process.kill(-first.pid!, "SIGKILL");
    await exited;
  }
  const host = before?.(dataDir, work);
  const s = await start({ dataDir, ...(host ? { host } : {}) });
  return { s, work, cleanup: async () => {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  } };
}

if (!child) test("a duty run whose server dies during its precheck is recorded once by the next server", async () => {
  const { s, work, cleanup } = await restartMidPrecheck("run");
  try {
    await until(() => Promise.resolve(fileOf(s).runs.d1 ?? []), runs => runs.length > 0, 20_000);
    // A second precheck or a second record would show within this time.
    await sleep(3000);
    const file = fileOf(s);
    assert.equal(file.runs.d1!.length, 1);
    const [run] = file.runs.d1!;
    assert.equal(run!.verdict, "met");
    assert.equal(run!.trigger, "owner");
    assert.deepEqual(run!.metrics, result(99.5));
    assert.equal(file.pending, undefined);
    assert.deepEqual(modes(work), ["run"]);
    assert.equal((await s.get<{ duties: { running: boolean }[] }>(`/api/threads/${agents.vent}/duties`)).duties[0]!.running, false);
  } finally {
    await cleanup();
  }
});

if (!child) test("an after-job measure whose server dies during its precheck lands on its run once by the next server", async () => {
  const { s, work, cleanup } = await restartMidPrecheck("after");
  try {
    await until(() => Promise.resolve(fileOf(s).runs.d1!), runs => runs[0]!.after !== undefined, 20_000);
    await sleep(3000);
    const file = fileOf(s);
    assert.equal(file.runs.d1!.length, 1);
    assert.equal(file.runs.d1![0]!.verdict, "missed");
    assert.equal(file.runs.d1![0]!.after?.verdict, "met");
    assert.deepEqual(file.runs.d1![0]!.after?.metrics, result(100));
    assert.equal(file.pending, undefined);
    assert.deepEqual(modes(work), ["after"]);
    // The after-job measure keeps no precheck state.
    assert.throws(() => readFileSync(join(s.app.boards.dir(agents.vent), "duties", "d1.state.json")));
  } finally {
    await cleanup();
  }
});


if (!child) test("a run whose server dies after its precheck ended and its job was made reads the same output and submits to the same job", async () => {
  let pending: Pending | undefined;
  const { s, work, cleanup } = await restartMidPrecheck("ended", (dataDir, work) => {
    pending = readFile(readFileSync(join(work, "duties-path"), "utf8")).pending?.d1;
    const host = new FixtureHost();
    host.wordMs = 0;
    seedFixture(host, dataDir);
    if (pending?.job) host.addThread({ id: pending.job.id, name: pending.job.name, createdAt: Date.now() });
    return host;
  });
  try {
    assert.ok(pending?.job, "the first server wrote the job it made into the pending run");
    assert.ok(existsSync(pending.launch.exit), "the precheck ended before the stop");
    // The job ends at once on the fixture host, so its after-job measure follows the run.
    await until(() => Promise.resolve(fileOf(s)), file => file.runs.d1?.[0]?.after !== undefined && file.pending === undefined, 30_000);
    await sleep(3000);
    const file = fileOf(s);
    assert.equal(file.runs.d1!.length, 1);
    const [run] = file.runs.d1!;
    assert.equal(run!.verdict, "missed");
    assert.deepEqual(run!.metrics, result(90));
    assert.equal(run!.job?.id, pending.job.id);
    assert.equal(file.pending, undefined);
    assert.deepEqual(modes(work), ["run", "after"]);
    assert.ok(!existsSync(pending.launch.exit) && !existsSync(pending.launch.script), "the wrapper and its exit file go once the run is saved");
    assert.ok(existsSync(pending.launch.output));
    const host = s.host as FixtureHost;
    assert.equal([...host.threadsById.values()].filter(thread => thread.row.name === pending!.job!.name).length, 1);
    const briefs = (await host.entries(pending.job.id, { conversation: 1, limit: 50 })).entries.filter(entry => entry.kind === "agent.message");
    assert.equal(briefs.length, 1);
  } finally {
    await cleanup();
  }
});
