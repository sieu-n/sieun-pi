// Replays 10-20 03:08Z on us-metal02. Update ctl-847650 (Prime 0.9.8-daemon-fix.1-mem.4.2-imi.1) restored the daemon's sessions from 03:07:51Z
// to 03:14:09Z. The restored owner corrections roots read idle until their subagents came back, and the duty runner archived 01a15622 at
// 03:08:28Z ("an older job still up") and 01a1571c at 03:08:49Z ("its turn ended"); the update recorded both under stoppedBeforeRestore, and
// their 5 subagents failed their restore at 03:11:56Z to 03:12:11Z. At 04:33:30Z the runner archived 01a1571c again 9 s after it parked on a
// 429, which cancelled its quota-resume job and the two relays it held.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import type { ChatBackend } from "../src/chat-backend.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { type JobTree, treeWait } from "../src/duty-tree-wait.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { startChatServer } from "../src/chat-server.ts";
import { processStartId } from "../src/orphan-services.ts";
import { primeUpdateRunning } from "../src/prime-update.ts";
import { dailySlot, type Duty } from "../src/shared/chat-duties.ts";
import type { TargetState } from "../src/send-once.ts";
import type { Wake } from "../src/wakes.ts";
import type { SessionRow, ThreadSchedule } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const NOW = Date.parse("2026-10-20T03:08:28.490Z");
const SOCKET = "/tmp/prime-agent-1001/daemon.sock";
const OLDER = { id: "01a15622-381c-726c-b60b-ac774769423b", name: "owner corrections AI harness developer environment 06:46" };
const LAST = { id: "01a1571c-c2e4-7169-a603-77d3e4ff7ec1", name: "owner corrections AI harness developer environment 11:20" };

async function status(agentDir: string, phase: string, coordinator: { pid: number; processStartId: string | null }): Promise<void> {
  await mkdir(join(agentDir, "update-restarts"), { recursive: true });
  await writeFile(join(agentDir, "update-restarts", "ctl-847650-1792465670.json"), JSON.stringify({ version: 1, requestId: "874543-1792465671260",
    socketPath: SOCKET, phase, coordinator, counts: { total: 148, restored: 0, resumed: 0, failed: 0 }, startedAt: "2026-10-20T03:07:51.260Z" }));
}

