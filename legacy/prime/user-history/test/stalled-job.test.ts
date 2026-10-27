// AI harness 10-23: p919's job "codex fhnyq29tw5 sign-in" (session 01a16475) started `python3 /tmp/codex_scan.py` at 10:19:56Z, whose glob
// /home/sieun/**/codex*/auth.json walked all of home. The call sat at 99% CPU with no new session entry for 2 h 53 min until the d5 run
// killed PID 3281775 at 13:13Z, and the d5 brief, the check-in and d9 read p919 as owned by a live job all that time, since the daemon row
// read working and isSessionActive. A job stalled in one tool call past STALL_MS is no live owner, and the brief names its process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withCatalogOwners } from "../scripts/duties/chat-system.ts";
import { missLine } from "../src/chat-duty-job.ts";
import { endState, endStateKpi } from "../src/checkin-end-state.ts";
import { withStalls } from "../src/checkin-load.ts";
import type { JobFact, StepView } from "../src/checkin-steps.ts";
import { CallWatch } from "../src/hung-calls.ts";
import { dutyFixes, fixJobLive, fixLiveReader } from "../src/shared/duty-fixes.ts";
import type { MetricStreak } from "../src/shared/duty-streak.ts";
import { STALL_MS, stalledCalls, stalledSince } from "../src/shared/stalled-calls.ts";
import type { ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";

const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const CODEX = "01a16475-7638-74bc-ae7f-8d8e817677e8";
const JOB = "codex fhnyq29tw5 sign-in";
const at = (clock: string) => Date.parse(`2026-10-23T${clock}Z`);
const NOW = at("13:13:00");
/** The daemon row of the job during the scan: in a tool call, last written when the call began. */
const daemonRow = (since: string) => ({ sessionId: CODEX, lifecycle: "live", activity: "working", isSessionActive: true, activeSessionId: "baa4492e44da",
  isRunningTools: true, lastActivityAt: `2026-10-23T${since}Z`, modified: `2026-10-23T${since}Z` });
const scan = { pid: 3281775, command: "python3 /tmp/codex_scan.py", startedAt: at("10:19:57") };
const p919: PlanItem = { id: "p919", text: "Codex account fhnyq29tw5 is signed back into the account pool", status: "doing", children: [],
  duty: "d5/skills_or_tools_to_fix", job: JOB, sessionId: CODEX };
const agent: ChatAgent = { key: `thread:${CODEX}`, sessionId: CODEX, name: JOB, job: `session:${CODEX}`, sender: JOB, link: "root", state: "working", steps: ["p919"] };
const row = (id: string, fields: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/", kind: "live", status: "running", archived: false, messageCount: 1,
  working: true, subagentsRunning: 0, unread: false, tags: [], priority: 0, ...fields } as SessionRow);
const rows = [row(HARNESS, { chat: true, agents: [agent] }), row(CODEX, { name: JOB })];

test("a session in one tool call reads stalled only past STALL_MS, from its last write", () => {
  assert.equal(stalledSince(daemonRow("10:19:56.291"), NOW), at("10:19:56.291"));
  assert.equal(stalledSince(daemonRow("12:40:00"), NOW), undefined, "a 33 min call is under STALL_MS and still counts as at work");
  assert.equal(stalledSince({ ...daemonRow("10:19:56"), isRunningTools: false }, NOW), undefined, "a turn queued for a slot writes nothing too, but runs no tool");
  assert.equal(stalledSince({ ...daemonRow("10:19:56"), modified: "2026-10-23T13:00:00Z" }, NOW), undefined, "a newer write ends the stall");
  assert.equal(STALL_MS, 45 * 60_000);
});

test("p919's job stalled in its scan is no live fix, and the d5 brief names the process to stop", async () => {
  const stalls = stalledCalls([daemonRow("10:19:56.291")], NOW, session => session === CODEX ? scan : undefined);
  assert.equal(fixJobLive(p919, HARNESS, rows, new Set(), new Set(), NOW), true, "without the stall the working row reads live, as on 10-23");
  assert.equal(fixJobLive(p919, HARNESS, rows, new Set(), new Set(), NOW, stalls), false);
  const reader = fixLiveReader({ rows: async () => rows, asleep: async () => [], pool: async () => [], held: () => [], stalls: () => stalls }, () => NOW);
  const fixes = await dutyFixes({ v: 2, rev: 1, updatedAt: "2026-10-23T10:00:00Z", plan: [p919], todos: [] } as ChatBoard, "d5", ["skills_or_tools_to_fix"],
    item => reader(HARNESS, item));
  const fix = fixes.skills_or_tools_to_fix!;
  assert.equal(fix.live, false);
  assert.equal(fix.stalled?.process?.pid, 3281775);
  const streak: MetricStreak = { key: "skills_or_tools_to_fix", misses: 8, moved: false, since: at("06:00:00"), value: 1, target: 0, op: "<=", stuck: true, fix };
  const line = missLine("d5", streak, "Skills or tools to fix", "", NOW);
  assert.match(line, /has the job codex fhnyq29tw5 sign-in, which is stalled, not live: it has sat in one tool call for 173 min since 10:19Z with no new session entry/);
  assert.match(line, /pid 3281775 runs `python3 \/tmp\/codex_scan\.py` and has run 173 min/);
  assert.match(line, /`kill 3281775`/);
  assert.doesNotMatch(line, /has the live job/);
});

test("a stalled owner leaves its step stuck in the check-in's count", () => {
  const owner: JobFact = { key: `thread:${CODEX}`, name: JOB, state: "working", activityAt: at("10:19:56"), item: { id: "p919", text: p919.text, status: "doing" } };
  const [fact] = withStalls([owner], stalledCalls([daemonRow("10:19:56")], NOW, () => scan), () => undefined);
  const view: StepView = { item: p919, changedAt: at("09:10:00"), mine: false, owner: fact, openTodos: [], cls: "live" };
  const state = endState(view, [], rows, new Set([HARNESS]), NOW, [fact!]);
  assert.equal(state.state, "stalled_call");
  assert.match(state.reason, /^codex fhnyq29tw5 sign-in thread has sat in one tool call for 173 min/);
  assert.equal(endStateKpi([state]).stuck, 1);
  const asleep = withStalls([{ ...owner, wake: "a board.wake at 14:00Z" }], stalledCalls([daemonRow("10:19:56")], NOW), () => undefined);
  assert.equal(asleep[0]!.state, "working", "an owner asleep on a wake is no open call");
});

test("d9 reads a stalled catalog row at its last write, not now", () => {
  const { ownerActivity } = withCatalogOwners({}, new Map([[HARNESS, [{ ...daemonRow("10:19:56"), sessionName: JOB }]]]), NOW);
  assert.equal(ownerActivity.get(CODEX), at("10:19:56"));
  const working = withCatalogOwners({}, new Map([[HARNESS, [{ ...daemonRow("13:00:00"), sessionName: JOB }]]]), NOW);
  assert.equal(working.ownerActivity.get(CODEX), NOW);
});

test("the watch keeps the biggest command's pid and start for a stalled call's line", () => {
  const calls = new CallWatch();
  calls.judge([{ session: CODEX, since: at("10:19:56"), at: at("11:00:00"), kernelS: 1, workS: 2000, command: scan.command, pid: scan.pid, started: scan.startedAt / 1000 }],
    at("11:00:00"), () => ({ name: JOB, root: CODEX, tree: JOB }));
  assert.deepEqual(calls.process(CODEX), scan);
  assert.equal(calls.process(HARNESS), undefined);
});
