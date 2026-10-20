// Replays 10-20 03:08Z on us-metal02. Update ctl-847650 (Prime 0.9.8-daemon-fix.1-mem.4.2-imi.1) restored the daemon's sessions from 03:07:51Z
// to 03:14:09Z. The restored owner corrections roots read idle until their subagents came back, and the duty runner archived 01a15622 at
// 03:08:28Z ("an older job still up") and 01a1571c at 03:08:49Z ("its turn ended"); the update recorded both under stoppedBeforeRestore, and
// their 5 subagents failed their restore at 03:11:56Z to 03:12:11Z. At 04:33:30Z the runner archived 01a1571c again 9 s after it parked on a
// 429, which cancelled its quota-resume job and the two relays it held.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { processStartId } from "../src/orphan-services.ts";
import { primeUpdateRunning } from "../src/prime-update.ts";
import { dailySlot, type Duty } from "../src/shared/chat-duties.ts";
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
