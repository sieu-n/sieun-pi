import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyDutyOps } from "../scripts/board-apply.ts";
import { createdRootChat } from "../src/chat-brief.ts";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { CHECK_IN_FOCUS } from "../src/chat-duty-run.ts";
import { dutyJobBrief } from "../src/chat-duty-job.ts";
import { ESCALATE_MS, type FiringAlert, stepNote, stepTitle } from "../src/alert-bridge.ts";
import { endState, endStateKpi, endStateLine } from "../src/checkin-end-state.ts";
import { type JobFact, LIVE_GAP_MS, liveWindowMs, stepView } from "../src/checkin-steps.ts";
import { headlineLabel } from "../src/client/duty-cadence.ts";
import { CHECK_IN_DUTY, type DutyMetric, type DutyView, judge } from "../src/shared/chat-duties.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

/**
 * The owner's end state as the check-in's headline KPI (owner 10-14: "all the PLAN list should clear or be stuck in FOR YOU right? check in duty
 * should push forward the agent swarm"; on the Chat system duty: "this is your KPI"). At 03:11Z that day 102 of 179 open leaf steps were
 * stuck, most of them `waiting` on a release or a CI run with an idle job, which broke no check-in target.
 */
const NOW = Date.UTC(2026, 9, 14, 3, 0);
const MIN = 60_000;
const step = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text: `step ${id} ships the crawler fix`, status: "blocked", children: [], ...extra });
const todo = (id: string, text: string, extra: Partial<OwnerTodo> = {}): OwnerTodo => ({ id, text, done: false, from: "agent", at: "2026-10-14T00:00:00Z", ...extra });
const idle: JobFact = { key: "c-1", name: "crawler fix", state: "ended", activityAt: NOW - 50 * MIN };
const working: JobFact = { key: "c-2", name: "crawler watch", state: "working", activityAt: NOW - MIN };
const self = new Set(["chat-1", "VP of CI"]);
const view = (item: PlanItem, facts: JobFact[], todos: OwnerTodo[] = [], changedAt = NOW - 10 * MIN) =>
  stepView(item, changedAt, self, facts, todos.filter(entry => !entry.done), [], NOW, new Set(["c40"]));
const state = (item: PlanItem, facts: JobFact[], todos: OwnerTodo[] = [], changedAt?: number) => endState(view(item, facts, todos, changedAt), todos, [], self, NOW);

test("end state: a wait on a release, a CI run or the owner with no linked todo is stuck; a working owner, a linked todo or a park is not", () => {
  assert.equal(state(step("p1", { job: "crawler fix", waitFor: "Fable's land 34 released" }), [idle]).state, "release",
    "a step whose job went idle on a land counts as waiting in the classes, and as stuck here");
  assert.equal(state(step("p2", { job: "crawler fix", waitFor: "run 18331878463 green" }), [idle]).state, "ci");
  assert.equal(state(step("p3", { job: "crawler watch", waitFor: "Fable's land 34 released" }), [working]).state, "moving", "a live job that watches the land moves it");
  assert.equal(state(step("p4", { waitFor: "the owner's go on the proxy plan" }), []).state, "owner_no_todo");
  assert.equal(state(step("p4", { waitFor: "the owner's go on the proxy plan, t7" }), [], [todo("t7", "Go on the proxy plan?")]).state, "foryou");
  assert.equal(state(step("p5", { note: "parked under c40 until the owner says 5180 is good enough" }), []).state, "parked");
  assert.equal(state(step("p6", { status: "todo" }), []).state, "no_owner");
  assert.equal(state(step("p7", { job: "crawler fix", status: "doing" }), [idle]).state, "job_ended");
});

