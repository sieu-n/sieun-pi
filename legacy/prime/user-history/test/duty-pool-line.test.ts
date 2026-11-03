// Replays the AI harness chat's Wiki dream (d4) push run of 11-01 03:30:15Z. Its last job, "wiki dream AI harness developer environment 10:36"
// (01a194c5), was cut by a 429 at 01:43:43Z and stayed in pi-pool's line: its 03:30:07Z wait held a 03:36:00Z cell on claude-virev18. The run
// retired it and started "12:30", which asked at 03:35:19Z behind 15 trees on that account and got its first account at 04:16:33Z
// (~/work/d4-slot-wait-1101). A job pi-pool holds in line, or a cut one it admits, is now kept and handed the run's new items.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type PoolHold, poolHoldsTree, readPoolStatus } from "../src/chat-pool.ts";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties, IN_POOL_LINE } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { treeFilesOf } from "../src/send-once.ts";
import { type Duty, type DutyCut, type DutyJobRef, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const JOB: DutyJobRef = { id: "01a194c5-33e8-7257-a16d-3ff1d52f4bdd", name: "wiki dream AI harness developer environment 10:36" };
const STARTED = Date.parse("2026-11-01T01:36:11.553Z");
const CUT: DutyCut = { at: Date.parse("2026-11-01T01:43:43.350Z"), provider: "anthropic", slotAt: Date.parse("2026-11-01T01:52:00.000Z"),
  error: "token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot at 2026-11-01T01:52:00.000Z." };
const OLD_PAGE = "apps/convex/contact-points.html";
const NEW_PAGE = "apps/search/brand-tracking.html";

const row = (id: string, name: string, working: boolean): SessionRow => ({ id, name, cwd: "/home/sieun", kind: "root", status: working ? "working" : "idle",
  archived: false, messageCount: 40, working, subagentsRunning: 0, unread: false, tags: [], priority: 0 } as unknown as SessionRow);
const failed = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [], stopReason: "error",
  errorMessage: "pi-pool: this session waits for its slot at 2026-11-01T03:36:00.000Z." } });

const reply = (at: string) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Fixed the page." }], stopReason: "stop" } });

