import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyChat, type DutyJobHost, dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import { applyBoardOp, emptyBoard, nextIds } from "../src/shared/chat-board.ts";
import { type DutyJobRef, type DutyMetric, type DutyRunRecord, parseDutyInput } from "../src/shared/chat-duties.ts";
import { fixJobLive } from "../src/shared/duty-fixes.ts";
import type { BoardOp, ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

// Crawler VP's "geonode proxy use" duty (d2, 01a115e2) right after release-0b181ba went live at 15:05Z on 10-15. The server opened "fix geonode
// proxy use Crawler VP" at 15:05:47Z (00:05), 15:06:59Z (00:06) and 15:08:35Z (00:07), each while the one before already waited in the turn
// queue (pi-pool.log turn_queued at 15:05:47Z and 15:07:00Z). 7aac8b5 stops the second opens; this file covers the worker each fix job loaded
// at once and then kept while it waited in the queue: at 15:2xZ, 80 of 118 live sessions waited there.

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const at = (h: number, m: number, s = 0): number => Date.UTC(2026, 9, 15, h, m, s);
const metrics = [
  { key: "retry_extra_s", label: "Seconds a retry adds", op: "<=" as const, target: 5, unit: " s", headline: true },
  { key: "supply_hold_minutes", label: "Minutes the supply was held", op: "<=" as const, target: 0, unit: " min" },
  { key: "working_exits_dropped", label: "Working exits dropped", op: "<=" as const, target: 0 },
];
const missed = (h: number): DutyRunRecord => ({ duty: "d2", at: at(h, 0), slot: at(h, 0), trigger: "schedule", ms: 900, verdict: "missed", summary: "missed",
  metrics: { retry_extra_s: { value: 41, target: 5, op: "<=", met: false }, supply_hold_minutes: { value: 38, target: 0, op: "<=", met: false },
    working_exits_dropped: { value: 7, target: 0, op: "<=", met: false } }, job: { id: `d2-${h}`, name: `geonode proxy use Crawler VP ${h}:00` } });

async function setup(input: { admit?: (chat: string, duty: string) => Promise<(() => Promise<void>) | null>; queueLong?: () => Promise<string | null>; stopped?: () => Promise<string | null> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "duty-fix-behind-queue-"));
  const store = new DutyStore(dir);
  for (const record of [missed(9), missed(11), missed(13)]) await store.appendRun(CHAT, record);
  await store.update(CHAT, duties => {
    duties.push({ ...parseDutyInput({ name: "geonode proxy use", ownerWords: "geonode use is cheap and steady", goal: "Each read uses the proxy well.",
      onMiss: "Fix the cause.", boardGoal: "p1", metrics, schedule: { kind: "every", minutes: 120 }, precheck: { command: ["node", "-e", "0"], cwd: tmpdir() } }, "d2", at(0, 0)),
    lastRunAt: at(15, 0) });
  });
  const state = { board: { ...emptyBoard("2026-10-15T13:00:00.000Z"), plan: [{ id: "p1", text: "The proxy is used well", status: "doing", children: [] } as unknown as PlanItem] } as ChatBoard };
  const now = { at: at(15, 5, 21) };
  const starts: { job: DutyJobRef; admitted: boolean; at: number }[] = [];
  const steers: string[] = [];
  const ended = new Set<string>();
  const jobs: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "Crawler VP", cwd: "/repo", board: `/data/boards/${chatId}.json` }; },
    async working(job) { return job.id.startsWith("fix") && !ended.has(job.id) && listed(job.id); },
    async start(_chat, name, _brief, admitted = false): Promise<DutyJobRef> { const job = { id: `fix${starts.length + 1}`, name }; starts.push({ job, admitted, at: now.at }); return job; },
    async retire() {},
    async ended(last, older = []) { return [...last, ...older].filter(job => ended.has(job.id) && listed(job.id)); },
    async stop() {},
    async steer(job) { steers.push(job.id); ended.delete(job.id); },
  };
  /** A started job is listed and reads working, the way a queued turn does in Prime, until its turn ends. */
  const listed = (id: string): boolean => starts.some(entry => entry.job.id === id);
  const rows = (): SessionRow[] => {
    const plan = state.board.plan.flatMap(item => [item, ...item.children]);
    const shown = starts.filter(entry => listed(entry.job.id)).map(entry => entry.job);
    const agents = shown.map((job): ChatAgent => ({ key: `thread:${job.id}`, sessionId: job.id, name: job.name, job: `session:${job.id}`, sender: job.name, link: "step",
      state: ended.has(job.id) ? "idle" : "working", steps: plan.filter(item => item.sessionId === job.id).map(item => item.id) }));
    return [{ id: CHAT, name: "Crawler VP", agents } as unknown as SessionRow,
      ...shown.map(job => ({ id: job.id, name: job.name, archived: false, working: !ended.has(job.id) }) as unknown as SessionRow)];
  };
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async id => id === CHAT, jobs, now: () => now.at, tickMs: 0, log: line => lines.push(line),
    ...(input.admit ? { admit: input.admit } : {}), ...(input.queueLong ? { queueLong: input.queueLong } : {}), ...(input.stopped ? { stopped: input.stopped } : {}),
    board: async () => state.board,
    applyBoard: async (_chat, ops: (board: ChatBoard) => readonly BoardOp[]) => {
      let board = state.board;
      for (const op of ops(board)) board = applyBoardOp(board, op, "agent", new Date(now.at).toISOString(), nextIds(board)).board;
      state.board = { ...board, rev: state.board.rev + 1 };
    },
    fixLive: async (id, item) => fixJobLive(item, id, rows(), new Set()) });
  const settle = async () => { await duties.tick(); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { duties, starts, steers, ended, lines, now, settle };
}

