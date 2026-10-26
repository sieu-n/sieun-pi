// Guards the Chat system duty's precheck (d9), built 10-19 for the owner's rule that a plan holds only tasks that finish (msg mvfb7zt0).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, chatSystemOutput, failingTurns, fixNotMoving, manualSelection, goalsWithNoJob, jobsByChat, ownerMessages, planUpkeep, pushedFile, pushList, pushReached, pushRecords, pushSettled, pushTells, spotAuditLines, spread, waitsOnStep, withCatalogOwners, withoutWorkingRuns } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { MetricStreak } from "../src/shared/duty-streak.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const board = { v: 2, rev: 1, updatedAt: "2026-10-19T13:40:00Z", todos: [], plan: [
  { id: "p453", text: "Every duty in every chat is green", status: "doing", note: "Done when 109 of 109", children: [
    { id: "p454", text: "Fix the cache read share metric", status: "doing", children: [] },
    { id: "p455", text: "Fix the wiki search", status: "doing", note: "Done when a search for crawler finds the page", children: [] },
    { id: "p456", text: "Lift cache reads", status: "todo", duty: "d7/cache_ratio", children: [] },
    { id: "p457", text: "Ship the old fix", status: "done", children: [] }] },
] } as unknown as ChatBoard;

test("plan_upkeep_all counts an open upkeep item and an open step with no done line, once each", () => {
  assert.deepEqual(planUpkeep("c1", board).map(item => [item.id, item.why]),
    [["p453", 'reads like upkeep ("Every duty in every chat is green")'], ["p454", "has no Done when line"]]);
});

