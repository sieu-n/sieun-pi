// Replays why d9's stuck_duties came back after p774 (10-20). It read 0 at 02:30Z and 1 to 4 in each of the next 6 runs, 18 counts in all:
// 5 were windowed counts with no new event that the duty runner itself tells its job to leave (frontend bro d1 restarts_24h, d6
// repeated_design_notes_24h), 7 were duty jobs cut by pi-pool slot waits whose runs waited for their rerun, 3 were check-in stuck_steps misses
// while stuck_steps_all read 0, and 3 were d9 itself after p774 and p775 closed with their metrics off target and the verify jobs died
// (one aborted by the 03:08Z daemon update restart, one cut by a pool wait), so no open step carried the fix.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { owedKeys, type PlanInputs, planCounts, unreadWindows } from "../scripts/duties/whole-system.ts";
import { pushList, withoutWorkingRuns } from "../scripts/duties/chat-system.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty, DutyRunRecord } from "../src/shared/chat-duties.ts";
import { verifyNoteOps } from "../src/shared/duty-fixes.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";
import type { BoardOp, ChatBoard, CheckInView } from "../src/shared/types.ts";

const FRONTEND = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const at = (clock: string) => Date.parse(`2026-10-20T${clock}:00Z`);
const NOTE_AT = Date.parse("2026-10-19T17:33:03.372Z");
const designRun = (clock: string, value: number): DutyRunRecord => ({ duty: "d6", at: at(clock), trigger: "push", ms: 1, verdict: "missed", summary: "",
  metrics: { repeated_design_notes_24h: { value, target: 0, op: "<=", met: false, lastEventAt: NOTE_AT } } });
const empty = { v: 2, rev: 1, updatedAt: "2026-10-20T06:00:00Z", todos: [], plan: [] } as unknown as ChatBoard;
const inputs = (runs: DutyRunRecord[], duty: { id: string; name: string }, now: number, everyMs?: number) => ({ now, chats: [{ id: FRONTEND, name: "frontend bro", runs,
  duties: [duty], paused: false, ...everyMs ? { everyMs } : {} }], boards: new Map([[FRONTEND, empty]]), ownerActivity: new Map(), waking: new Set<string>(),
  poolWaiting: new Set<string>(), named: new Map() }) as unknown as PlanInputs;

test("a windowed count with no new event since the run before owes no fix job, as the duty job's brief says (frontend bro d6, 06:16Z)", () => {
  const runs = [designRun("06:07", 14), designRun("05:52", 15)];
  assert.equal(metricStreaks(runs)[0]!.quietSince, NOTE_AT);
  assert.deepEqual(owedKeys(["repeated_design_notes_24h"], runs, new Set()), []);
  assert.equal(planCounts(inputs(runs, { id: "d6", name: "Staging design rules" }, at("06:16"))).redDuties.length, 0);
  const fresh = [{ ...designRun("06:07", 15), metrics: { repeated_design_notes_24h: { value: 15, target: 0, op: "<=" as const, met: false, lastEventAt: at("06:00") } } },
    designRun("05:52", 15)];
  assert.equal(planCounts(inputs(fresh, { id: "d6", name: "Staging design rules" }, at("06:16"))).redDuties.length, 1, "a new event since the run before owes a fix");
});

test("a red duty lists only the missed metrics that owe a fix, so a quiet window beside a real miss leaves the real one (CI and RepoOps d4)", () => {
  const run = (clock: string): DutyRunRecord => ({ duty: "d4", at: at(clock), trigger: "verify", ms: 1, verdict: "missed", summary: "", metrics: {
    alerts_firing: { value: 1, target: 0, op: "<=", met: false },
    false_alerts_7d: { value: 10, target: 0, op: "<=", met: false, lastEventAt: Date.parse("2026-10-19T11:08:00Z") } } });
  const [red] = planCounts(inputs([run("04:09"), run("03:34")], { id: "d4", name: "CI monitoring" }, at("05:29"))).redDuties;
  assert.match(red!.line, /\(duty field d4\/alerts_firing\) has a live owner now$/);
});

