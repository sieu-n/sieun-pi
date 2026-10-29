// Replays the AI harness chat's Wiki dream (d4, daily at 01:30) on 10-29. Its 05:33Z rerun started "wiki dream AI harness developer environment
// 14:33" (01a18629), which wrote its last model reply at 07:54:23Z. From then on every turn it took was an empty assistant message that stopped
// on a pi-pool error, between quota parks (09:06Z to 09:50Z, 09:50Z to 10:10Z) and turn-queue waits. A run at 09:51:56Z found it kept and reset
// its 12 h limit (keptAt), so the 13 d4 runs to 10:38Z skipped beside it with "previous run still working" while wiki_problems rose to 22, and
// nobody worked the wiki. A job whose tree wrote no model reply for STALLED_MS is now replaced, whatever keeps it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties, STALLED_MS } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { treeFilesOf } from "../src/send-once.ts";
import { type Duty, type DutyJobRef, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow, ThreadSchedule } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a18629-2526-733d-8b46-913890f0d177", name: "wiki dream AI harness developer environment 14:33" };
const WRITER = "01a186a7-46f0-748d-84b9-a115bfc438a7";
const STARTED = Date.parse("2026-10-29T05:33:53.000Z");
const KEPT_AT = Date.parse("2026-10-29T09:51:56.170Z");

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 794, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
const reply = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Fixed the page." }], stopReason: "toolUse" } });
const failed = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [], stopReason: "error",
  errorMessage: "pi-pool: claude8@slack.green is limited until 2026-10-29T12:00:00.000Z" } });

async function replay(dir: string, now: string, schedules = new Map<string, ThreadSchedule>()) {
  const agentDir = join(dir, "agent");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(agentDir, "session-artifacts", JOB.id, "sub-c0c8a02f"), { recursive: true });
  await writeFile(join(agentDir, "sessions", `${JOB.id}.jsonl`), [reply("2026-10-29T07:54:23.623Z"),
    ...["09:06:37", "09:50:32", "10:10:02", "10:14:30", "10:18:00", "10:33:00", "10:39:00"].map(time => failed(`2026-10-29T${time}.000Z`))].join("\n") + "\n");
  await writeFile(join(agentDir, "session-artifacts", JOB.id, "sub-c0c8a02f", `${WRITER}.jsonl`), reply("2026-10-29T07:46:10.000Z") + "\n");
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 22 } }));`);
  const store = new DutyStore(dir);
  await store.update(CHAT, duties => {
    duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays healthy", goal: "the wiki stays healthy",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
      createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 240, lastRunAt: STARTED } satisfies Duty);
  });
  await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "rerun", ms: 900, verdict: "missed", keptAt: KEPT_AT,
    metrics: { wiki_problems: { value: 43, target: 0, op: "<=", met: false } }, summary: "wiki_problems 43 (target at most 0)", job: JOB });
  const clock = { now: Date.parse(now) };
  const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, true)]]);
  const retired: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
    rows: async () => [...rows.values()], schedules: async () => schedules, treeFiles: id => treeFilesOf(id, agentDir), log: line => logs.push(line) });
  const duties = new Duties(store, {
    isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
    jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
      retire: async job => { retired.push(job.id); rows.get(job.id)!.archived = true; },
      start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
  });
  return { store, clock, retired, started, logs, duties, agentDir };
}

async function runAt(now: string, setup?: (agentDir: string) => Promise<void>, schedules?: Map<string, ThreadSchedule>) {
  const dir = await mkdtemp(join(tmpdir(), "duty-stalled-"));
  const run = await replay(dir, now, schedules);
  try {
    await setup?.(run.agentDir);
    assert.ok(await run.duties.runNow(CHAT, "d4"));
    await run.duties.settled();
    const latest = (await run.store.runs(CHAT)).find(record => record.at === run.clock.now)!;
    return { latest, retired: run.retired, started: run.started, logs: run.logs };
  } finally { run.duties.close(); await rm(dir, { recursive: true, force: true }); }
}

test("a duty job whose tree wrote no model reply for 90 min is replaced, though a run found it kept 47 min before (Wiki dream, 10-29 10:38Z)", async () => {
  const { latest, retired, started, logs } = await runAt("2026-10-29T10:38:42Z");
  assert.ok(!latest.summary.includes(STILL_WORKING), latest.summary);
  assert.deepEqual(retired, [JOB.id]);
  assert.equal(started.length, 1);
  assert.ok(logs.some(line => line.includes(`(replaced stalled job ${JOB.name} with no model reply in ${STALLED_MS / 60_000} min)`)), logs.join("\n"));
});

test("a stalled duty job is replaced while a quota park keeps it (Wiki dream, 10-29 09:50Z)", async () => {
  const park = new Map<string, ThreadSchedule>([[JOB.id, { kind: "cron", label: "quota-resume", status: "active", expression: "50 9 29 10 *" }]]);
  const { latest, retired, logs } = await runAt("2026-10-29T09:50:10Z", undefined, park);
  assert.ok(!latest.summary.includes(STILL_WORKING), latest.summary);
  assert.deepEqual(retired, [JOB.id]);
  assert.ok(logs.some(line => line.includes(`(replaced stalled job ${JOB.name}, which has an active scheduled job (quota-resume), with no model reply`)), logs.join("\n"));
});

test("a duty job whose page writer replied within 90 min still works on", async () => {
  const { latest, retired } = await runAt("2026-10-29T10:38:42Z", agentDir =>
    writeFile(join(agentDir, "session-artifacts", JOB.id, "sub-c0c8a02f", `${WRITER}.jsonl`), reply("2026-10-29T09:30:00.000Z") + "\n"));
  assert.ok(latest.summary.includes(`${STILL_WORKING} (job ${JOB.name})`), latest.summary);
  assert.deepEqual(retired, []);
});

test("a duty job is not stalled before 90 min have passed since its run started", async () => {
  const { latest, retired } = await runAt("2026-10-29T06:50:00Z", agentDir =>
    writeFile(join(agentDir, "sessions", `${JOB.id}.jsonl`), failed("2026-10-29T06:40:00.000Z") + "\n"));
  assert.ok(latest.summary.includes(`${STILL_WORKING} (job ${JOB.name})`), latest.summary);
  assert.deepEqual(retired, []);
});