test("a fix job's create waits in the turn queue under the duty's fix key, and its first turn takes that place", async () => {
  const asks: string[] = [];
  const order: string[] = [];
  let admit!: () => void;
  const { duties, starts, now } = await setup({ admit: async (_chat, duty) => {
    asks.push(duty);
    await new Promise<void>(resolve => { admit = resolve; });
    return async () => { order.push("release"); };
  } });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  // A tick waits for the fix task it started, which waits for the key, so the ticks run unawaited until the admit.
  const first = duties.tick();
  await flush();
  now.at = at(15, 7, 44);
  const second = duties.tick();
  await flush();
  assert.deepEqual(asks, ["d2-fix"], "one ask, and no second one while it waits");
  assert.equal(starts.length, 0, "no session, so no worker, while the key waits");
  admit();
  await Promise.all([first, second]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.admitted, true, "the job's first turn runs on the key's admission");
  order.unshift("start");
  assert.deepEqual(order, ["start", "release"], "the key holds its slot until the session exists");
});

test("an idle fix job is not sent back while the turn queue is long, and goes back the first tick it is short", async () => {
  let long: string | null = "the turn queue holds 90 turns for 12 slots";
  const { starts, steers, ended, now, settle, lines } = await setup({ queueLong: async () => long });
  await settle();
  now.at = at(15, 9, 0);
  ended.add("fix1");
  await settle();
  now.at = at(15, 9, 30);
  await settle();
  assert.deepEqual(steers, []);
  assert.equal(starts.length, 1, "a held send-back opens no second job either");
  assert.equal(lines.filter(line => line.includes("goes back on a later tick")).length, 1, lines.join("\n"));
  long = null;
  now.at = at(15, 10, 0);
  await settle();
  assert.deepEqual(steers, ["fix1"]);
});

// 10-16 about 04:00 KST: the owner had every job stopped, and the server opened slack green guy d1's fix again at 03:55 and 03:58 KST on p150
// and p151, each one minutes after the one before was stopped. While the fleet stop switch is on no fix job opens, replaces a stopped one, or
// goes back, and no step gets a new job name.
test("while the fleet stop switch is on no fix job opens or goes back, and a stopped one is not replaced", async () => {
  let stop: string | null = null;
  const { starts, steers, ended, now, settle, lines } = await setup({ stopped: async () => stop });
  await settle();
  assert.equal(starts.length, 1, "the switch off: the miss streak opens one fix job");
  stop = "the fleet stop switch is on";
  ended.add("fix1");
  for (const minute of [9, 10, 12, 20, 40]) { now.at = at(15, minute, 0); await settle(); }
  assert.equal(starts.length, 1, "no replacement for the stopped job");
  assert.deepEqual(steers, [], "and no send-back");
  assert.equal(lines.filter(line => line.startsWith("duties: no fix job opens")).length, 1, lines.join("\n"));
  stop = null;
  now.at = at(15, 41, 0);
  await settle();
  assert.deepEqual(steers, ["fix1"], "the switch off: the stopped job goes back on its steps");
});

