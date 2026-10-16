import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyChat, type DutyJobHost, dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import { applyBoardOp, emptyBoard, nextIds } from "../src/shared/chat-board.ts";
import { type DutyJobRef, type DutyRunRecord, parseDutyInput } from "../src/shared/chat-duties.ts";
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

async function setup(input: { admit?: (chat: string, duty: string) => Promise<(() => Promise<void>) | null> } = {}) {
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
    ...(input.admit ? { admit: input.admit } : {}),
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