test("examples spread over chats and stop at 3, while the count line names every item and the detail file", () => {
  const items = ["a", "a", "a", "b", "c"].map((chat, index) => ({ chat, id: `p${index}`, text: `step ${index}`, why: "has no Done when line" }));
  assert.deepEqual(spread(items, 3).map(item => item.chat), ["a", "b", "c"]);
  const out = chatSystemOutput({ names: new Map([["a", "chat A"]]), stuck: [{ chat: "a", id: "p9", text: "Fix X" }], upkeep: items,
    fleet: { pct: 50, red: [] }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d9.md" });
  assert.deepEqual(out.metrics, { stuck_steps_all: 1, plan_upkeep_all: 5, duties_green_pct: 50, stuck_duties: 0, fix_not_moving: 0 });
  const upkeep = out.flagged!.filter(slice => slice.kind === "plan_upkeep");
  assert.equal(upkeep.length, 4);
  assert.match(upkeep[0]!.excerpt, /^5 open plan items .* in 3 chats; every one is in \/tmp\/d9\.md\.$/);
  assert.match(upkeep[1]!.excerpt, /^chat A: p0 "step 0" has no Done when line\.$/);
});

test("the spot audit quotes the owner's own messages and his board picks, never a job's or check-in's line", () => {
  const line = (text: string) => JSON.stringify({ type: "message", timestamp: "2026-10-19T13:40:00Z", message: { role: "user", content: [{ type: "text", text }] } });
  const lines = [line("keep crawler working"), line("[job] x failed"), line("[check-in] restarted y"), line('[board] Owner chose "Keep it"'),
    line("<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset.\n</provider_quota_resumed>"),
    line("<prime_agent_update_interrupted>\nPrime Agent was updated.\n</prime_agent_update_interrupted>"),
    line("Prime Agent restarted after an update. Continue the interrupted task from the saved transcript."), line("<b>bold</b> is fine?"),
    line("<prime_agent_worker_interrupted>\nThe worker stopped mid-turn.\n</prime_agent_worker_interrupted>"),
    line("<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset."),
    line("Watchdog recovery checkpoint: the session was idle with a turn open."),
    JSON.stringify({ message: { role: "assistant", content: "ok" } })];
  assert.deepEqual(ownerMessages(lines, 8).map(entry => entry.text), ["keep crawler working", '[board] Owner chose "Keep it"', "<b>bold</b> is fine?"]);
});

// Owner msg mvffndxl, 10-19: each d9 run pushes the chats, not just scores them.
test("a goal counts as having no live job only when none of its open items has a live owner on either box", () => {
  const now = Date.parse("2026-10-19T16:00:00Z");
  const goals = { v: 2, rev: 1, updatedAt: "2026-10-19T15:00:00Z", todos: [], plan: [
    { id: "p1", text: "Ship A", status: "doing", children: [{ id: "p2", text: "Fix A", status: "doing", sessionId: "s-local", children: [] }] },
    { id: "p3", text: "Ship B", status: "doing", children: [{ id: "p4", text: "Fix B", status: "doing", job: "mac job", children: [] }] },
    { id: "p5", text: "Ship C", status: "doing", children: [{ id: "p6", text: "Fix C", status: "todo", children: [] }] },
    { id: "p7", text: "Ship D", status: "done", children: [] }] } as unknown as ChatBoard;
  const reads = { now, named: new Map(), activity: new Map([["s-local", now - 5 * 60_000]]), waking: new Set<string>(), poolWaiting: new Set<string>(),
    jobs: [{ sessionId: "s-mac", sessionName: "mac job", activity: "working" }] };
  assert.deepEqual(goalsWithNoJob(goals, reads).map(goal => goal.id), ["p5"]);
  assert.deepEqual(goalsWithNoJob(goals, { ...reads, jobs: [], activity: new Map([["s-local", now - 3 * 3_600_000]]) }).map(goal => goal.id), ["p1", "p3", "p5"]);
});

// 10-20 06:16Z: the duty's goal counts "a For you question that links it" as an owner, so a goal waiting on an open todo is not pushed.
test("a goal whose open step an open For you todo links has an owner, and an answered todo does not count", () => {
  const now = Date.parse("2026-10-20T06:16:00Z");
  const reads = { now, named: new Map(), activity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(), jobs: [] };
  const board = (done: boolean) => ({ v: 2, rev: 1, updatedAt: "2026-10-20T06:00:00Z",
    todos: [{ id: "t40", text: "Check Campaigns", done, step: "p297", from: "agent", at: "2026-10-19T22:45:28Z" }],
    plan: [{ id: "p272", text: "Campaigns ready for you", status: "doing", children: [{ id: "p297", text: "You check Campaigns", status: "blocked", children: [] }] }] }) as unknown as ChatBoard;
  assert.deepEqual(goalsWithNoJob(board(false), reads).map(goal => goal.id), []);
  assert.deepEqual(goalsWithNoJob(board(true), reads).map(goal => goal.id), ["p272"]);
});

// 10-21 08:11Z and 08:23Z: d9 pushed metal-management on p91, whose goal and step wait for "the owner's answer on For you t6", while its check-in held it.
test("a goal whose wait names an open For you todo has an owner", () => {
  const now = Date.parse("2026-10-21T08:23:00Z");
  const reads = { now, named: new Map(), activity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(), jobs: [] };
  const wait = "the owner's answer on For you t6 of how to simplify the web addresses";
  const board = (done: boolean) => ({ v: 2, rev: 1, updatedAt: "2026-10-21T08:00:00Z",
    todos: [{ id: "t6", text: "How should the box's 19 web addresses get simpler?", done, from: "agent", at: "2026-10-19T16:41:34Z" }],
    plan: [{ id: "p91", text: "Simplify the box's web addresses", status: "blocked", waitFor: wait, note: "Done when the addresses match t6's pick.",
      children: [{ id: "p115", text: "Apply the web address layout the owner picks on t6", status: "blocked", waitFor: wait, children: [] }] }] }) as unknown as ChatBoard;
  assert.deepEqual(goalsWithNoJob(board(false), reads).map(goal => goal.id), []);
  assert.deepEqual(goalsWithNoJob(board(true), reads).map(goal => goal.id), ["p91"]);
});

// Owner rule c64: a step blocked only by an open For you todo is an end state, and any other open step nobody moves is not (metal-management p91, 10-21).
test("a goal is held on the owner only when every open item under it is held by an open todo or parked by his correction", () => {
  const now = Date.parse("2026-10-21T08:40:00Z");
  const reads = { now, named: new Map(), activity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>(), jobs: [] };
  const wait = "the owner's answer on For you t6";
  const step = (id: string, extra: object = {}) => ({ id, text: `Step ${id}`, status: "blocked", children: [], ...extra });
  const board = (children: object[]) => ({ v: 2, rev: 1, updatedAt: "2026-10-21T08:00:00Z",
    todos: [{ id: "t6", text: "How should the box's 19 web addresses get simpler?", done: false, from: "agent", at: "2026-10-19T16:41:34Z" }],
    plan: [{ id: "p91", text: "Simplify the box's web addresses", status: "blocked", children }] }) as unknown as ChatBoard;
  const gaps = (children: object[]) => goalsWithNoJob(board(children), reads).map(goal => goal.id);
  assert.deepEqual(gaps([step("p115", { waitFor: wait })]), []);
  assert.deepEqual(gaps([step("p115", { waitFor: wait }), step("p116", { note: "Parked by owner correction c40 until he says 5180 is good enough." })]), []);
  assert.deepEqual(gaps([{ ...step("p120"), status: "doing", children: [step("p115", { waitFor: wait })] }]), []);
  assert.deepEqual(gaps([step("p115", { waitFor: wait }), { ...step("p116"), status: "todo" }]), ["p91"]);
  assert.deepEqual(gaps([step("p115", { waitFor: wait }), step("p116", { waitFor: "the release owner's next land" })]), ["p91"]);
  assert.deepEqual(gaps([step("p116", { note: "Waits on the owner's answer, and For you has no question for it yet." })]), ["p91"]);
});

test("the push list joins a chat's idle goals and stuck duties, and the follow-up reads the tag and an answer after it", () => {
  const goal = { id: "p5", text: "Ship C", status: "doing", children: [] } as unknown as ChatBoard["plan"][number];
  assert.deepEqual(pushList({ idleGoals: [{ chat: "a", goals: [goal] }, { chat: "b", goals: [] }], stuckDuties: [{ chat: "a", line: "a: d1 red" }, { chat: "c", line: "c: d2 red" }], upkeep: [] })
    .map(entry => [entry.chat, entry.goals.length, entry.duties.length]), [["a", 1, 1], ["c", 0, 1]]);
  const tag = "[d9 push 2026-10-19T16:00Z]";
  const sent = JSON.stringify({ type: "custom_message", customType: "agent_message", content: `[agent-message from x]\n\n${tag} give p5 a job` });
  const answer = JSON.stringify({ type: "message", message: { role: "assistant", content: "on it" } });
  assert.deepEqual(pushReached([sent], tag), { delivered: true, read: false });
  assert.deepEqual(pushReached([answer, sent, answer], tag), { delivered: true, read: true });
  assert.deepEqual(pushReached([answer], tag), { delivered: false, read: false });
  // 10-23: the server sends the push itself, and it lands as a user message; the 07:02Z run read all 7 of the 05:01Z pushes as not delivered.
  const told = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${tag} The chat system duty (d9) found these` }] } });
  assert.deepEqual(pushReached([answer, told], tag), { delivered: true, read: false });
  assert.deepEqual(pushReached([told, answer], tag), { delivered: true, read: true });
});

test("a chat whose only miss is plan items with no done line is on the push list with those items", () => {
  // 10-19 20:22Z: 26 such items sat in 6 chats, and 4 of the chats (Crawler VP with 7) were on no push list, so no run messaged them.
  const upkeep = planUpkeep("d", board);
  const pushes = pushList({ idleGoals: [], stuckDuties: [{ chat: "c", line: "c: d2 red" }], upkeep });
  assert.deepEqual(pushes.map(entry => [entry.chat, entry.duties.length, entry.upkeep.map(item => item.id)]), [["c", 1, []], ["d", 0, ["p453", "p454"]]]);
  const output = chatSystemOutput({ names: new Map(), stuck: [], upkeep, fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d.md" });
  assert.ok(output.flagged?.some(slice => slice.kind === "push" && slice.excerpt.includes("plan item")));
});

// 10-20 00:29Z: frontend bro's p201 and p296 and mcp for chris's p3 had fix jobs working on the Mac, and d9 counted their red check-ins as
// stuck, because it read only this box's transcripts for a step owner's activity.
test("a red duty whose fix job works on the other box is not stuck once the catalog rows join the owner reads", () => {
  const now = Date.parse("2026-10-20T00:29:00Z");
  const FB = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
  const missed = (at: number) => ({ duty: "checkin", at, trigger: "schedule", verdict: "missed", ms: 1,
    metrics: { goal_gaps: { value: 1, target: 0, op: "<=", met: false } } });
  const fix = { v: 2, rev: 1, updatedAt: "2026-10-20T00:20:00Z", todos: [], plan: [
    { id: "p201", text: "Prod Discover loads again", status: "doing", duty: "checkin/goal_gaps", job: "prod release readback", sessionId: "s-mac", children: [] }] } as unknown as ChatBoard;
  const plan = { now, chats: [{ id: FB, name: "frontend bro", runs: [missed(now - 60_000), missed(now - 900_000), missed(now - 1_800_000)], everyMs: 900_000,
    paused: false, duties: [{ id: "checkin", name: "Check-in" }] }], boards: new Map([[FB, fix]]), ownerActivity: new Map<string, number>(),
    waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map<string, Map<string, string[]>>() } as unknown as PlanInputs;
  assert.equal(planCounts(plan).redDuties.length, 1);
  const row = { sessionId: "s-mac", sessionName: "prod release readback", sessionFile: `/Users/x/.prime/agent/session-artifacts/${FB}/sub-1/s-mac.jsonl` };
  const working = withCatalogOwners(plan, jobsByChat([{ ...row, activity: "working" }]), now);
  assert.equal(planCounts({ ...plan, ...working }).redDuties.length, 0);
  const idle = withCatalogOwners(plan, jobsByChat([{ ...row, activity: "idle", lastActivityAt: "2026-10-19T22:00:00Z" }]), now);
  assert.equal(planCounts({ ...plan, ...idle }).redDuties.length, 1);
});

// 10-20 01:2xZ: the AI harness chat's check-in counted as stuck while its own 01:19Z check-in job worked on the step its run flagged.
test("a stuck duty whose newest run's own job still works or waits for its rerun is left out, and one whose job ended or whose rerun was cut by no transient failure stays", () => {
  const now = Date.parse("2026-10-20T01:25:00Z");
  const run = (extra: object) => ({ duty: "checkin", at: now - 360_000, trigger: "schedule", verdict: "missed", ms: 1, job: { id: "s-job", name: "check-in x 10:19" },
    metrics: { stuck_steps: { value: 1, target: 0, op: "<=", met: false } }, ...extra });
  const stuck = [{ chat: "c", duty: "checkin", line: "x: Check-in red" }];
  const rows = [{ sessionId: "s-job", activity: "working" }];
  const left = (runs: object[], over = rows) => withoutWorkingRuns(stuck, new Map([["c", runs as never]]), over, now).length;
  assert.equal(left([run({})]), 0);
  assert.equal(left([run({ after: { at: now - 60_000, verdict: "missed", metrics: {} } })]), 1);
  assert.equal(left([run({ cut: { error: "pi-pool: this session waits for its slot", at: now - 300_000 } })]), 0);
  const cutRerun = run({ trigger: "rerun", rerunOf: now - 3_600_000, cut: { error: "pi-pool: this session waits for its slot", at: now - 300_000 } });
  const idleSince = [{ sessionId: "s-job", activity: "idle", lastActivityAt: new Date(now - 300_000).toISOString() }] as never;
  assert.equal(left([cutRerun], idleSince), 0, "a rerun cut by a pool wait waits for its own rerun");
  const refusedRerun = run({ trigger: "rerun", rerunOf: now - 3_600_000, cut: { error: "Model refused to respond (refusal): cyber.", at: now - 300_000 } });
  assert.equal(left([refusedRerun], idleSince), 1, "a rerun cut by no transient failure is not run again");
  assert.equal(left([cutRerun]), 0, "a cut rerun whose session works again after its cut is at work");
  assert.equal(left([run({})], [{ sessionId: "s-job", activity: "idle", lastActivityAt: "2026-10-19T20:00:00Z" }] as never), 1);
});

// 10-20 13:57Z: d9 counted the AI harness chat's d7 and Crawler VP's d9 as stuck while their fix jobs on p814 and p865, started with
// rlm.create_session, showed "working" in the catalog; their files sit under sessions/, so no chat claimed their rows.
test("a red duty whose fix step's create_session job works is not stuck, though its transcript last wrote before the run measured", () => {
  const now = Date.parse("2026-10-20T13:57:15Z");
  const CV = "01a11af8-0000-7000-8000-000000000000";
  const JOB = "01a15996-001e-70cc-ba2d-dab87c278b04";
  const missed = { duty: "d9", at: now - 180_000, trigger: "schedule", verdict: "missed", ms: 1, after: { at: now - 180_000, verdict: "missed", metrics: {} },
    metrics: { ig_queues_growing_6h: { value: 2, target: 0, op: "<=", met: false, lastEventAt: now - 600_000 } } };
  const fix = { v: 2, rev: 1, updatedAt: "2026-10-20T13:53:00Z", todos: [], plan: [{ id: "p864", text: "IG queues drain", status: "doing", note: "Done when 0", children: [
    { id: "p865", text: "Find the video-writer hold", status: "doing", duty: "d9/ig_queues_growing_6h", job: "ig video-writer hold root cause", sessionId: JOB, children: [] }] }] } as unknown as ChatBoard;
  const boards = new Map([[CV, fix]]);
  const plan = { now, chats: [{ id: CV, name: "Crawler VP", runs: [missed], everyMs: 3_600_000, paused: false, duties: [{ id: "d9", name: "Crawler running" }] }],
    boards, ownerActivity: new Map([[JOB, now - 400_000]]), waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map<string, Map<string, string[]>>() } as unknown as PlanInputs;
  assert.equal(planCounts(plan).redDuties.length, 1);
  const row = { sessionId: JOB, sessionName: "ig video-writer hold root cause", sessionFile: `/home/x/.prime/agent/sessions/${JOB}.jsonl`, activity: "working" };
  const jobs = jobsByChat([row], boards);
  assert.equal(planCounts({ ...plan, ...withCatalogOwners(plan, jobs, now) }).redDuties.length, 0);
  const reads = { now, named: new Map(), jobs: jobs.get(CV) ?? [], activity: new Map(), waking: new Set<string>(), poolWaiting: new Set<string>() };
  assert.deepEqual(goalsWithNoJob(fix, reads).map(goal => goal.id), []);
  const idle = jobsByChat([{ ...row, activity: "idle", lastActivityAt: "2026-10-20T13:50:00Z" }], boards);
  assert.equal(planCounts({ ...plan, ...withCatalogOwners(plan, idle, now) }).redDuties.length, 1);
  assert.equal(jobsByChat([row]).size, 0);
});

// 10-20: d9 listed the AI harness chat's d10 (repeat_corrections_7d 16, every line before its fix) among its red examples, and its job pushed
// for a fix step on it three times, while the duty runner's own read said the count only ages out and owes no job.
test("a red duty that misses only windowed counts with no new event since the run before reads as aging out, not as a red example", () => {
  const at = Date.parse("2026-10-20T14:08:59Z");
  const lastEventAt = Date.parse("2026-10-20T06:27:35Z");
  const run = (when: number, last?: number) => ({ duty: "d10", at: when, trigger: "push", verdict: "missed", ms: 1,
    metrics: { repeat_corrections_7d: { value: 16, target: 0, op: "<=", met: false, ...last === undefined ? {} : { lastEventAt: last } },
      repeats_after_fix_7d: { value: 0, target: 0, op: "<=", met: true } } }) as never;
  assert.equal(agingSince([run(at, lastEventAt), run(at - 3_600_000, lastEventAt)]), lastEventAt);
  assert.equal(agingSince([run(at, at - 600_000), run(at - 3_600_000, lastEventAt)]), undefined);
  assert.equal(agingSince([run(at), run(at - 3_600_000)]), undefined);
  const duty = (id: string, agingAt?: number) => ({ chat: "a", duty: id, name: id, green: false, misses: 12, stuck: false,
    ...agingAt === undefined ? {} : { agingSince: agingAt } });
  const out = chatSystemOutput({ names: new Map([["a", "AI harness"]]), stuck: [], upkeep: [], fleet: { pct: 50, red: [duty("d10", lastEventAt), duty("d7")] },
    stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d9.md" });
  assert.deepEqual(out.flagged!.filter(slice => slice.kind === "red_duty" && slice.item).map(slice => slice.item), ["d7"]);
  assert.match(out.flagged!.find(slice => slice.kind === "aging_duty")!.excerpt, /^AI harness d10 is red only on .* owe no fix job, so push nothing for them\.$/);
});

test("a push to a session that is no owner chat is read from its own catalog row", () => {
  const copies = [JSON.stringify({ rows: [{ sessionId: "01a10810-34b5-710f-88fe-3d369f89a8c9", sessionFile: "/home/u/.prime/agent/sessions/01a10810-34b5-710f-88fe-3d369f89a8c9.jsonl" }] })];
  const listed = new Map([["c1", { file: "/home/u/.prime/agent/sessions/c1.jsonl" }]]);
  assert.equal(pushedFile(listed, copies, "c1"), "/home/u/.prime/agent/sessions/c1.jsonl");
  assert.equal(pushedFile(listed, copies, "01a10810-34b5-710f-88fe-3d369f89a8c9"), "/home/u/.prime/agent/sessions/01a10810-34b5-710f-88fe-3d369f89a8c9.jsonl");
  assert.equal(pushedFile(listed, copies, "01a11d24-ac9b-757d-ac51-9b2b7598782f"), undefined);
});

test("a red duty whose live fix has not moved its number over 3 or more misses is counted and pushed for a root-cause job", () => {
  // 10-22 18:00Z: api portal vp's d1 missed 42 runs with probe_uptime_24h_pct never closer to 100 while p52's job was live, and d9 said nothing.
  const fix = { step: "p52", job: "schema promotes keep serving", live: true };
  const metric: MetricStreak = { key: "probe_uptime_24h_pct", misses: 42, moved: false, since: 0, value: 97.2, target: 100, op: ">=", fix, stuck: false };
  const duty = (id: string, change: Partial<MetricStreak> = {}, extra: object = {}) => ({ chat: "a", duty: id, name: id, green: false, misses: 42,
    stuck: false, fix: "p52", metric: { ...metric, ...change }, underFix: { misses: 8, moved: false }, ...extra });
  const red = [duty("d1"), duty("d2", {}, { underFix: { misses: 8, moved: true } }), duty("d3", {}, { underFix: { misses: 2, moved: false } }),
    duty("d4", { quietSince: 1 }), duty("d5", { fix: { ...fix, step: "p9" } }), duty("d6", {}, { fix: undefined }), duty("d7", {}, { agingSince: 1 }),
    duty("d8", {}, { underFix: undefined })];
  const found = fixNotMoving(red, () => "api portal vp");
  assert.deepEqual(found.map(entry => entry.duty), ["d1"]);
  assert.match(found[0]!.line, /^api portal vp: d1 \(d1\) missed probe_uptime_24h_pct 42 runs in a row, 8 of them under its fix step p52, 97\.2 against >= 100 and no closer than when p52 began, while p52 has a live job\. Replace that fix: start a root-cause job .* duty "d1\/probe_uptime_24h_pct", and close or drop p52/);
  const out = chatSystemOutput({ names: new Map([["a", "api portal vp"]]), stuck: [], upkeep: [], fleet: { pct: 50, red }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d9.md" });
  assert.equal(out.metrics.fix_not_moving, 1);
  assert.ok(out.flagged!.some(slice => slice.kind === "fix_not_moving" && slice.item === "d1"));
  assert.ok(out.flagged!.some(slice => slice.kind === "push" && slice.excerpt.startsWith("1 chat has")));
  assert.deepEqual(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], notMoving: found }).map(entry => [entry.chat, entry.duties]), [["a", [found[0]!.line]]]);
});

// d9 run of 10-24: the global-rules read guard refuses a read of another chat's transcript, so the spot audit reads the board, job list and agent_observe.
test("the spot audit brief points to the board, the job list and agent_observe, and never names a transcript or session file", () => {
  const lines = spotAuditLines({ spot: "01abc", title: "chat A", host: "us-metal02", dataDir: "/data", log: "/tmp/spot.md", asks: [],
    jobs: [{ sessionId: "01job1", sessionName: "fix wiki", activity: "working" }, { sessionId: "01job2", activity: "idle" }] });
  const text = lines.join("\n");
  assert.doesNotMatch(text, /transcript|session file|sessions\/|last turns/i);
  assert.match(text, /\/data\/boards\/01abc\.json: read its open plan, each step's note and requirements, and its todos/);
  assert.match(text, /job list holds 2 jobs of it, 1 working now: fix wiki \(01job1\)/);
  assert.match(text, /agent_observe/);
});

// d9 run of 10-24 00:49Z: CI and RepoOps' p361 (blocked, waitFor p368, no job) was the only stuck step, and CI and RepoOps got no push.
test("a chat whose only gap is a stuck step is pushed with its step ids, and a blocked step names the step it waits for", () => {
  const ci = { v: 2, rev: 1, updatedAt: "2026-10-24T00:40:00Z", todos: [], plan: [
    { id: "p360", text: "Git rules hold", status: "doing", note: "Done when 0", children: [
      { id: "p361", text: "Verify the hook on the next land", status: "blocked", waitFor: "p368's land", children: [] },
      { id: "p368", text: "Land the hook", status: "doing", job: "hook land", children: [] },
      { id: "p369", text: "Old step", status: "blocked", waitFor: "p370", children: [] },
      { id: "p370", text: "Done step", status: "done", children: [] }] }] } as unknown as ChatBoard;
  assert.equal(waitsOnStep(ci, "p361"), "p368");
  assert.equal(waitsOnStep(ci, "p368"), undefined);
  assert.equal(waitsOnStep(ci, "p369"), undefined);
  const stuck = [{ chat: "ci", id: "p361", text: "Verify the hook on the next land", waitsOn: "p368" }, { chat: "x", count: 2 }];
  const pushes = pushList({ idleGoals: [], stuck, stuckDuties: [], upkeep: [] });
  assert.deepEqual(pushes.map(entry => [entry.chat, entry.steps.map(step => step.id ?? step.count)]), [["ci", ["p361"]], ["x", [2]]]);
  const tag = "[d9 push 2026-10-24T00:49Z]";
  const [tell] = pushTells(pushes, tag);
  assert.match(tell!.text, /open steps nobody moves p361 "Verify the hook on the next land" \(blocked on p368, so it can name p368's live job\)\./);
  assert.match(tell!.text, /each open step nobody moves a live job, a For you todo or a close/);
  assert.deepEqual(pushRecords(pushes, tag, 0).map(line => line.items), [["p361"], []]);
  const goal = { id: "p361", text: "x", status: "doing", children: [] } as unknown as ChatBoard["plan"][number];
  assert.deepEqual(pushList({ idleGoals: [{ chat: "ci", goals: [goal] }], stuck, stuckDuties: [], upkeep: [] })[0]!.steps, []);
  const out = chatSystemOutput({ names: new Map(), stuck, upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [], followUps: [], detail: "/tmp/d.md" });
  assert.match(out.flagged!.find(slice => slice.kind === "push")!.excerpt, /^2 chats have .*an open step nobody moves/);
});

test("a push to a chat whose box is offline reads as queued and asks for no second send, while a push that reached a live chat still gets a followup", () => {
  const push = (chat: string) => ({ at: 1, chat, tag: "[d9 push 2026-10-24T11:25Z]", items: ["p333"] });
  const out = chatSystemOutput({ names: new Map([["fe", "frontend bro"], ["api", "api portal vp"]]), stuck: [], upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [],
    idleGoals: [], detail: "/tmp/d9.md", followUps: [
      { push: push("fe"), delivered: false, read: false, jobStarted: false, away: "mac" },
      { push: push("api"), delivered: true, read: false, jobStarted: false }] });
  assert.deepEqual(out.flagged!.filter(slice => slice.kind === "push_queued").map(slice => slice.chat), ["fe"]);
  assert.match(out.flagged!.find(slice => slice.kind === "push_queued")!.excerpt, /runs on mac, which Tailscale reads offline/);
  assert.deepEqual(out.flagged!.filter(slice => slice.kind === "push_followup").map(slice => slice.chat), ["api"]);
});

test("a push whose named steps all closed since owes no followup, while one with a step still open does", () => {
  const board = { plan: [{ id: "p450", text: "cpu", status: "doing", children: [{ id: "p475", text: "dup", status: "dropped", children: [] }] }], todos: [] } as unknown as ChatBoard;
  assert.equal(pushSettled(board, ["p475"]), true);
  assert.equal(pushSettled(board, ["p475", "p450"]), false);
  assert.equal(pushSettled(board, []), false);
  assert.equal(pushSettled(board, ["p999"]), false);
  const push = { at: 1, chat: "ops", tag: "[d9 push 2026-10-24T13:27Z]", items: ["p475"] };
  const out = chatSystemOutput({ names: new Map([["ops", "ops guy"]]), stuck: [], upkeep: [], fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [], detail: "/tmp/d9.md",
    followUps: [{ push, delivered: true, read: true, jobStarted: false, settled: true }] });
  assert.equal(out.flagged!.filter(slice => slice.kind === "push_followup").length, 0);
});

test("a push whose named step waits only on an open For you todo owes no followup, and owes one again once the todo closes", () => {
  const todo = { id: "t34", text: "Where should /ci's growth go?", done: false, from: "agent", at: "2026-10-24T09:30:46Z" };
  const step = { id: "p518", text: "Fix: /ci fills within 30 days", status: "blocked", duty: "d2/risks_firing", waitFor: "the owner answers t34", children: [] };
  assert.equal(pushSettled({ plan: [step], todos: [todo] } as unknown as ChatBoard, ["p518"]), true);
  assert.equal(pushSettled({ plan: [step], todos: [{ ...todo, done: true }] } as unknown as ChatBoard, ["p518"]), false);
  assert.equal(pushSettled({ plan: [{ ...step, waitFor: "the next cut" }], todos: [todo] } as unknown as ChatBoard, ["p518"]), false);
});

// From 10-24 to 10-26 d9 pushed frontend bro 6 times while every turn of it failed on its Manual pi-pool account's 429.
const turn = (at: string, failed: boolean) => JSON.stringify({ type: "message", timestamp: at, message: { role: "assistant", provider: "anthropic",
  ...failed ? { stopReason: "error", errorMessage: "Provider rate limit exceeded (rate_limit_error, 429). pi-pool: Manual f6cee98e-a8df remains selected." } : { stopReason: "stop" } } });

test("a chat whose every turn since its last good one failed reads as down from that first failure, and a recent failure or a good turn does not", () => {
  const now = Date.parse("2026-10-26T03:40:00Z");
  const lines = [turn("2026-10-23T08:50:00Z", false), turn("2026-10-23T09:12:00Z", true), turn("2026-10-25T08:20:00Z", true), turn("2026-10-26T03:28:00Z", true)];
  assert.deepEqual(failingTurns(lines, now), { since: Date.parse("2026-10-23T09:12:00Z"), turns: 3, provider: "anthropic",
    error: "Provider rate limit exceeded (rate_limit_error, 429). pi-pool: Manual f6cee98e-a8df remains selected." });
  assert.equal(failingTurns([...lines, turn("2026-10-26T03:30:00Z", false)], now), undefined);
  assert.equal(failingTurns([turn("2026-10-26T03:28:00Z", true)], now), undefined);
  const who = { providers: { anthropic: { selection: { mode: "manual", account_id: "f6cee98e" }, current: { email: "claude8@slack.green" }, wait: { slot_at: 1793239201 } } } };
  assert.equal(manualSelection(who, "anthropic"), "Manual claude8@slack.green, whose pi-pool slot comes at 2026-10-29T02:00Z");
  assert.equal(manualSelection({ providers: { anthropic: { selection: { mode: "auto" } } } }, "anthropic"), undefined);
});

test("a push answered only by a failed turn is not read", () => {
  const tag = "[d9 push 2026-10-26T03:27Z]";
  const sent = JSON.stringify({ type: "message", message: { role: "user", content: `${tag} The chat system duty (d9) found these` } });
  assert.deepEqual(pushReached([sent, turn("2026-10-26T03:28:00Z", true)], tag), { delivered: true, read: false });
});

test("a down chat opens the flagged slices with its chat_down line, and gets no push and no follow-up", () => {
  const push = { at: 1, chat: "fb", tag: "[d9 push 2026-10-26T03:27Z]", items: ["p330"] };
  const out = chatSystemOutput({ names: new Map([["fb", "frontend bro"]]), stuck: [{ chat: "fb", id: "p330", text: "Ship the inbox" }], upkeep: [],
    fleet: { pct: 100, red: [] }, stuckDuties: [], idleGoals: [], detail: "/tmp/d9.md",
    followUps: [{ push, delivered: true, read: false, jobStarted: false }],
    down: [{ chat: "fb", since: Date.parse("2026-10-23T09:12:00Z"), turns: 41, cause: "rate limit 429, Manual claude8@slack.green, whose pi-pool slot comes at 2026-10-29T02:00Z" }] });
  assert.equal(out.flagged![0]!.kind, "chat_down");
  assert.match(out.flagged![0]!.excerpt, /^chat_down: frontend bro has failed every turn since 2026-10-23T09:12Z \(rate limit 429, Manual claude8@slack\.green, .*\), 41 failed turns; d9 sent it no push this run\./);
  assert.deepEqual(out.flagged!.filter(slice => slice.kind === "push" || slice.kind === "push_followup"), []);
  assert.equal(out.metrics!.stuck_steps_all, 1);
});
