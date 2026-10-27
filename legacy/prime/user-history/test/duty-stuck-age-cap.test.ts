// Replays the AI harness chat's Wiki dream (d4, daily at 01:30) from its 10-27 runs file. Its run of 10-26 22:32:41Z started the job "wiki dream
// AI harness developer environment 07:32" (01a17a59). 8 runs up to 08:35Z found it in pi-pool's turn queue, and a run at 14:30:29Z kept it
// again, and each such run reset the 12 h stuck limit (keptAt). All 15 d4 runs from 23:34Z to 16:49Z skipped with "previous run still working"
// and handed it 345 items, 18 h after its run started, so the duty never got a fresh job.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type Duty, type DutyJobRef, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a17a59-eaee-747c-a7f5-80c9cf0228bf", name: "wiki dream AI harness developer environment 07:32" };
const STARTED = Date.parse("2026-10-26T22:32:41.169Z");
const KEPT_AT = Date.parse("2026-10-27T14:30:29.611Z");

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 624, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);

async function replay(dir: string) {
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 55 } }));`);
  const store = new DutyStore(dir);
  await store.update(CHAT, duties => {
    duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays healthy", goal: "the wiki stays healthy",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
      createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 199, lastRunAt: STARTED } satisfies Duty);
  });
  await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "push", ms: 900, verdict: "met", keptAt: KEPT_AT,
    metrics: { wiki_problems: { value: 0, target: 0, op: "<=", met: true } }, summary: "wiki_problems 0 (on target)", job: JOB });
  const clock = { now: Date.parse("2026-10-27T16:49:21.594Z") };
  const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, true)]]);
  const retired: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
    rows: async () => [...rows.values()], log: line => logs.push(line) });
  const duties = new Duties(store, {
    isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
    jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
      retire: async job => { retired.push(job.id); rows.get(job.id)!.archived = true; },
      start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
  });
  return { store, clock, retired, started, logs, duties };
}

test("a duty job still working 12 h after its run started is replaced, however recently a run found it kept (Wiki dream, 10-27 16:49Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stuck-age-"));
  const run = await replay(dir);
  try {
    assert.ok(await run.duties.runNow(CHAT, "d4"));
    await run.duties.settled();
    const latest = (await run.store.runs(CHAT)).find(record => record.at === run.clock.now)!;
    assert.ok(!latest.summary.includes(STILL_WORKING), latest.summary);
    assert.deepEqual(run.retired, [JOB.id], "18 h after its run started, the job was kept 139 min before and the run skipped beside it");
    assert.equal(run.started.length, 1);
    assert.ok(run.logs.some(line => line.includes(`(replaced stuck job ${JOB.name}, working 18 h since its run started)`)), run.logs.join("\n"));
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a duty job kept recently and within 12 h of its run start still works on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stuck-age-"));
  const run = await replay(dir);
  try {
    run.clock.now = Date.parse("2026-10-27T10:06:37Z");
    await run.store.updateRun(CHAT, "d4", STARTED, record => { record.keptAt = Date.parse("2026-10-27T08:35:08Z"); });
    assert.ok(await run.duties.runNow(CHAT, "d4"));
    await run.duties.settled();
    const latest = (await run.store.runs(CHAT)).find(record => record.at === run.clock.now)!;
    assert.ok(latest.summary.includes(`${STILL_WORKING} (job ${JOB.name})`), latest.summary);
    assert.deepEqual(run.retired, []);
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
});
