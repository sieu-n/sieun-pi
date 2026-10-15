import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { applyBoardOp, emptyBoard, nextIds } from "../src/shared/chat-board.ts";
import { type DutyJobRef, type DutyRunRecord, parseDutyInput } from "../src/shared/chat-duties.ts";
import { fixJobLive } from "../src/shared/duty-fixes.ts";
import type { BoardOp, ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

// api portal vp's "Portal matches crawler" duty (d2) after the owner's restart on 10-15. The server opened "fix portal matches crawler api
// portal vp" 7 times, at 14:01:17Z, 14:07:33Z, 14:16:03Z, 14:23:24Z, 14:38:43Z, 14:39:48Z and 14:39:59Z, each while the one before it waited
// in the turn queue: the 22:58 job asked for a slot at 14:01:17Z and made its first model call at 14:22:09Z, the 23:28 one waited from 14:38:43Z
// to 14:48:22Z (session files). A queued job is idle in the catalog (no working row, no working agent), only its `queued` place says it waits,
// and fixJobLive read only `working`, so every tick saw the steps unowned and opened another low-class root that queued behind the rest.

const CHAT = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const at = (h: number, m: number, s = 0): number => Date.UTC(2026, 9, 15, h, m, s);
const metrics = [
  { key: "prod_working_pct", label: "Crawler routes that work through api.virev.ai (prod)", op: ">=" as const, target: 100, unit: "%", headline: true },
  { key: "staging_working_pct", label: "Crawler routes that work through staging-api.virev.ai", op: ">=" as const, target: 100, unit: "%" },
  { key: "routes_failing_portal", label: "Routes failing on prod or staging because of the portal", op: "<=" as const, target: 0 },
  { key: "routes_failing_crawler", label: "Routes failing on prod or staging because the crawler errors", op: "<=" as const, target: 0 },
];
// The d2 run records of 01a1301d's runs.jsonl that made the streak: two on the old metric keys, then 11:00:21Z on the new ones.
const runs: DutyRunRecord[] = [
  { duty: "d2", at: at(0, 0, 6) - 86_400_000, slot: at(0, 0) - 86_400_000, trigger: "schedule", ms: 900, verdict: "missed", summary: "missed",
    metrics: { routes_working_pct: { value: 39.8, target: 100, op: ">=", met: false } }, job: { id: "01a137bc-7357-779d-9250-f47d3a7af144", name: "portal matches crawler api portal vp 10-14 09:00" } },
  { duty: "d2", at: at(0, 0, 23), slot: at(0, 0), trigger: "schedule", ms: 900, verdict: "missed", summary: "missed",
    metrics: { routes_working_pct: { value: 35.4, target: 100, op: ">=", met: false } }, job: { id: "01a13ce2-c74f-7748-8121-0ee8863399ce", name: "portal matches crawler api portal vp 10-15 09:00" } },
  { duty: "d2", at: at(11, 0, 21), slot: at(11, 0), trigger: "owner", ms: 900, verdict: "missed", summary: "missed",
    metrics: { prod_working_pct: { value: 80.9, target: 100, op: ">=", met: false }, staging_working_pct: { value: 81.4, target: 100, op: ">=", met: false },
      routes_failing_portal: { value: 15, target: 0, op: "<=", met: false }, routes_failing_crawler: { value: 18, target: 0, op: "<=", met: false } },
    job: { id: "01a13fbe-33a0-749e-8c3b-830ee2e4ab47", name: "portal matches crawler api portal vp 20:00" } },
];
const ticks = [at(14, 1, 17), at(14, 7, 33), at(14, 16, 3), at(14, 23, 24), at(14, 38, 43), at(14, 39, 48), at(14, 39, 59)];

async function replay() {
  const dir = await mkdtemp(join(tmpdir(), "duty-fix-queued-"));
  const store = new DutyStore(dir);
  for (const record of runs) await store.appendRun(CHAT, record);
  await store.update(CHAT, duties => {
    duties.push({ ...parseDutyInput({ name: "Portal matches crawler", ownerWords: "is all apis working that work in crawler api work for api portal?",
      goal: "Every customer crawler route works through the api portal on prod and on staging.", onMiss: "Read the flagged rows.", boardGoal: "p1",
      metrics, schedule: { kind: "daily", at: "09:00" }, precheck: { command: ["node", "-e", "0"], cwd: tmpdir() } }, "d2", at(0, 0) - 3 * 86_400_000),
    lastSlotAt: at(15, 0) });
  });
  const state = { board: { ...emptyBoard("2026-10-15T11:00:00.000Z"), plan: [{ id: "p1", text: "Every crawler route works through the portal", status: "doing", children: [] } as unknown as PlanItem] } as ChatBoard };
  state.board.rev = 3;
  const queued = new Map<string, number>();
  const starts: DutyJobRef[] = [];
  const now = { at: ticks[0]! };
  const jobs: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "api portal vp", cwd: "/repo", board: `/data/boards/${chatId}.json` }; },
    async working() { return false; },
    async start(_chat, name): Promise<DutyJobRef> { const job = { id: `fix${starts.length + 1}`, name }; starts.push(job); queued.set(job.id, now.at); return job; },
    async retire() {},
    async ended() { return []; },
    async stop() {},
    async steer() {},
  };
  /** The catalog's rows as chat-catalog.ts projects them: each started job is the chat's step agent, idle, with its turn queue place. */
  const rows = (): SessionRow[] => {
    const plan = state.board.plan.flatMap(item => [item, ...item.children]);
    const agents = starts.map((job): ChatAgent => ({ key: `thread:${job.id}`, sessionId: job.id, name: job.name, job: `session:${job.id}`, sender: job.name, link: "step",
      state: "idle", steps: plan.filter(item => item.sessionId === job.id).map(item => item.id),
      ...(queued.has(job.id) ? { queued: { position: [...queued.keys()].indexOf(job.id) + 1, total: queued.size, since: queued.get(job.id)! } } : {}) }));
    return [{ id: CHAT, name: "api portal vp", agents } as unknown as SessionRow,
      ...starts.map(job => ({ id: job.id, name: job.name, archived: false, working: false }) as unknown as SessionRow)];
  };
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async id => id === CHAT, jobs, now: () => now.at, tickMs: 0, log: line => lines.push(line),
    admit: async () => null,
    board: async () => state.board,
    applyBoard: async (_chat, ops: (board: ChatBoard) => readonly BoardOp[]) => {
      let board = state.board;
      for (const op of ops(board)) board = applyBoardOp(board, op, "agent", new Date(now.at).toISOString(), nextIds(board)).board;
      state.board = { ...board, rev: state.board.rev + 1 };
    },
    fixLive: async (id, item) => fixJobLive(item, id, rows(), new Set()) });
  for (const tick of ticks) { now.at = tick; await duties.tick(); }
  return { starts, lines };
}