test("end state: a todo that only shares a word with the step does not hold it, and a chat-owned wait rewritten a minute ago is still stuck", () => {
  const item = step("p8", { waitFor: "Fable's crawler release" });
  const words = [todo("t3", "Pick the crawler vendor for the proxy plan")];
  assert.equal(view(item, [], words).cls, "foryou", "the step classes count a shared word as For you");
  assert.equal(state(item, [], words).state, "release", "the end state needs an explicit link");
  assert.equal(state(step("p9", { job: "VP of CI", status: "todo", waitFor: "land 35 lands, ETA 03:15Z" }), [], [], NOW - MIN).state, "release",
    "a new ETA in the wait text is no progress");
  assert.equal(state(step("p10", { job: "VP of CI", status: "doing" }), [], [], NOW - MIN).state, "moving", "the chat works on its own step");
});

test("end state KPI: the check-in brief opens with the share and lists every stuck step, and stuck_steps counts them", () => {
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "2026-10-14T02:00:00Z", todos: [todo("t7", "Go on the proxy plan?", { step: "p4" })],
    plan: [{ id: "p0", text: "Ship the crawler fix", status: "doing", children: [step("p1", { job: "crawler fix", waitFor: "land 34 released" }), step("p4", { waitFor: "the owner's go" }),
      step("p3", { job: "crawler watch", status: "doing" })] }] } as unknown as ChatBoard;
  const precheck = checkInPrecheck(undefined, [idle, working], board, NOW, { self: [...self] });
  const kpi = endStateKpi(precheck.end);
  assert.deepEqual({ open: kpi.open, ok: kpi.ok, stuck: kpi.stuck, pct: kpi.pct }, { open: 3, ok: 2, stuck: 1, pct: 66.7 });
  assert.equal(endStateLine(kpi), "End state: 2 of 3 open steps (66.7%) are moving, in For you or parked; 1 stuck (release 1).");
  const output = convergenceMisses("chat-1", precheck.steps, precheck, {}, 15 * MIN, NOW);
  assert.equal(output.metrics.stuck_steps, 1);
  const text = checkInPrecheckText(precheck, [idle, working], output.flagged, NOW, { "stuck_steps p1": 3 });
  assert.ok(text.startsWith("Goals: 0 of 1 open goals are off pace or have no live owner, and 1 has no number"), text.slice(0, 120));
  assert.ok(text.indexOf("End state: 2 of 3 open steps (66.7%)") > text.indexOf("### Goals"), "the steps come second, after the goals");
  assert.match(text, /### Stuck steps \(the owner's end state[^\n]*\n- p1 "step p1 ships the crawler fix" is stuck \(release\)[^\n]*\(stuck in 3 check-ins in a row\)/);
  assert.doesNotMatch(text, /Flagged again[\s\S]*stuck_steps:/, "a stuck step is listed once, under Stuck steps");
});

test("headline metric: the check-in is judged on goal_gaps first and stuck_steps second, the duty brief leads with the headline, and the card shows it first", () => {
  assert.deepEqual(CHECK_IN_DUTY.metrics[0], { key: "goal_gaps", label: "Open goals off pace or with no live job that owns their number", op: "<=", target: 0, headline: true });
  assert.deepEqual(CHECK_IN_DUTY.metrics[1], { key: "stuck_steps", label: "Open steps nobody is moving (no live job, For you todo or owner ruling holds them)", op: "<=", target: 0 });
  const metrics: DutyMetric[] = [{ key: "corrections", label: "Owner corrections", op: "<=", target: 1 },
    { key: "end_state_pct", label: "Open steps moving, in For you or parked, all chats", op: ">=", target: 100, unit: "%", headline: true }];
  assert.equal(judge(metrics, { metrics: { corrections: 3, end_state_pct: 43 } }).summary, "end_state_pct 43% (target at least 100%), corrections 3 (target at most 1)");
  assert.equal(judge(metrics, { metrics: { corrections: 3, end_state_pct: 100 } }).summary, "end_state_pct 100% (on target), corrections 3 (target at most 1)");
  const run = { at: NOW, verdict: "missed", summary: "", metrics: { end_state_pct: { value: 43, target: 100, op: ">=", met: false } } };
  assert.equal(headlineLabel({ duty: { metrics }, runs: [run] } as unknown as DutyView), "Open steps moving, in For you or parked, all chats 43%, target at least 100%, off target");
  const brief = dutyJobBrief({ duty: { name: "Chat system", ownerWords: "w", goal: "g", metrics }, chat: { id: "c1", name: "dev VP", board: "/data/boards/c1.json" },
    job: "chat system dev VP 14:00", at: NOW, measure: "m", findings: "f" });
  assert.ok(brief.indexOf("## Headline KPI") < brief.indexOf("Targets:"), "the headline comes before the targets");
  assert.match(brief, /judged on moving one number: Open steps moving, in For you or parked, all chats \(end_state_pct >= 100%\)/);
});