test("a check-in's stuck_steps miss owes no fix once none of its flagged steps is stuck on the live board (launch main bro, 03:29Z)", () => {
  const run: DutyRunRecord = { duty: "checkin", at: at("02:46"), trigger: "schedule", ms: 1, verdict: "met", summary: "", metrics: { stuck_steps: { value: 0, target: 0, op: "<=", met: true } },
    job: { id: "j1", name: "check-in launch main bro 11:46" },
    after: { at: at("03:04"), verdict: "missed", summary: "", metrics: { stuck_steps: { value: 1, target: 0, op: "<=", met: false } } } };
  const out = planCounts(inputs([run], { id: "checkin", name: "Check-in" }, at("03:29"), 60 * MIN));
  assert.equal(out.stuck.length, 0, "the flagged step has an owner on the live board");
  assert.equal(out.redDuties.length, 0);
  assert.equal(planCounts(inputs([run], { id: "checkin", name: "Check-in" }, at("05:29"), 60 * MIN)).redDuties.length, 1, "a check-in older than its interval proves nothing");
});

test("a duty whose newest job was cut and waits for its rerun is owned; a rerun cut by no transient failure and a rerun that ran are not (d9, 03:52Z to 06:16Z)", () => {
  const cut = { error: "pi-pool: this session waits for its slot", at: at("05:29"), provider: "anthropic", slotAt: Date.parse("2026-10-20T07:23:24Z") };
  const missed = { stuck_duties: { value: 2, target: 0, op: "<=" as const, met: false } };
  const run = (clock: string, trigger: DutyRunRecord["trigger"], extra: Partial<DutyRunRecord> = {}): DutyRunRecord => ({ duty: "d9", at: at(clock), trigger, ms: 1,
    verdict: "missed", summary: "", metrics: missed, job: { id: `job-${clock}`, name: `chat system ${clock}` }, ...extra });
  const stuck = [{ chat: HARNESS, duty: "d9", line: "d9" }];
  const read = (runs: DutyRunRecord[]) => withoutWorkingRuns(stuck, new Map([[HARNESS, runs]]), [], at("06:16")).length;
  assert.equal(read([run("05:29", "schedule", { cut })]), 0, "the cut run waits for its rerun");
  assert.equal(read([run("03:52", "rerun", { cut, rerunOf: at("03:29") })]), 0, "a rerun cut by a pool wait waits for its own rerun");
  const refused = { error: "Model refused to respond (refusal): cyber: This request triggered restrictions.", at: at("03:53"), provider: "anthropic" };
  assert.equal(read([run("03:52", "rerun", { cut: refused, rerunOf: at("03:29") })]), 1, "a rerun cut by no transient failure is not run again");
  assert.equal(read([run("05:52", "rerun", { rerunOf: at("05:29"), after: { at: at("06:00"), verdict: "missed", summary: "", metrics: missed } }), run("05:29", "schedule", { cut })]), 1,
    "the rerun ran and ended, so the miss needs a fix step again");
});

test("a duty whose job still works stays owned when a later run measured with no job of its own or a cut job went on (d9, 10-22 07:20Z)", () => {
  const day = (clock: string) => Date.parse(`2026-10-22T${clock}Z`);
  const missed = { unlabeled_lines: { value: 67, target: 0, op: "<=" as const, met: false } };
  const run = (clock: string, trigger: DutyRunRecord["trigger"], extra: Partial<DutyRunRecord> = {}): DutyRunRecord => ({ duty: "d11", at: day(clock), trigger, ms: 1,
    verdict: "missed", summary: "", metrics: missed, ...extra });
  const job = { id: "01a16199-0000-7000-8000-000000000011", name: "owner messages AI harness developer environment 10-22 06:03" };
  const stuck = [{ chat: HARNESS, duty: "d11", line: "d11" }];
  const read = (runs: DutyRunRecord[], wrote: string) => withoutWorkingRuns(stuck, new Map([[HARNESS, runs]]),
    [{ sessionId: job.id, activity: "idle", lastActivityAt: new Date(day(wrote)).toISOString() }], day("07:20:00")).length;
  const skipped = run("07:05:16", "verify", { summary: "unlabeled_lines 67 (target at most 0); skipped: previous run still working" });
  assert.equal(read([skipped, run("21:03:02", "schedule", { at: day("21:03:02") - 86_400_000, job })], "07:19:00"), 0, "AI harness d11: its 06:03 job worked");
  const cut = { error: "pi-pool: this session waits for its slot at 2026-10-22T06:48:00.000Z.", at: day("06:37:15"), provider: "anthropic", slotAt: day("06:48:00") };
  const cutRun = run("04:30:01", "schedule", { job, cut });
  const rerun = run("06:59:08", "rerun", { rerunOf: cutRun.at, summary: "skipped: previous run still working" });
  assert.equal(read([rerun, cutRun], "07:13:02"), 0, "CI and RepoOps d2: its cut job went on and wrote after the cut");
  assert.equal(read([rerun, cutRun], "06:37:15"), 1, "a cut job that wrote nothing since its cut and has a rerun owes the fix");
  assert.equal(read([skipped, run("06:03:00", "schedule", { job, after: { at: day("06:40:00"), verdict: "missed", summary: "", metrics: missed } })], "06:40:00"), 1,
    "a job that ended owes the fix");
});