async function runAt(now: string, hold: PoolHold | null, cut: DutyCut | null = CUT, last = failed("2026-11-01T03:30:07.000Z")) {
  const dir = await mkdtemp(join(tmpdir(), "duty-pool-line-"));
  try {
    const agentDir = join(dir, "agent");
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await writeFile(join(agentDir, "sessions", `${JOB.id}.jsonl`), last + "\n");
    const precheck = join(dir, "precheck.mjs");
    const flagged = [OLD_PAGE, NEW_PAGE].map(item => ({ kind: "stale_vs_code", item, excerpt: `${item} is behind its code`, handOff: true }));
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(${JSON.stringify({ metrics: { wiki_problems: 5 }, flagged })}));`);
    const store = new DutyStore(dir);
    await store.update(CHAT, duties => {
      duties.push({ id: "d4", name: "Wiki dream", ownerWords: "the wiki stays in sync", goal: "the wiki stays in sync",
        metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
        precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix each problem", status: "active",
        createdAt: STARTED - 86_400_000, updatedAt: STARTED - 86_400_000, runCount: 400, lastRunAt: STARTED } satisfies Duty);
    });
    await store.appendRun(CHAT, { duty: "d4", at: STARTED, slot: STARTED, trigger: "push", ms: 350_000, verdict: "met",
      metrics: { wiki_problems: { value: 0, target: 0, op: "<=", met: true } }, summary: "wiki_problems 0 (on target)", job: JOB, ...cut ? { cut } : {} });
    await mkdir(store.chatDir(CHAT), { recursive: true });
    await writeFile(join(store.chatDir(CHAT), "d4.handed.json"), JSON.stringify({ job: JOB.id, keys: [`stale_vs_code|${OLD_PAGE}`] }));
    const rows = new Map<string, SessionRow>([[CHAT, row(CHAT, "AI harness developer environment VP", false)], [JOB.id, row(JOB.id, JOB.name, false)]]);
    const retired: string[] = [];
    const started: string[] = [];
    const steered: string[] = [];
    const logs: string[] = [];
    const host = dutyJobHost({ threads: {} as never, archives: { add: async () => {} }, registry: {} as never, board: id => id,
      rows: async () => [...rows.values()], schedules: async () => new Map(), treeFiles: id => treeFilesOf(id, agentDir), log: line => logs.push(line) });
    const clock = { now: Date.parse(now) };
    const duties = new Duties(store, {
      isChat: async () => true, now: () => clock.now, tickMs: 0, node: process.execPath, log: line => logs.push(line),
      poolHolds: async tree => tree === JOB.id ? hold : null,
      jobs: { ...host, chat: async id => ({ id, name: rows.get(id)!.name, cwd: dir, board: id }),
        retire: async job => { retired.push(job.id); rows.get(job.id)!.archived = true; },
        steer: async (job, text) => { steered.push(`${job.id}: ${text}`); },
        start: async (_chat, name) => { const id = `new-${started.length + 1}`; started.push(name); rows.set(id, row(id, name, true)); return { id, name }; } },
    });
    try {
      assert.ok(await duties.runNow(CHAT, "d4"));
      await duties.settled();
      const latest = (await store.runs(CHAT)).find(record => record.at === clock.now)!;
      return { latest, retired, started, steered, logs };
    } finally { duties.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a cut duty job that pi-pool holds in its line is kept and handed the run's new items (Wiki dream, 11-01 03:30Z)", async () => {
  const { latest, retired, started, steered } = await runAt("2026-11-01T03:30:15.364Z", "line");
  assert.ok(latest.summary.includes(`${STILL_WORKING} (job ${JOB.name} ${IN_POOL_LINE})`), latest.summary);
  assert.deepEqual(retired, []);
  assert.deepEqual(started, []);
  assert.equal(steered.length, 1);
  assert.ok(steered[0]!.includes(NEW_PAGE) && !steered[0]!.includes(OLD_PAGE), steered[0]);
});

test("a cut duty job whose tree pi-pool admits is kept for the resume pass, not replaced (Wiki dream rerun, 10-29 12:04Z)", async () => {
  const { latest, retired, started } = await runAt("2026-11-01T03:30:15.364Z", "admits");
  assert.ok(latest.summary.includes(IN_POOL_LINE), latest.summary);
  assert.deepEqual(retired, []);
  assert.deepEqual(started, []);
});

test("a cut duty job that pi-pool no longer holds is retired and a new job starts", async () => {
  const { retired, started } = await runAt("2026-11-01T03:30:15.364Z", null);
  assert.deepEqual(retired, [JOB.id]);
  assert.equal(started.length, 1);
});

test("an idle job that was not cut is retired though pi-pool would admit its tree", async () => {
  const { retired, started } = await runAt("2026-11-01T03:30:15.364Z", "admits", null, reply("2026-11-01T01:50:00.000Z"));
  assert.deepEqual(retired, [JOB.id]);
  assert.equal(started.length, 1);
});

// sep launch!! (product guy)'s check-in job of 11-03 09:16Z ended its turn at 11:38Z and was archived, with no cut on its run. Its tree kept a
// reserved openai-codex wait for a 11-04 06:46Z cell while its anthropic account served it, and every check-in to 20:30Z skipped beside it.
test("an ended duty job that was not cut is retired though pi-pool still reserves a wait for its tree (sep launch!! check-in, 11-03)", async () => {
  const { latest, retired, started } = await runAt("2026-11-01T03:30:15.364Z", "line", null, reply("2026-11-01T01:50:00.000Z"));
  assert.ok(!latest.summary.includes(IN_POOL_LINE), latest.summary);
  assert.deepEqual(retired, [JOB.id]);
  assert.equal(started.length, 1);
});

test("a job in pi-pool's line is replaced once its run is 12 h old (STUCK_MAX_MS)", async () => {
  const { retired, started } = await runAt("2026-11-01T13:40:00.000Z", "line");
  assert.deepEqual(retired, [JOB.id]);
  assert.equal(started.length, 1);
});

// `pi-pool who --json` for the 10:36 tree at 03:30:15Z: a wait that holds its own cell, a dry-run wait for a tree that asks no more, and no wait.
const part = (value: unknown) => ({ code: 0, out: JSON.stringify(value), err: "" });
const ls = part({ provider: "anthropic", rows: [{ id: "acct-18", usable: true }] });
const reader = (anthropic: Record<string, unknown>): typeof readPoolStatus => async (threads = []) => ({ at: 0, queue: part({}), config: part({}),
  threads: new Map(threads.map(thread => [`${thread.session ?? ""}|${thread.model ?? ""}`, { at: 0, who: part({ providers: { anthropic } }), ls: { anthropic: ls, "openai-codex": ls } }])) });
const selection = { mode: "auto" };

test("poolHoldsTree reads a reserved wait as the line, a free account as admits, and a dry-run wait as neither", async () => {
  const slot = Date.parse("2026-11-01T03:36:00Z") / 1000;
  const now = () => Date.parse("2026-11-01T03:30:15Z");
  assert.equal(await poolHoldsTree(JOB.id, reader({ selection, account: null, wait: { account: "acct-18", slot_at: slot, reserved: true } }), now), "line");
  assert.equal(await poolHoldsTree(JOB.id, reader({ selection, account: null, wait: { account: "acct-18", slot_at: slot, reserved: false } }), now), null);
  assert.equal(await poolHoldsTree(JOB.id, reader({ selection, account: "acct-18", wait: null }), now), "admits");
  assert.equal(await poolHoldsTree(JOB.id, async () => { throw new Error("pi-pool gave no reading"); }, now), null);
});