test("duty jobs act: they apply board ops to the chat's board themselves and start owners that outlive the run", async () => {
  const brief = dutyJobBrief({ duty: { ...CHECK_IN_DUTY }, chat: { id: "c1", name: "VP of CI", board: "/data/chat/boards/c1.json" }, job: "check-in VP of CI 14:00",
    at: NOW, measure: "m", findings: "f", focus: CHECK_IN_FOCUS });
  assert.doesNotMatch(brief, /You cannot edit the board/, "10-13: the chats dropped 401 of 3,287 check-in ops in 48 h");
  assert.match(brief, /node --import tsx scripts\/board-apply\.ts c1 " \+ shlex\.quote\(json\.dumps\(ops\)\) \+ " --data-dir \/data\/chat/);
  assert.match(brief, /rlm\.create_session\(brief, name=\.\.\., cwd=\.\.\.\)`, which registers the session as a job of the chat/);
  assert.match(brief, /Your number is goal_gaps/);
  const dir = await mkdtemp(join(tmpdir(), "board-apply-"));
  const chat = "01a1164b-4a2d-742d-b27a-82f086ed0200";
  assert.match(await applyDutyOps(dir, chat, [{ op: "plan_add", text: "Ship the crawler fix" }]), /p1/);
  const board = JSON.parse(await readFile(join(dir, "boards", `${chat}.json`), "utf8")) as ChatBoard;
  assert.equal(board.plan[0]!.text, "Ship the crawler fix");
  await assert.rejects(applyDutyOps(dir, chat, []), /Add a board op/);
  const duty = { chat: "VP of CI", root: true };
  assert.equal(createdRootChat({ marked: false, self: "check-in VP of CI 14:00", job: duty, dutyJob: true }), "VP of CI", "a duty job's roots are the chat's jobs");
  assert.equal(createdRootChat({ marked: false, self: "land runner", job: duty, dutyJob: false }), null, "another root job's roots stay its own");
  assert.equal(createdRootChat({ marked: true, self: "VP of CI", job: null, dutyJob: false }), "VP of CI");
});

test("liveness: a job counts as working for the chat's interval capped at 30 min, the p99.9 quiet between model calls", () => {
  assert.equal(LIVE_GAP_MS, 30 * MIN);
  assert.equal(liveWindowMs(2 * 60 * MIN), 30 * MIN, "AI harness and ops guy check in every 2 h; a job idle 1 h 50 min read as working");
  assert.equal(liveWindowMs(15 * MIN), 15 * MIN);
});

test("end state: a step the alert bridge just added is moving until ESCALATE_MS, then stuck with no owner, and its resolve line ends the hold", () => {
  const alert: FiringAlert = { fingerprint: "3a1f09c2d7e4b5a6", startsAt: "2026-10-14T02:56:00.000Z", alertname: "Enrichment output stalled", labels: { severity: "warning" },
    summary: "Visual enrichment completed ZERO jobs in the last 2h while more than 1000 due jobs wait.", url: "https://obs.virev.ai/alerting/grafana/enrich/view" };
  const added = step("p360", { status: "todo", text: stepTitle(alert), note: stepNote(alert) });
  const fresh = state(added, [], [], NOW - 6 * MIN);
  assert.equal(fresh.state, "moving", "the 18:58 KST Crawler VP check-in counted p360 stuck 6 min after the bridge added it");
  assert.match(fresh.reason, /alert bridge added it 6 min ago and escalates it at 30 min/);
  assert.equal(view(added, [], [], NOW - 6 * MIN).cls, "live", "the step classes agree, so the precheck lists no orphan either");
  assert.equal(state(added, [], [], NOW - ESCALATE_MS).state, "no_owner", "past the bridge's escalation the step is stuck again");
  assert.equal(view(added, [], [], NOW - ESCALATE_MS).cls, "orphan");
  const resolved = { ...added, note: `${added.note}\nThe alert resolved at 2026-10-14T02:59:00.000Z, when the alert bridge saw every label set leave Grafana's firing list.` };
  assert.equal(state(resolved, [], [], NOW - MIN).state, "no_owner", "a resolved alert step with no owner needs the chat to close it");
  assert.equal(state(step("p361", { status: "todo", note: "Grafana alert came up in chat." }), [], [], NOW - MIN).state, "no_owner", "only the bridge's own mark counts");
  assert.equal(state({ ...added, waitFor: "the alert clears by itself" }, [], [], NOW - MIN).state, "event", "a wait the chat set takes over from the bridge");
});

test("end state: a step whose wait names a working job of this chat is moving, and a step left on a deleted job falls to that job", () => {
  // VP of CI 10-15: the job git rules duty reshape was deleted once its part ended ("delete job git rules duty reshape"), p200 still named it, and
  // three check-ins in a row counted p200 stuck on a release ("no live job of this chat watches it") while the job ci train carried the objects.
  const train: JobFact = { key: "sub-ci-train", name: "ci train", state: "working", activityAt: NOW - MIN };
  const lanes: JobFact = { key: "sub-ci-lanes", name: "ci lanes for every app", state: "working", activityAt: NOW - 9 * MIN };
  const p200 = step("p200", { status: "doing", text: "Every CI duty is one headline number plus at most three supporting ones, and each miss has a live fix job",
    job: "git rules duty reshape", sessionId: "01a13a70-b2fc-7191-a914-3d3058bea249",
    waitFor: "ci train lands the d2 and d3 precheck objects; then git rules duty reshape and repo design duty reshape switch the configs" });
  const seen = view(p200, [train, lanes]);
  assert.equal(seen.owner?.name, "ci train", "the deleted job's step falls to the job its wait names, not \"(git rules duty reshape not found)\"");
  const end = endState(seen, [], [], self, NOW, [train, lanes]);
  assert.equal(end.state, "moving");
  assert.match(end.reason, /job ci train/);
  const reshape: JobFact = { key: "sub-reshape", name: "git rules duty reshape", state: "ended", activityAt: NOW - 40 * MIN };
  const kept = endState(view(p200, [reshape, train]), [], [], self, NOW, [reshape, train]);
  assert.deepEqual([kept.state, kept.reason], ["moving", "its wait is on job ci train, which works on it"], "an idle owner does not hide the job that carries the wait");
  const left = endState(view(p200, [lanes]), [], [], self, NOW, [lanes]);
  assert.equal(left.state, "release", "with ci train gone the wait is stuck again");
  const idleTrain = { ...train, state: "ended" as const };
  assert.equal(endState(view(p200, [idleTrain]), [], [], self, NOW, [idleTrain]).state, "release", "an idle job named in the wait moves nothing");
  const later = step("p201", { waitFor: "land 37 lands; then ci train reads it back" });
  assert.equal(endState(view(later, [train]), [], [], self, NOW, [train]).state, "release", "a job named only after \"then\" does not carry the wait");
});