const P804 = "Fix: a step whose job the cleanup ends while it waits keeps a live owner, so d9 stuck_steps_all reads 0";
const harnessBoard = (status: "doing" | "done", note = "Done (d4c9872c, 4323c96c)."): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-22T06:34:00Z", todos: [],
  plan: [{ id: "p706", text: "Every chat runs on its own", status: "doing", children: [{ id: "p804", text: P804, status, duty: "d9/stuck_steps_all",
    job: "d9 residuals 10-21", note, children: [] }] }] }) as unknown as ChatBoard;

test("verifyNoteOps writes a verify run's reading into a closed fix step's note and leaves it done (p804, 10-22 06:34Z)", () => {
  const streak = { key: "stuck_steps_all", misses: 1, moved: false, since: at("06:34"), value: 1, target: 0, op: "<=" as const, stuck: false,
    fix: { step: "p804", job: "d9 residuals 10-21", live: false } };
  const words = "Done (d4c9872c, 4323c96c). The 06:34Z verify run read stuck_steps_all 1, target <= 0.";
  assert.deepEqual(verifyNoteOps(harnessBoard("done"), [streak], at("06:34")), [{ op: "plan_update", id: "p804", note: words }]);
  assert.deepEqual(verifyNoteOps(harnessBoard("done", words), [streak], at("06:34")), [], "the same reading is not written twice");
  assert.deepEqual(verifyNoteOps(harnessBoard("doing"), [streak], at("06:34")), []);
});

