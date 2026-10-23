// Replays the 5 duty jobs Prime update 2004241-1792651168001 (s3int.3 on us-metal02) recorded as stopped before restore on 10-22, from the
// chat service log and service-archives.json, never by replaying them. The update restored from 06:39:28Z to 06:50:44Z. The chat's revive held
// all 5 for pi-pool slots from 06:32:30Z to 06:37Z, and 2 were parked on their provider quota since 05:11Z. Yet the next runs of Crawler VP's
// d5 (06:41:07Z) and d6 (06:42:17Z) and CI and RepoOps' d4 (06:41:46Z) retired their idle cut jobs, and the check-ins of gpt sol (06:42:48Z)
// and launch main bro (06:44:17Z) replaced theirs as stuck after 121 min. Each archive went out as duty_job_end and Prime wrote owner_archive.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties, STILL_WORKING } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { processStartId } from "../src/orphan-services.ts";
import { primeUpdateRunning } from "../src/prime-update.ts";
import type { Duty, DutyJobRef } from "../src/shared/chat-duties.ts";
import type { SessionRow, ThreadSchedule } from "../src/shared/types.ts";

const MIN = 60_000;
const SOCKET = "/tmp/prime-agent-1001/daemon.sock";
const UPDATE = "2004241-1792651168001";
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const CI = "01a1180e-6567-747f-bf44-452520ebdd1b";
const GPT_SOL = "01a160c9-9906-777e-b624-0bffc6c5f04d";
const LAUNCH = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const ALERTS = { id: "01a16059-a94f-77c5-bcaa-fedc43b8911b", name: "crawler alerts Crawler VP 10-22 06:24" };
const MONITORING = { id: "01a1600d-6895-779b-9185-f9a7941eddbb", name: "ci monitoring CI and RepoOps 05:00" };
const API = { id: "01a16056-0365-77eb-9336-3b8a8565c55e", name: "crawler api Crawler VP 10-22 06:20" };
const SOL = { id: "01a161ea-9c88-75ed-9d30-2ed517894d27", name: "check-in gpt sol (metal 02) 13:42" };
const MAIN = { id: "01a161ec-1dc2-7568-87e4-b4be87488ca9", name: "check-in launch main bro 13:43" };
const STANDING: readonly [string, string, DutyJobRef, number][] = [
  [CRAWLER, "d5", ALERTS, Date.parse("2026-10-21T21:24:00Z")], [CI, "d4", MONITORING, Date.parse("2026-10-21T20:00:00Z")], [CRAWLER, "d6", API, Date.parse("2026-10-21T21:20:00Z")]];
const CHECK_INS: readonly [string, DutyJobRef, number][] = [[GPT_SOL, SOL, Date.parse("2026-10-22T04:42:00Z")], [LAUNCH, MAIN, Date.parse("2026-10-22T04:43:00Z")]];
const QUOTA_RESUME: ThreadSchedule = { kind: "cron", status: "active", expression: "at 2026-10-22T06:52:00.000Z", label: "quota-resume", nextRunAt: "2026-10-22T06:52:00.000Z" };

async function status(agentDir: string, phase: string): Promise<void> {
  await mkdir(join(agentDir, "update-restarts"), { recursive: true });
  await writeFile(join(agentDir, "update-restarts", "ctl-1986251-1792651167.json"), JSON.stringify({ version: 1, requestId: UPDATE, socketPath: SOCKET, phase,
    coordinator: { pid: process.pid, processStartId: await processStartId(process.pid) }, counts: { total: 127, restored: 0, resumed: 0, failed: 0 },
    startedAt: "2026-10-22T06:39:28.001Z" }));
}

