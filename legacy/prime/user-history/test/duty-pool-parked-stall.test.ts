// Replays the AI harness chat's Wiki dream (d4) on 11-09. Its 10:48:15Z push run started "wiki dream AI harness developer environment 19:48"
// (01a1bfed), whose tree made its last model call at 11:05:27Z (pi-pool.log). Its claude19 and claude10 quota ran out, and from 11:40Z its root
// and 14 page writers sat on pi-pool slot waits while the anthropic accounts served 15 model calls in all to 13:04Z. The push runs from 12:22Z
// read 10, 12, 13 and 13 wiki problems beside it, and the 13:08:58Z run replaced it as stalled with no model reply in 90 min. Its tree got its
// account at 13:17:30Z and fixed the 13 pages, and the new job got its first account at 13:25:30Z and found them fixed. A silent job whose tree
// pi-pool parked on a slot is now kept (POOL_PARKED); one whose slot passed over 90 min ago with no new call is still replaced.
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
import type { SessionRow } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a1bfed-b23d-70bf-81bb-6dddd1914ec9", name: "wiki dream AI harness developer environment 19:48" };
const WRITER = "01a1bff8-a92e-73ed-a308-fb0da5351680";
const STARTED = Date.parse("2026-11-09T10:48:15.000Z");
const KEPT_AT = Date.parse("2026-11-09T12:54:42.000Z");
const NOW = "2026-11-09T13:08:58Z";
const PARKED = "pi-pool parked its tree on a slot";

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 120, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
const reply = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Spawned the writers." }], stopReason: "toolUse" } });
const slotWait = (at: string, slot: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", provider: "anthropic", content: [],
  stopReason: "error", errorMessage: `token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at ${slot}.` } });

async function runAt(root: readonly string[], writer: readonly string[]) {
  const dir = await mkdtemp(join(tmpdir(), "duty-pool-parked-"));
  const agentDir = join(dir, "agent");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(join(agentDir, "session-artifacts", JOB.id, "sub-stale-r3"), { recursive: true });
  await writeFile(join(agentDir, "sessions", `${JOB.id}.jsonl`), root.join("\n") + "\n");
  await writeFile(join(agentDir, "session-artifacts", JOB.id, "sub-stale-r3", `${WRITER}.jsonl`), writer.join("\n") + "\n");
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { wiki_problems: 13 } }));`);
  const store = new DutyStore(dir);
  await store.update(CHAT, duties => {
    duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles and whcih articles exist itself should always be up to date",
      goal: "the wiki stays current", metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }],
      schedule: { kind: "daily", at: "01:30" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each page",
      status: "active", createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 900, lastRunAt: STARTED } satisfies Duty);
  });
  await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "push", ms: 900, verdict: "met", keptAt: KEPT_AT,
    metrics: { wiki_problems: { value: 0, target: 0, op: "<=", met: true } }, summary: "wiki_problems 0 (on target); all 4 on target", job: JOB });
  const clock = { now: Date.parse(NOW) };
  const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, true)]]);
  const retired: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
    rows: async () => [...rows.values()], schedules: async () => new Map(), treeFiles: id => treeFilesOf(id, agentDir), log: line => logs.push(line) });
  const duties = new Duties(store, {
    isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
    jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
      retire: async job => { retired.push(job.id); rows.get(job.id)!.archived = true; },
      start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
  });
  try {
    assert.ok(await duties.runNow(CHAT, "d4"));
    await duties.settled();
    const latest = (await store.runs(CHAT)).find(record => record.at === clock.now)!;
    return { latest, retired, started, logs };
  } finally { duties.close(); await rm(dir, { recursive: true, force: true }); }
}

test("a silent duty job whose tree pi-pool parked on a slot is kept, not replaced as stalled (Wiki dream, 11-09 13:08:58Z)", async () => {
  const { latest, retired, started } = await runAt(
    [reply("2026-11-09T11:05:27.000Z"), slotWait("2026-11-09T11:40:07.635Z", "2026-11-09T13:04:30.000Z"), slotWait("2026-11-09T13:04:32.000Z", "2026-11-09T13:12:30.000Z")],
    [reply("2026-11-09T11:05:20.000Z"), slotWait("2026-11-09T11:40:08.211Z", "2026-11-09T13:04:30.000Z")]);
  assert.deepEqual(retired, []);
  assert.equal(latest.summary.includes(`${STILL_WORKING} (job ${JOB.name} is kept, since ${PARKED}`), true, latest.summary);
  assert.deepEqual(started, []);
});

test("a subagent's slot wait alone keeps the job, since the stall reads the whole tree", async () => {
  const { latest, retired } = await runAt([reply("2026-11-09T11:05:27.000Z")],
    [reply("2026-11-09T11:05:20.000Z"), slotWait("2026-11-09T11:40:08.211Z", "2026-11-09T13:04:30.000Z")]);
  assert.deepEqual(retired, []);
  assert.equal(latest.summary.includes(PARKED), true, latest.summary);
});

test("a silent duty job whose last slot passed over 90 min ago with no new call is still replaced as stalled", async () => {
  const { latest, retired, started, logs } = await runAt([reply("2026-11-09T11:05:27.000Z"), slotWait("2026-11-09T11:10:00.000Z", "2026-11-09T11:30:00.000Z")],
    [reply("2026-11-09T11:05:20.000Z")]);
  assert.equal(latest.summary.includes(STILL_WORKING), false, latest.summary);
  assert.deepEqual(retired, [JOB.id]);
  assert.equal(started.length, 1);
  assert.ok(logs.some(line => line.includes(`(replaced stalled job ${JOB.name} with no model reply in ${STALLED_MS / 60_000} min)`)), logs.join("\n"));
});

test("a slot wait from before the job's run started keeps nothing", async () => {
  const { retired } = await runAt([slotWait("2026-11-09T10:40:00.000Z", "2026-11-09T13:30:00.000Z")], [reply("2026-11-09T11:05:20.000Z")]);
  assert.deepEqual(retired, [JOB.id]);
});