test("a verify run that still misses leaves the fix step whose close started it done (p804, 10-22 06:34Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "d9-verify-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { stuck_steps_all: 1 } }));`);
    const store = new DutyStore(dir);
    const now = at("06:34");
    const duty: Duty = { id: "d9", name: "Chat system", ownerWords: "keeping this compliant on it's own your duty", goal: "every red duty has a fix job",
      metrics: [{ key: "stuck_steps_all", label: "Stuck steps", op: "<=", target: 0, headline: true }], schedule: { kind: "every", minutes: 120 },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active", createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
      runCount: 1, lastRunAt: now - 30 * MIN };
    await store.update(HARNESS, duties => { duties.push(duty); });
    let board = harnessBoard("done");
    const applied: BoardOp[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: { chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }), working: async () => false, retire: async () => {},
        start: async (_chat, name) => ({ id: "verify-job", name }) },
      checkIn: { view: async () => ({ everyMs: 30 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => board, fixLive: async () => false,
      applyBoard: async (_chat, ops) => {
        const list = ops(board);
        applied.push(...list);
        for (const op of list) if (op.op === "plan_update" && op.status) board = harnessBoard(op.status === "done" ? "done" : "doing");
      },
    });
    await duties.boardChanged(HARNESS, harnessBoard("doing"));
    await duties.boardChanged(HARNESS, harnessBoard("done"));
    await duties.settled();
    duties.close();
    assert.equal((await store.runs(HARNESS))[0]!.trigger, "verify");
    assert.equal(board.plan[0]!.children[0]!.status, "done");
    assert.deepEqual(applied.filter(op => op.op === "plan_update" && op.id === "p804").map(op => "status" in op ? op.status : undefined), [undefined]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 06:47Z: d9 still read CI and RepoOps' d5 false_reds_24h, 4 ci02 reds of 10-19 17:05Z whose fix was live, since its precheck gave no lastEventAt.
test("a red windowed count with no lastEventAt reads as a lagging window, not stuck, and d9's push asks its chat to add the field (CI and RepoOps d5)", () => {
  const run = (clock: string): DutyRunRecord => ({ duty: "d5", at: at(clock), trigger: "push", ms: 1, verdict: "missed", summary: "", metrics: {
    false_reds_24h: { value: 4, target: 0, op: "<=", met: false }, refused_lands_promotes_7d: { value: 0, target: 0, op: "<=", met: true } } });
  const out = planCounts(inputs([run("06:12"), run("04:10")], { id: "d5", name: "CI test results" }, at("06:47")));
  assert.equal(out.redDuties.length, 0);
  assert.deepEqual(out.lagging.map(duty => [duty.duty, duty.keys]), [["d5", ["false_reds_24h"]]]);
  assert.match(out.lagging[0]!.line, /^frontend bro: CI test results misses false_reds_24h, a count over a trailing window with no lastEventAt, so d9 reads it as a lagging window\. Add lastEventAt/);
  assert.deepEqual(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], lagging: out.lagging }).map(entry => [entry.chat, entry.duties.length]), [[FRONTEND, 1]]);
});

test("a share, ratio or volume over a window is no windowed count, so a red one with no lastEventAt still owes a fix (metal-management d3)", () => {
  assert.deepEqual(unreadWindows(["cpu_wait_pct_1h", "cache_read_ratio_24h", "nvme0_tb_24h", "profiles_p95_s", "noisy_rules_24h", "new_unindexed_3d"], {}), ["noisy_rules_24h", "new_unindexed_3d"]);
  const run: DutyRunRecord = { duty: "d3", at: at("06:00"), trigger: "schedule", ms: 1, verdict: "missed", summary: "", metrics: { cpu_wait_pct_1h: { value: 38.7, target: 20, op: "<=", met: false } } };
  assert.equal(planCounts(inputs([run], { id: "d3", name: "Prod box headroom" }, at("06:47"))).redDuties.length, 1);
});

// 10-22 07:40Z: d9 asked Crawler VP to add lastEventAt to prod_alerts_over_24h, alert kinds firing now for over 24 h, which has no trailing window.
test("a count of things in a state for over an age, or a count that must reach a floor, is no lagging window (Crawler VP prod_alerts_over_24h)", () => {
  assert.deepEqual(unreadWindows(["prod_alerts_over_24h", "meta_walks_overdue_1d", "reviews_waiting_24h", "false_reds_24h"], {}), ["false_reds_24h"]);
  assert.deepEqual(unreadWindows(["report_days_7d", "rule_breaks_24h"], {
    report_days_7d: { value: 5, target: 7, op: ">=", met: false }, rule_breaks_24h: { value: 2, target: 0, op: "<=", met: false } }), ["rule_breaks_24h"]);
});

test("a duty whose newest job ended on a pool wait the runner has not recorded as a cut yet waits for its rerun too (CI and RepoOps d4, 07:01Z)", () => {
  const run: DutyRunRecord = { duty: "d4", at: at("06:56"), trigger: "verify", ms: 1, verdict: "missed", summary: "",
    metrics: { alerts_firing: { value: 1, target: 0, op: "<=", met: false } }, job: { id: "01a15819-1aa8-7108-b3d1-1331582fc4c7", name: "ci monitoring CI and RepoOps 15:56" } };
  const stuck = [{ chat: FRONTEND, duty: "d4", line: "d4" }];
  const read = (runs: DutyRunRecord[], poolCut: string[]) => withoutWorkingRuns(stuck, new Map([[FRONTEND, runs]]), [], at("07:01"), new Set(poolCut)).length;
  assert.equal(read([run], [run.job!.id]), 0);
  assert.equal(read([run], []), 1, "a job that ended with no pool wait owes the fix");
  assert.equal(read([{ ...run, trigger: "rerun", rerunOf: at("05:00") }], [run.job!.id]), 0, "a rerun that ended on a pool wait waits for its own rerun");
});

test("a check-in's board metric the live board reads clean owes no fix, though its after-job measure missed it (CI and RepoOps, 10-29 02:25Z)", () => {
  const day = (clock: string) => Date.parse(`2026-10-29T${clock}Z`);
  const zero = { value: 0, target: 0, op: "<=" as const, met: true };
  const run: DutyRunRecord = { duty: "checkin", at: day("02:21:54"), trigger: "schedule", ms: 1, verdict: "missed", summary: "",
    metrics: { stuck_steps: { value: 1, target: 0, op: "<=", met: false }, no_done_line: zero, plan_risks: zero }, job: { id: "j1", name: "check-in CI and RepoOps 11:21" },
    after: { at: day("02:25:25"), verdict: "missed", summary: "", metrics: { stuck_steps: zero, no_done_line: { value: 1, target: 0, op: "<=", met: false }, plan_risks: zero } } };
  const goal = (note: string) => ({ ...empty, plan: [{ id: "p1", text: "Push verdict p90 under 10 min", status: "doing", note, children: [] }] }) as unknown as ChatBoard;
  const read = (board: ChatBoard) => planCounts({ ...inputs([run], { id: "checkin", name: "Check-in" }, day("02:25:30"), 60 * MIN), boards: new Map([[FRONTEND, board]]) });
  assert.equal(read(goal("Done when p90 reads under 10 min on main")).redDuties.length, 0, "every open goal has a done line now");
  assert.deepEqual(read(goal("")).redDuties.map(red => red.keys), [["no_done_line"]], "a goal with no done line still owes a fix");
});