test("no duty job stops while a Prime update restores the daemon's sessions, and both stop once it completes (10-20 03:08Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-update-hold-"));
  try {
    const agentDir = join(dir, "agent");
    const own = { pid: process.pid, processStartId: await processStartId(process.pid) };
    await status(agentDir, "restoring", own);
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { repeats: 0 } }));`);
    const store = new DutyStore(dir);
    const lastSlotAt = dailySlot("11:20", NOW);
    const duty: Duty = {
      id: "d10", name: "Owner corrections", ownerWords: "repeat corrections get fixed", goal: "no correction repeats",
      metrics: [{ key: "repeats", label: "Repeats", op: "<=", target: 0, headline: true }],
      schedule: { kind: "daily", at: "11:20" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the repeat",
      status: "active", createdAt: NOW - 48 * 60 * MIN, updatedAt: NOW - 48 * 60 * MIN, runCount: 2, lastSlotAt, lastRunAt: lastSlotAt,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const missed = { repeats: { value: 3, target: 0, op: "<=" as const, met: false } };
    for (const [at, job] of [[Date.parse("2026-10-19T06:46:00Z"), OLDER], [Date.parse("2026-10-19T11:20:00Z"), LAST]] as const) {
      await store.appendRun(CHAT, { duty: "d10", at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: missed, summary: "repeats 3", job });
    }
    const stopped: string[] = [];
    const lines: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath, log: line => lines.push(line),
      updating: () => primeUpdateRunning(agentDir, SOCKET),
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => ({ id: `job-${name}`, name }),
        ended: async (last, older = []) => [...last, ...older],
        stop: async job => { stopped.push(job.id); },
      },
    });
    await duties.tick();
    await duties.settled();
    assert.deepEqual(stopped, []);
    assert.equal(lines.filter(line => line.includes("Prime update 874543-1792465671260 is restoring; no duty job stops until it ends")).length, 1);
    await status(agentDir, "complete", own);
    await duties.tick();
    await duties.settled();
    duties.close();
    assert.deepEqual(stopped.sort(), [OLDER.id, LAST.id].sort());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an update counts only while its coordinator runs and works on this daemon's socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prime-update-running-"));
  try {
    const own = { pid: process.pid, processStartId: await processStartId(process.pid) };
    await status(dir, "restoring", own);
    assert.equal((await primeUpdateRunning(dir, SOCKET))?.phase, "restoring");
    assert.equal(await primeUpdateRunning(dir, "/tmp/prime-agent-1001/other.sock"), null);
    await status(dir, "restoring", { pid: process.pid, processStartId: "proc:1" });
    assert.equal(await primeUpdateRunning(dir, SOCKET), null, "a reused pid is no coordinator");
    for (const phase of ["complete", "failed", "skipped"]) {
      await status(dir, phase, own);
      assert.equal(await primeUpdateRunning(dir, SOCKET), null, phase);
    }
    assert.equal(await primeUpdateRunning(join(dir, "none"), SOCKET), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const row = (id: string, name: string): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "live", status: "idle", archived: false, messageCount: 97,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user" }) as SessionRow;

test("a job whose quota-resume job is pending has not ended, and no job ends when the daemon's scheduled jobs do not read (10-20 04:33:30Z)", async () => {
  const quotaResume: ThreadSchedule = { kind: "cron", status: "active", expression: "at 2026-10-20T05:43:52.027Z", label: "quota-resume", nextRunAt: "2026-10-20T05:43:52.027Z" };
  let schedules: () => Promise<ReadonlyMap<string, ThreadSchedule>> = async () => new Map([[LAST.id, quotaResume]]);
  const lines: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id, log: line => lines.push(line),
    rows: async () => [row(LAST.id, LAST.name), row(OLDER.id, OLDER.name)], schedules: () => schedules() });
  assert.deepEqual((await host.ended!([], [LAST, OLDER])).map(job => job.id), [OLDER.id]);
  schedules = async () => { throw new Error("daemon not connected"); };
  assert.deepEqual(await host.ended!([], [LAST, OLDER]), []);
  assert.match(lines.join("\n"), /no job stops this scan, the daemon's scheduled jobs did not read: daemon not connected/);
});

// The interval after ctl-847650 wrote "complete" at 03:14:09Z: the coordinator no longer holds anything, and each owner corrections root reads
// idle on its own row while its subagents come back, sit in the daemon's queue, or wait on input and relays.
const DONE = Date.parse("2026-10-20T03:14:39Z");
const C79 = "01a1563d-7362-716f-84e0-244f845d6c91";
const C110 = "01a15737-6170-771d-b544-29499433f1a9";
const C48 = "01a15737-69a5-73c0-b238-6746de5acce6";

const summary = (sessionId: string, name: string, parent: string | undefined, fields: Partial<SessionSummary> = {}): SessionSummary => ({ id: sessionId, sessionId,
  sessionName: name, cwd: "/home/sieun", lifecycle: "live", activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0,
  messageCount: 40, sessionActions: { queuedCount: 0, steering: [], followUps: [] }, activeSessionId: `active-${sessionId}`, workerState: "ready",
  ...parent ? { parentSessionId: parent, runtimeKind: "subagent" as const } : {}, ...fields }) as SessionSummary;

/** The two owner corrections trees as the daemon lists them; `set` and `clear` change one session's fields. */
function trees() {
  const rows = new Map<string, SessionSummary>([
    [OLDER.id, summary(OLDER.id, OLDER.name, undefined)], [LAST.id, summary(LAST.id, LAST.name, undefined)],
    [C79, summary(C79, "repeat c79", OLDER.id)], [C110, summary(C110, "c110-plan-vs-duty", LAST.id)], [C48, summary(C48, "c48-ui-reference", LAST.id)]]);
  const queues = new Map<string, TargetState>();
  let relays: { id: string; threadId: string }[] = [];
  let wakes: Wake[] = [];
  let relayCalls = 0;
  const tree: JobTree = {
    sessions: id => [...rows.values()].filter(row => row.sessionId === id || row.parentSessionId === id),
    queue: async session => queues.get(session) ?? { queued: [], busy: false },
    relay: async sessions => { relayCalls++; return relays.find(entry => sessions.has(entry.threadId)); },
    wakes: async () => wakes,
  };
  return {
    tree, queues,
    set: (id: string, fields: Partial<SessionSummary>) => { rows.set(id, { ...rows.get(id)!, ...fields }); },
    clear: (id: string, field: keyof SessionSummary) => { const { [field]: _dropped, ...rest } = rows.get(id)!; rows.set(id, rest as SessionSummary); },
    relays: (next: typeof relays) => { relays = next; },
    wakes: (next: Wake[]) => { wakes = next; },
    relayCalls: () => relayCalls,
  };
}

async function completedRunner(dir: string, tree: JobTree, jobs: readonly { id: string; name: string }[],
  options: { rows?: () => SessionRow[]; schedules?: () => Promise<ReadonlyMap<string, ThreadSchedule>> } = {}) {
  const agentDir = join(dir, "agent");
  await status(agentDir, "complete", { pid: process.pid, processStartId: await processStartId(process.pid) });
  const measures = join(dir, "measures");
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { appendFileSync, writeFileSync } from "node:fs"; appendFileSync(${JSON.stringify(measures)}, "x"); writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { repeats: 0 } }));`);
  const store = new DutyStore(dir);
  const lastSlotAt = dailySlot("11:20", DONE);
  await store.update(CHAT, duties => {
    duties.push({ id: "d10", name: "Owner corrections", ownerWords: "repeat corrections get fixed", goal: "no correction repeats",
      metrics: [{ key: "repeats", label: "Repeats", op: "<=", target: 0, headline: true }],
      schedule: { kind: "daily", at: "11:20" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix the repeat",
      status: "active", createdAt: DONE - 48 * 60 * MIN, updatedAt: DONE - 48 * 60 * MIN, runCount: 2, lastSlotAt, lastRunAt: lastSlotAt });
  });
  const missed = { repeats: { value: 3, target: 0, op: "<=" as const, met: false } };
  for (const [at, job] of [[Date.parse("2026-10-19T06:46:00Z"), OLDER], [Date.parse("2026-10-19T11:20:00Z"), LAST]] as const) {
    if (jobs.some(entry => entry.id === job.id)) await store.appendRun(CHAT, { duty: "d10", at, slot: at, trigger: "schedule", ms: 900, verdict: "missed", metrics: missed, summary: "repeats 3", job });
  }
  const stopped: string[] = [];
  const lines: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async job => { stopped.push(job.id); } }, registry: {} as never, board: id => id, log: line => lines.push(line),
    rows: async () => options.rows?.() ?? jobs.map(job => row(job.id, job.name)), treeWait: (id, scheduled) => treeWait(id, tree, scheduled),
    ...options.schedules ? { schedules: options.schedules } : {} });
  const duties = new Duties(store, {
    isChat: async () => true, now: () => DONE, tickMs: 0, node: process.execPath, log: line => lines.push(line),
    updating: () => primeUpdateRunning(agentDir, SOCKET),
    jobs: { ...host, chat: async id => ({ id, name: "AI harness developer environment", cwd: dir, board: id }), start: async (_chat, name) => ({ id: `job-${name}`, name }) },
  });
  const tick = async () => { await duties.tick(); await duties.settled(); };
  const measured = async () => (await readFile(measures, "utf8").catch(() => "")).length;
  return { duties, stopped, lines, tick, measured, measures };
}

