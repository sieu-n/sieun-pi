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
import type { BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

// VP of CI's CI system duty (d1, daily at 07:39) on 10-15: its 07:39 job ended at 07:44 KST with every metric missed and no fix step, the
// send-back shipped at 18:22 KST, and at 20:25 KST the duty had missed 45 runs with no linked step on the board. 11 of the 12 stuck duties
// were like it. The server now opens the fix job and its step itself, with no turn queue wait before the create.

const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const day = (date: number, hours: number, minutes = 0): number => new Date(2026, 9, date, hours, minutes).getTime();
const metrics = [
  { key: "verify_dev_p90_min", label: "Dev verify p90", op: "<=" as const, target: 10, unit: " min", headline: true },
  { key: "land_success_pct", label: "Lands that pass", op: ">=" as const, target: 80, unit: "%" },
];
const run = (date: number, values: [number, number], job: string): DutyRunRecord => {
  const [verify, land] = values;
  return { duty: "d1", at: day(date, 7, 39), slot: day(date, 7, 39), trigger: "schedule", ms: 900, verdict: "missed", summary: "missed",
    metrics: { verify_dev_p90_min: { value: verify, target: 10, op: "<=", met: verify <= 10 }, land_success_pct: { value: land, target: 80, op: ">=", met: land >= 80 } },
    job: { id: job, name: `ci system VP of CI ${date}` } };
};

async function setup(input: { runs: DutyRunRecord[]; working?: Set<string>; steerError?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "duty-own-fixes-"));
  const store = new DutyStore(dir);
  for (const record of input.runs) await store.appendRun(CHAT, record);
  await store.update(CHAT, duties => {
    duties.push({ ...parseDutyInput({ name: "CI system", ownerWords: "CI is fast", goal: "CI verifies a dev push in 10 min.", onMiss: "Fix the slow part.", boardGoal: "p86",
      metrics, schedule: { kind: "daily", at: "07:39" }, precheck: { command: ["node", "-e", "0"], cwd: tmpdir() } }, "d1", day(13, 7)), lastSlotAt: day(15, 7, 39) });
  });
  const state = { board: { ...emptyBoard("2026-10-15T11:00:00.000Z"), plan: [{ id: "p86", text: "CI verifies a dev push in 10 min", status: "doing", children: [] } as unknown as PlanItem] } as ChatBoard };
  state.board.rev = 7;
  const working = input.working ?? new Set<string>();
  const ended = new Set<string>();
  const starts: { name: string; brief: string }[] = [];
  const stepsAtStart: string[][] = [];
  const admits: string[] = [];
  const steers: { job: string; text: string }[] = [];
  let next = 0;
  const jobs: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "VP of CI", cwd: "/repo", board: `/data/boards/${chatId}.json` }; },
    async working(job) { return working.has(job.id); },
    async start(_chat, name, brief): Promise<DutyJobRef> {
      starts.push({ name, brief });
      stepsAtStart.push(steps(state.board).filter(item => item.job === name).map(item => `${item.duty} ${item.sessionId ?? "no session"}`)); const id = `fix${++next}`; working.add(id); return { id, name }; },
    async retire() {},
    async ended(last, older = []) { return [...last, ...older].filter(job => ended.has(job.id)); },
    async stop() {},
    async steer(job, text) { if (input.steerError) throw new Error(input.steerError); steers.push({ job: job.id, text }); ended.delete(job.id); working.add(job.id); },
  };
  const lines: string[] = [];
  const now = { at: day(15, 20, 25) };
  const duties = new Duties(store, { isChat: async id => id === CHAT, jobs, now: () => now.at, tickMs: 0, log: line => lines.push(line),
    admit: async (_chat, duty) => { admits.push(duty); return null; },
    board: async () => state.board,
    applyBoard: async (_chat, ops: (board: ChatBoard) => readonly BoardOp[]) => {
      let board = state.board;
      for (const op of ops(board)) board = applyBoardOp(board, op, "agent", new Date(now.at).toISOString(), nextIds(board)).board;
      state.board = { ...board, rev: state.board.rev + 1 };
    },
    fixLive: async (_chat, item) => item.sessionId !== undefined && working.has(item.sessionId) });
  /** The job's turn ends: it is idle and listed, not working. */
  const end = (id: string) => { working.delete(id); ended.add(id); };
  return { duties, state, starts, steers, lines, end, working, now, stepsAtStart, admits };
}

const steps = (board: ChatBoard): PlanItem[] => board.plan.flatMap(item => [item, ...item.children]).filter(item => item.duty);

