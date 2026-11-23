/**
 * A duty job that did not start, because pi-host refused its thread create or its brief's submit while it restarted for an install, starts on
 * a later tick: on the thread a failed try made, with one brief, on the run that measured it, and after a restart of the chat server too.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-start-retry.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import type { DutyFile, DutyStart } from "../../server/boards.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const NAME = "Retry duty";
type File = { runs: Record<string, DutyRunRecord[]>; starts?: Record<string, DutyStart> };
const fileOf = (s: Running): File => s.app.boards.dutyFile(agents.vent);

/** Writes a duty whose precheck misses, so its run has a brief and starts a job. */
async function seedDuty(s: Running, work: string): Promise<void> {
  const now = Date.now();
  const duty = {
    id: "d1", name: NAME, ownerWords: "keep it up", goal: "it stays up", metrics: [{ key: "up", label: "Up", op: ">=", target: 99, headline: true }],
    schedule: { kind: "daily", at: "07:04" }, onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now - HOUR, runCount: 1,
    precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 90 } }))`], cwd: work, timeoutMs: 30_000 },
  };
  await s.app.boards.saveDuties(agents.vent, { duties: [duty], runs: {} } as DutyFile);
}

/** pi-host refuses the next `n` calls of `method`, as it does while it shuts down. */
function refuse(host: FixtureHost, method: "create" | "submit", n: number): void {
  const real = host[method].bind(host) as (...args: unknown[]) => Promise<unknown>;
  let left = n;
  (host as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    const [, input] = args as [string, { requestId?: string } | undefined];
    if (left > 0 && (method === "create" || input?.requestId?.startsWith("duty:"))) {
      left -= 1;
      throw new Error("pi-host is shutting down");
    }
    return real(...args);
  };
}

/** Runs d1 and waits for its record, which names no job since its start failed. */
async function failedRun(s: Running): Promise<DutyStart> {
  await s.send("POST", `/api/threads/${agents.vent}/duties`, { duty: "d1", action: "run" });
  const file = await until(() => Promise.resolve(fileOf(s)), f => (f.runs.d1?.length ?? 0) === 1);
  assert.equal(file.runs.d1![0]!.job, undefined);
  const kept = file.starts?.d1;
  assert.ok(kept, "the run keeps its job that did not start");
  assert.equal(kept.run, file.runs.d1![0]!.at);
  return kept;
}

/** Ticks at each kept start's retry time until the run names its job, and checks one job thread with one brief. */
async function startsOnRetry(s: Running): Promise<void> {
  for (let tries = 0; tries < 10 && !fileOf(s).runs.d1![0]!.job; tries += 1) {
    const kept = fileOf(s).starts?.d1;
    if (kept) await s.app.boards.tick(kept.retryAt);
    await until(() => Promise.resolve(fileOf(s)), f => !!f.runs.d1![0]!.job || f.starts?.d1?.failures !== kept?.failures).catch(() => undefined);
  }
  const file = fileOf(s);
  const [run] = file.runs.d1!;
  assert.ok(run!.job, "the run names its job once a retry started it");
  assert.equal(file.starts, undefined);
  const host = s.host as FixtureHost;
  const jobs = [...host.threadsById.values()].filter(thread => thread.row.name?.startsWith(`${NAME} duty `));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.row.id, run!.job!.id);
  const briefs = (await host.entries(run!.job!.id, { conversation: 1, limit: 50 })).entries.filter(entry => entry.kind === "agent.message");
  assert.equal(briefs.length, 1);
  assert.equal(fileOf(s).runs.d1!.length, 1);
}

async function withServer(body: (s: Running, work: string) => Promise<void>): Promise<void> {
  const s = await start();
  const work = mkdtempSync(join(tmpdir(), "duty-start-retry-"));
  try {
    await seedDuty(s, work);
    await body(s, work);
  } finally {
    await s.close();
    rmSync(work, { recursive: true, force: true });
  }
}

test("a duty job whose brief pi-host refused starts on retry on the thread it made", () => withServer(async s => {
  refuse(s.host as FixtureHost, "submit", 1);
  const kept = await failedRun(s);
  assert.ok(kept.job, "the start keeps the thread its failed try made");
  await startsOnRetry(s);
}));

test("a duty job whose thread pi-host did not make starts on retry with one thread", () => withServer(async s => {
  refuse(s.host as FixtureHost, "create", 1);
  const kept = await failedRun(s);
  assert.equal(kept.job, undefined);
  await startsOnRetry(s);
}));

test("a duty job that did not start while pi-host restarted starts after the chat server restarts too", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "duty-start-retry-data-"));
  const work = mkdtempSync(join(tmpdir(), "duty-start-retry-"));
  let s = await start({ dataDir });
  try {
    await seedDuty(s, work);
    const host = s.host as FixtureHost;
    // pi-host is down for a whole install: the create and the next tries fail, then one made thread's submit fails once more.
    refuse(host, "create", 3);
    refuse(host, "submit", 1);
    await failedRun(s);
    const kept = fileOf(s).starts!.d1!;
    await s.app.boards.tick(kept.retryAt);
    await until(() => Promise.resolve(fileOf(s)), f => (f.starts?.d1?.failures ?? 0) > kept.failures);
    await s.close();
    s = await start({ dataDir, host });
    await startsOnRetry(s);
  } finally {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
