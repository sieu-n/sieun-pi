// Replays vent's check-in job "check-in vent 13:47" (01a16715) from the 10-23 runs file and pi-pool.log. Its run started at 04:47:17Z, its
// first turn parked for an account until 08:10Z, and each check-in from 05:17Z to 07:47Z kept it because pi-pool held it. At 08:10:02Z the
// account came free and its turn went into the turn queue, 62nd. The 08:17:34Z check-in read it as working 210 min and replaced it as
// stuck, after 0 s of work, and the new job "check-in vent 17:17" asked again 127th and waited 38 min. From 10-21 17:00Z to 10-23 08:44Z the
// runner replaced 160 duty jobs as stuck, 154 of them while pi-pool held their turn (~/work/d9-duties-green-2/findings.md).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost, turnQueueWait } from "../src/chat-duty-job.ts";
import { Duties, STILL_WORKING } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { DutyJobRef } from "../src/shared/chat-duties.ts";
import type { AgentQueueReading, SessionRow } from "../src/shared/types.ts";

const MIN = 60_000;
const VENT = "01a14dd5-e9d3-705d-bd63-245c21b2eee2";
const JOB: DutyJobRef = { id: "01a16715-b8c3-74ad-82cc-b5edfa278b5e", name: "check-in vent 13:47" };
const STARTED = Date.parse("2026-10-23T04:47:17.098Z");

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 2, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);

type Queue = Pick<AgentQueueReading, "working" | "queued">;
const queuedAt = (tree: string, position: number, total: number): Queue =>
  ({ working: [], queued: [{ session: tree, tree, since: Date.parse("2026-10-23T05:06:00Z") / 1000, position, total, waitMs: 0 }] });

async function replay(dir: string) {
  const store = new DutyStore(dir);
  await store.updateFile(VENT, file => { file.checkIn = { createdAt: STARTED - 24 * 60 * MIN, runCount: 40 }; });
  await store.appendRun(VENT, { duty: "checkin", at: STARTED, slot: STARTED, trigger: "schedule", ms: 6000, verdict: "met", metrics: {}, summary: "all 4 on target", job: JOB });
  const clock = { now: Date.parse("2026-10-23T07:47:34.116Z") };
  const rows = new Map<string, SessionRow>([[VENT, row(VENT, "vent", false)], [JOB.id, row(JOB.id, JOB.name, true)]]);
  const pool = { held: new Set([JOB.id]), queue: { working: [], queued: [] } as Queue };
  const retired: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
    rows: async () => [...rows.values()], held: () => pool.held, queue: async () => pool.queue, log: line => logs.push(line) });
  const duties = new Duties(store, {
    isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
    jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
      retire: async job => { retired.push(job.id); rows.get(job.id)!.archived = true; },
      start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
  });
  const checkIn = async (at: string) => {
    clock.now = Date.parse(at);
    await duties.checkIn(VENT, { at: clock.now, trigger: "schedule", everyMs: 30 * MIN, classes: {}, findings: "",
      output: { metrics: { goal_gaps: 0, stuck_steps: 0, no_done_line: 0, plan_risks: 0 }, flagged: [] } });
    return (await store.runs(VENT)).find(run => run.at === clock.now)!;
  };
  return { store, pool, retired, started, logs, duties, checkIn };
}

test("a duty job whose turn waits in pi-pool's turn queue is kept, and its stuck limit counts from the last run that kept it (vent check-in, 10-23 08:17Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-turn-queue-"));
  const run = await replay(dir);
  try {
    const held = await run.checkIn("2026-10-23T07:47:34.116Z");
    assert.match(held.summary, /waits on pi-pool for its slot\)$/);

    run.pool.held.clear();
    run.pool.queue = queuedAt(JOB.id, 62, 62);
    const queued = await run.checkIn("2026-10-23T08:17:34.916Z");
    assert.deepEqual(run.retired, [], "08:17:34Z: the job had not worked a second, and the runner replaced it as stuck after 210 min");
    assert.equal(queued.summary, `${STILL_WORKING} (job ${JOB.name} waits 62 of 62 in pi-pool's turn queue)`);
    const keptAt = (await run.store.runs(VENT)).find(record => record.at === STARTED)!.keptAt;
    assert.equal(keptAt, Date.parse("2026-10-23T08:17:34.916Z"));

    run.pool.queue = { working: [{ session: JOB.id, tree: JOB.id, since: Date.parse("2026-10-23T08:40:00Z") / 1000, kind: "slot" }], queued: [] };
    const working = await run.checkIn("2026-10-23T08:47:50.187Z");
    assert.deepEqual(run.retired, [], "30 min after its last hold the job works on, though 240 min passed since its run started");
    assert.equal(working.summary, `${STILL_WORKING} (job ${JOB.name})`);

    await run.checkIn("2026-10-23T09:48:00Z");
    assert.deepEqual(run.retired, [JOB.id], "past 90 min of work after its last hold, a working job is stuck");
    assert.ok(run.logs.some(line => line.includes(`(replaced stuck job ${JOB.name}, working 90 min)`)), run.logs.join("\n"));
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});

test("turnQueueWait keeps a tree only while it has a queued run and no run in a working slot", () => {
  assert.equal(turnQueueWait({ working: [], queued: [] }, JOB.id), null);
  const sub = { session: "01a16800-0000-7000-8000-000000000001", tree: JOB.id, since: 0, position: 9, total: 87, waitMs: 0 };
  assert.equal(turnQueueWait({ working: [], queued: [sub, { ...sub, session: JOB.id, position: 30 }] }, JOB.id), "waits 9 of 87 in pi-pool's turn queue");
  assert.equal(turnQueueWait({ working: [{ session: JOB.id, tree: JOB.id, since: 0, kind: "slot" }], queued: [sub] }, JOB.id), null);
  assert.equal(turnQueueWait({ working: [], queued: [{ ...sub, tree: "01a1ffff-0000-7000-8000-000000000000" }] }, JOB.id), null);
});