test("a daily duty stuck 3 runs with its last job ended and no fix step gets a fix job and a linked step from the server on the next tick", async () => {
  const { duties, state, starts, lines, stepsAtStart, admits } = await setup({ runs: [run(13, [130, 57], "j13"), run(14, [294, 50], "j14"), run(15, [110, 28], "j15")] });
  await duties.tick();
  assert.equal(starts.length, 1, lines.join("\n"));
  assert.deepEqual(admits, ["d1-fix"], "the create waits in the turn queue under the fix key, so the job holds no worker while its turn could only wait");
  assert.deepEqual(stepsAtStart[0], ["d1/verify_dev_p90_min no session", "d1/land_success_pct no session"], "the steps name the job before its create");
  assert.match(starts[0]!.name, /^fix ci system VP of CI \d\d:\d\d$/);
  assert.match(starts[0]!.brief, /- verify_dev_p90_min \(Dev verify p90\) is 110 min, target at most 10 min, missed 3 runs in a row, moving toward the target\./);
  assert.match(starts[0]!.brief, /- land_success_pct \(Lands that pass\) is 28%, target at least 80%, missed 3 runs in a row, not moving toward the target\./);
  assert.match(starts[0]!.brief, /board\.wake\(run=<id>\)/);
  const linked = steps(state.board);
  assert.deepEqual(linked.map(item => [item.duty, item.status, item.job, item.sessionId]), [
    ["d1/verify_dev_p90_min", "doing", starts[0]!.name, "fix1"], ["d1/land_success_pct", "doing", starts[0]!.name, "fix1"]]);
  assert.ok(state.board.plan[0]!.children.length === 2, "the steps go under the duty's board goal p86");
  assert.ok(lines.some(line => line.endsWith(`d1: verify_dev_p90_min, land_success_pct had no fix step with a live job after 3 or more missed runs; opened ${starts[0]!.name}`)), lines.join("\n"));
  await duties.tick();
  assert.equal(starts.length, 1, "a live fix job owns the metrics, so no second job opens");
});

test("a fix job that ends with no wake is sent back once per board change, and a new fix job takes its steps when it ends again with no change", async () => {
  const { duties, state, starts, steers, end } = await setup({ runs: [run(13, [130, 57], "j13"), run(14, [294, 50], "j14"), run(15, [110, 28], "j15")] });
  await duties.tick();
  end("fix1");
  await duties.tick();
  assert.equal(steers.length, 1);
  assert.equal(steers[0]!.job, "fix1");
  assert.match(steers[0]!.text, /^\[duty\] CI system still misses verify_dev_p90_min \(110, target at most 10\), land_success_pct \(28, target at least 80\), and your steps p\d+, p\d+ have no live job\./);
  assert.equal(starts.length, 1);
  end("fix1");
  await duties.tick();
  assert.equal(starts.length, 2, "the job ended again with the board where it was");
  assert.equal(steers.length, 1);
  const linked = steps(state.board);
  assert.equal(linked.length, 2, "the open steps are reused, not doubled");
  assert.deepEqual(linked.map(item => item.sessionId), ["fix2", "fix2"]);
});

test("a duty under 3 misses, a duty whose last job still works, and a met duty get no fix job from the server", async () => {
  const short = await setup({ runs: [run(14, [294, 50], "j14"), run(15, [110, 28], "j15")] });
  await short.duties.tick();
  assert.equal(short.starts.length, 0);
  const busy = await setup({ runs: [run(13, [130, 57], "j13"), run(14, [294, 50], "j14"), run(15, [110, 28], "j15")], working: new Set(["j15"]) });
  await busy.duties.tick();
  assert.equal(busy.starts.length, 0, "the duty job at work owns its run, and its turn end sends it back");
  const met = await setup({ runs: [run(13, [130, 57], "j13"), run(14, [294, 50], "j14"), run(15, [9, 90], "j15")] });
  await met.duties.tick();
  assert.equal(met.starts.length, 0);
});

test("a fix job Prime cannot resume gets a new fix job on its steps in the same tick (frontend bro p148, 10-15 16:13Z)", async () => {
  const { duties, state, starts, steers, end, lines } = await setup({ runs: [run(13, [130, 57], "j13"), run(14, [294, 50], "j14"), run(15, [110, 28], "j15")],
    steerError: "Prime Agent did not resume this thread." });
  await duties.tick();
  end("fix1");
  await duties.tick();
  assert.equal(steers.length, 0);
  assert.equal(starts.length, 2, lines.join("\n"));
  assert.deepEqual(steps(state.board).map(item => item.sessionId), ["fix2", "fix2"], "the new job takes the open steps");
  assert.ok(lines.some(line => line.includes("could not be sent back (Prime Agent did not resume this thread.)")), lines.join("\n"));
});