// The AI harness chat's d6 fixture of duty-persistence.test.ts: its job ends with 2 unowned misses, which sends it back while the queue is short.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/duty-fixes-ai-harness-1015.json"), "utf8")) as {
  chat: string; duty: { id: string; name: string; ownerWords: string; goal: string; metrics: DutyMetric[]; onMiss: string }; runs: DutyRunRecord[]; board: ChatBoard };

test("a duty job that ends with an unowned miss while the turn queue is long is stopped, not sent back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-queue-long-"));
  const store = new DutyStore(dir);
  const newest = fixture.runs[0]!;
  for (const run of fixture.runs.slice(1).reverse()) await store.appendRun(fixture.chat, run);
  const values = Object.fromEntries(Object.entries(newest.metrics).map(([key, result]) => [key, result.value]));
  const output = `require("fs").writeFileSync(process.env.OUTPUT_FILE, ${JSON.stringify(JSON.stringify({ metrics: values, flagged: [] }))})`;
  await store.update(fixture.chat, duties => {
    duties.push({ ...parseDutyInput({ ...fixture.duty, metrics: fixture.duty.metrics.slice(0, 4), schedule: { kind: "every", minutes: 60 },
      precheck: { command: ["node", "-e", output], cwd: tmpdir() } }, "d6", newest.at), metrics: fixture.duty.metrics, lastRunAt: newest.at });
  });
  const steers: string[] = [];
  const stops: string[] = [];
  const ended = new Set<string>();
  const jobs: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "AI harness developer environment", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working(job) { return job.id === "s1" && !ended.has(job.id); },
    async start(_chat, name): Promise<DutyJobRef> { return { id: "s1", name }; },
    async retire() {},
    async ended(last, older = []) { return [...last, ...older].filter(job => ended.has(job.id)); },
    async stop(job) { stops.push(job.id); },
    async steer(job) { steers.push(job.id); ended.delete(job.id); },
  };
  const now = { at: newest.at };
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async id => id === fixture.chat, jobs, now: () => now.at, tickMs: 0, log: line => lines.push(line),
    board: async () => ({ ...fixture.board }), fixLive: async () => false, queueLong: async () => "the turn queue holds 90 turns for 12 slots" });
  await duties.runNow(fixture.chat, "d6");
  await duties.settled();
  ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  assert.deepEqual(steers, [], "a message now would start a turn that waits with the job's worker loaded");
  assert.deepEqual(stops, ["s1"], lines.join("\n"));
  assert.ok(lines.some(line => line.includes("not sent back, because the turn queue holds 90 turns for 12 slots")), lines.join("\n"));
});

test("a job whose run the queue admitted marks its first turn before its brief goes, and a job with no admission does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-handoff-"));
  const calls: string[] = [];
  let next = 0;
  const jobs = dutyJobHost({ rows: async () => [], registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/data/boards/${id}.json`,
    archives: { async add() {} }, started: async id => { calls.push(`low ${id}`); }, handoff: async id => { calls.push(`handoff ${id}`); },
    threads: { async create() { return { id: `job-${++next}` }; }, async prompt(id) { calls.push(`brief ${id}`); } } });
  const chat = { id: CHAT, name: "Crawler VP", cwd: "/repo", board: "/data/boards/x.json" };
  await jobs.start(chat, "fix geonode proxy use Crawler VP 00:05", "brief", true);
  await jobs.start(chat, "geonode proxy use Crawler VP 00:10", "brief");
  assert.deepEqual(calls, ["low job-1", "handoff job-1", "brief job-1", "low job-2", "brief job-2"]);
});