const row = (id: string, name: string, cwd: string, working: boolean): SessionRow => ({ id, name, cwd, kind: "root", status: working ? "working" : "idle", archived: false,
  messageCount: 40, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);

async function replay(dir: string) {
  const agentDir = join(dir, "agent");
  await status(agentDir, "restoring");
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { alerts: 2 } }));`);
  const store = new DutyStore(dir);
  const clock = { now: Date.parse("2026-10-22T06:41:07.450Z") };
  const missed = { alerts: { value: 2, target: 0, op: "<=" as const, met: false } };
  for (const [chat, id, job, at] of STANDING) {
    await store.update(chat, duties => {
      duties.push({ id, name: job.name.split(" ").slice(0, 2).join(" "), ownerWords: "no alert fires", goal: "no alert fires",
        metrics: [{ key: "alerts", label: "Alerts", op: "<=", target: 0, headline: true }], schedule: { kind: "every", minutes: 15 },
        precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the alert", status: "active",
        createdAt: at - 60 * MIN, updatedAt: at - 60 * MIN, runCount: 4, lastRunAt: at } satisfies Duty);
    });
    await store.appendRun(chat, { duty: id, at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: missed, summary: "alerts 2", job });
  }
  for (const [chat, job, at] of CHECK_INS) {
    await store.updateFile(chat, file => { file.checkIn = { createdAt: at - 24 * 60 * MIN, runCount: 9 }; });
    await store.appendRun(chat, { duty: "checkin", at, slot: at, trigger: "schedule", ms: 8000, verdict: "met", metrics: {}, summary: "all on target", job });
  }
  const rows = new Map<string, SessionRow>();
  for (const [id, name] of [[CRAWLER, "Crawler VP"], [CI, "CI and RepoOps"], [GPT_SOL, "gpt sol (metal 02)"], [LAUNCH, "launch main bro"]] as const) rows.set(id, row(id, name, dir, false));
  // The cut duty jobs read idle; the 2 check-ins read working, as the runner's "working 121 min" says.
  for (const [, , job] of STANDING) rows.set(job.id, row(job.id, job.name, dir, false));
  for (const [, job] of CHECK_INS) rows.set(job.id, row(job.id, job.name, dir, true));
  const pool = { held: new Set([ALERTS.id, MONITORING.id, API.id, SOL.id, MAIN.id]), quota: new Map([[SOL.id, QUOTA_RESUME], [MAIN.id, QUOTA_RESUME]]) };
  const retired: string[] = [];
  const archived: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async job => { archived.push(job.id); } }, registry: {} as never, board: id => id,
    rows: async () => [...rows.values()], schedules: async () => pool.quota, held: () => pool.held, log: line => logs.push(line) });
  const duties = new Duties(store, {
    isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
    updating: () => primeUpdateRunning(agentDir, SOCKET),
    jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
      retire: async job => { retired.push(job.id); rows.get(job.id)!.archived = true; },
      start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, dir, true)); return { id, name }; } },
  });
  const checkIn = (chat: string) => duties.checkIn(chat, { at: clock.now, trigger: "schedule", everyMs: 120 * MIN, classes: {}, findings: "",
    output: { metrics: { goal_gaps: 0, stuck_steps: 0, no_done_line: 0, plan_risks: 0 }, flagged: [] } });
  const all = async () => { await duties.tick(); await duties.settled(); for (const [chat] of CHECK_INS) await checkIn(chat); };
  const summaries = async () => (await Promise.all([CRAWLER, CI, GPT_SOL, LAUNCH].map(chat => store.runs(chat)))).flat().filter(run => run.at === clock.now).map(run => run.summary);
  return { agentDir, clock, pool, rows, retired, archived, started, logs, duties, host, all, summaries };
}

test("no duty rollover or stuck-job replacement archives a job pi-pool holds or a quota park waits on, during a Prime restore or after it (s3int.3, 10-22 06:41Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-held-rollover-"));
  const run = await replay(dir);
  try {
    await run.all();
    assert.deepEqual(run.retired, [], "06:41:07Z to 06:44:17Z: the restore was running, and the runs retired all 5");
    assert.deepEqual(run.started, []);
    const during = await run.summaries();
    assert.equal(during.length, 5);
    for (const summary of during) assert.ok(summary.includes(`${STILL_WORKING} (job `) && summary.includes(`is kept while Prime update ${UPDATE} is restoring`), summary);

    await status(run.agentDir, "complete");
    run.clock.now = Date.parse("2026-10-22T06:56:10Z");
    await run.all();
    assert.deepEqual(run.retired, [], "after the restore the holds still keep all 5");
    const after = await run.summaries();
    assert.equal(after.filter(summary => summary.includes("waits on pi-pool for its slot")).length, 5, after.join("\n"));

    run.pool.held.clear();
    run.clock.now = Date.parse("2026-10-22T07:11:10Z");
    await run.all();
    assert.deepEqual(run.retired.sort(), [ALERTS.id, MONITORING.id, API.id].sort(), "the idle cut jobs retire once pi-pool holds them no more");
    const parked = await run.summaries();
    assert.equal(parked.filter(summary => summary.includes("has an active scheduled job (quota-resume)")).length, 2, parked.join("\n"));

    run.pool.quota.clear();
    run.clock.now = Date.parse("2026-10-22T07:26:10Z");
    await run.all();
    assert.equal(run.retired.length, 3, "a check-in's stuck limit counts from the last run that kept it, 07:11:10Z");

    run.clock.now = Date.parse("2026-10-22T09:12:10Z");
    await run.all();
    assert.ok([SOL.id, MAIN.id].every(id => run.retired.includes(id)), "a check-in still working past its stuck limit is replaced once nothing holds it");
    assert.ok(run.logs.some(line => line.includes("(replaced stuck job check-in gpt sol (metal 02) 13:42, working")), run.logs.join("\n"));
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an ended duty job pi-pool holds is not stopped, and stops once the hold ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-held-ended-"));
  const run = await replay(dir);
  try {
    run.pool.quota.clear();
    assert.deepEqual(await run.host.ended!([], [ALERTS, MONITORING]), []);
    assert.equal(run.logs.filter(line => line === `duty job ${ALERTS.name}: not stopped, it waits on pi-pool for its slot`).length, 1);
    run.pool.held.delete(ALERTS.id);
    assert.deepEqual((await run.host.ended!([], [ALERTS, MONITORING])).map(job => job.id), [ALERTS.id]);
    assert.equal(await run.host.kept!(MONITORING), "waits on pi-pool for its slot");
    run.rows.get(MONITORING.id)!.archived = true;
    assert.equal(await run.host.kept!(MONITORING), null, "an archived job is never kept");
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});