test("a fix job that waits in the turn queue owns its metrics, so the 10-15 d2 replay opens 1 fix job, not 7", async () => {
  const { starts, lines } = await replay();
  assert.equal(starts.length, 1, lines.join("\n"));
  assert.match(starts[0]!.name, /^fix portal matches crawler api portal vp \d\d:\d\d$/);
});

test("a fix job with a turn queue place is live, and one with no place and no working row is not", () => {
  const item = { id: "p29", job: "fix portal matches crawler api portal vp 22:58", sessionId: "fix1" };
  const agent = { key: "thread:fix1", sessionId: "fix1", name: item.job, job: "session:fix1", sender: item.job, link: "step", state: "idle", steps: ["p29"] } as ChatAgent;
  const rows = (extra: Partial<ChatAgent>) => [{ id: CHAT, agents: [{ ...agent, ...extra }] } as unknown as SessionRow, { id: "fix1", archived: false, working: false } as unknown as SessionRow];
  assert.equal(fixJobLive(item, CHAT, rows({}), new Set()), false, "an ended job with nothing pending gets sent back or replaced");
  assert.equal(fixJobLive(item, CHAT, rows({ queued: { position: 46, total: 46, since: at(14, 1, 17) } }), new Set()), true, "46th of 46 at 14:01:17Z");
});