test("after the update completes, a restored root that reads idle stays up while a subagent starts, sits queued or sleeps on a wake, or input or a relay waits for its tree (10-20 03:14:09Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-update-after-"));
  const t = trees();
  const run = await completedRunner(dir, t.tree, [OLDER, LAST]);
  try {
    t.set(C79, { workerState: "starting" });
    t.set(C110, { statusLabel: "queued" });
    await run.tick();
    assert.deepEqual(run.stopped, [], "one tick after the coordinator completed, both roots read idle and neither stops");
    assert.match(run.lines.join("\n"), /owner corrections AI harness developer environment 06:46: not stopped, its subagent repeat c79 is starting/);
    assert.match(run.lines.join("\n"), /owner corrections AI harness developer environment 11:20: not stopped, its subagent c110-plan-vs-duty reads queued/);
    assert.equal(await run.measured(), 0, "a root that has not ended gets no after-job measure");

    t.set(C79, { workerState: "ready" });
    t.clear(C110, "statusLabel");
    t.relays([{ id: "relay-c79", threadId: C79 }]);
    t.queues.set(LAST.id, { queued: ["[agent message from c78-shared-components] report"], busy: false });
    await run.tick();
    assert.deepEqual(run.stopped, []);
    assert.match(run.lines.join("\n"), /06:46: not stopped, agent message relay-c79 waits in the outbox for its subagent repeat c79/);
    assert.match(run.lines.join("\n"), /11:20: not stopped, its root has 1 queued input/);

    t.set(C48, { activity: "working" });
    t.relays([]);
    t.wakes([{ session: C79, root: OLDER.id, on: { kind: "time", at: Date.parse("2026-10-20T09:10:00Z") }, note: "c79 clean-room run-2 window ended", since: Date.parse("2026-10-20T06:03:05Z") }]);
    t.queues.clear();
    await run.tick();
    assert.deepEqual(run.stopped, [], "06:46:06Z: the runner archived the older root while repeat c79 slept on its 09:10Z wake");
    assert.match(run.lines.join("\n"), /06:46: not stopped, its subagent repeat c79 waits on a board.wake at 09:10Z/);
    assert.match(run.lines.join("\n"), /11:20: not stopped, its subagent c48-ui-reference runs/);

    t.wakes([]);
    t.set(C48, { activity: "idle" });
    await run.tick();
    assert.deepEqual(run.stopped, [OLDER.id, LAST.id]);
    assert.equal(await run.measured(), 1);
    assert.equal(run.lines.filter(line => line.includes("its subagent repeat c79 is starting")).length, 1, "a wait that holds is logged once");
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a job whose tree wakes while its after-job measure runs is not stopped, and the next scan stops it without measuring again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-update-recheck-"));
  const t = trees();
  const run = await completedRunner(dir, t.tree, [LAST]);
  try {
    let woke = false;
    const relay = t.tree.relay;
    t.tree.relay = async sessions => {
      if (woke || !existsSync(run.measures)) return relay(sessions);
      woke = true;
      return { id: "report-c78", threadId: LAST.id };
    };
    await run.tick();
    assert.deepEqual(run.stopped, [], "the read right before the stop found c78's report on its way to the root");
    assert.equal(await run.measured(), 1);
    await run.tick();
    assert.deepEqual(run.stopped, [LAST.id]);
    assert.equal(await run.measured(), 1, "the measure the held stop already took counts");
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the hold is the runner's own: the owner's archive of a held root goes through the archive route, and the runner leaves it archived", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-update-owner-"));
  const t = trees();
  let archived = false;
  const run = await completedRunner(dir, t.tree, [LAST], { rows: () => [{ ...row(LAST.id, LAST.name), archived }] });
  const archives: string[] = [];
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const backend = { chats: { archivesAsChat: async () => false, archiveJob: async (id: string) => { archives.push(id); archived = true; } },
    catalog: { notify: async () => {} }, close: async () => {} } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-duty-hold.sock" }, onStop: async () => {} });
  try {
    t.set(C110, { workerState: "starting" });
    await run.tick();
    assert.deepEqual(run.stopped, []);
    const response = await fetch(server.url + `api/threads/${LAST.id}/archive`, {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(archives, [LAST.id], "the owner's archive reaches the thread while the runner holds its own stop");
    t.set(C110, { workerState: "ready" });
    await run.tick();
    assert.deepEqual(run.stopped, [], "the runner queues no second archive of a root the owner archived");
  } finally { await server.close(); run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});

// The 06:46 d10 root on 10-20: the runner archived it as an older job at 06:46:06Z, 06:58:23Z and 07:01:28Z while repeat c129 slept on its
// 07:45Z wake and repeat c79 on its 09:10Z one, and both wakes reach them only through it. A subagent parked on a 429 holds a quota-resume
// scheduled job instead of a wake, as metal01 cpu of check-in ops guy 23:40 did at 04:19:07Z before the runner's 04:20:24Z archive cancelled it.
const C129 = "01a1563d-9bed-7683-ace3-571e199d54c7";
const C72 = "01a1563d-848b-7000-8000-000000000072";

test("an older root stays up while any subagent below it sleeps on a wake or holds a scheduled job, and stops once none does (10-20 06:46:06Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-older-waits-"));
  const t = trees();
  const { activeSessionId: _stopped, ...c129 } = summary(C129, "repeat c129", OLDER.id);
  let listed = true;
  const sessions = (id: string) => id === OLDER.id ? [...t.tree.sessions(OLDER.id), ...listed ? [c129 as SessionSummary, summary(C72, "repeat c72", C129)] : []] : t.tree.sessions(id);
  let scheduled = new Map<string, ThreadSchedule>([[C72, { kind: "cron", status: "active", expression: "at 2026-10-20T08:01:00.000Z", label: "quota-resume", nextRunAt: "2026-10-20T08:01:00.000Z" }]]);
  const run = await completedRunner(dir, { ...t.tree, sessions }, [OLDER, LAST], { schedules: async () => scheduled });
  try {
    t.wakes([{ session: C129, root: OLDER.id, on: { kind: "time", at: Date.parse("2026-10-20T07:45:00Z") }, note: "c129 saved-login run-4 window ended", since: Date.parse("2026-10-20T06:13:14Z") },
      { session: C79, root: OLDER.id, on: { kind: "time", at: Date.parse("2026-10-20T09:10:00Z") }, note: "c79 clean-room run-2 window ended", since: Date.parse("2026-10-20T06:03:05Z") }]);
    await run.tick();
    assert.deepEqual(run.stopped, [LAST.id], "only the 11:20 root, whose tree waits on nothing, stops");
    assert.match(run.lines.join("\n"), /06:46: not stopped, its subagent repeat c72 has an active scheduled job \(quota-resume\)/);

    scheduled = new Map();
    await run.tick();
    assert.deepEqual(run.stopped, [LAST.id]);
    assert.match(run.lines.join("\n"), /06:46: not stopped, its subagent repeat c129 waits on a board.wake at 07:45Z/, "a wake of a subagent the daemon lists only as saved still holds the root it is relayed through");

    listed = false;
    await run.tick();
    assert.deepEqual(run.stopped, [LAST.id], "a wake set for the root's tree holds it even when the daemon does not list the subagent that set it");
    assert.match(run.lines.join("\n"), /06:46: not stopped, 01a1563d waits on a board.wake at 07:45Z/);

    t.wakes([{ session: C79, root: OLDER.id, on: { kind: "time", at: Date.parse("2026-10-20T09:10:00Z") }, note: "c79 clean-room run-2 window ended", since: Date.parse("2026-10-20T06:03:05Z") }]);
    await run.tick();
    assert.deepEqual(run.stopped, [LAST.id]);
    assert.match(run.lines.join("\n"), /06:46: not stopped, its subagent repeat c79 waits on a board.wake at 09:10Z/);

    t.wakes([]);
    await run.tick();
    assert.deepEqual(run.stopped, [LAST.id, OLDER.id]);
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});
