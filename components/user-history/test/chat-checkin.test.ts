import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activePause, changeCheckIn, chatCheckIn, checkInLine, checkInSettings, clockTime, localTime, nextCheckIn, OWNER_UI, parseChatCheckIn, pauseEnd,
  validCheckInEvery } from "../src/checkin-settings.ts";
import { type CheckInMemory, checkInPrecheck, type CheckInPrecheck, checkInPrecheckText, checkInRecord, convergenceMisses, endedWithoutReport, jobEnd, jobEndText,
  jobEndWords, lastJobMessages, looksDone, retryDue, TOLD_END_KEEP_MS } from "../src/chat-checkin.ts";
import { CHASE_ESCALATE_MS, checkInDue, classLine, type JobFact, jobFacts, readySteps, STEP_STALE_MS, stepClass, stepOwner, todoForStep, waitsOnOwner, waitTarget } from "../src/checkin-steps.ts";
import { idleGoals } from "../src/checkin-findings.ts";
import { applyBoardOp, emptyBoard, nextIds, renderOpenPlan } from "../src/shared/chat-board.ts";
import { chatLines, turnStarter } from "../src/shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, OwnerTodo, PlanItem, PlanStatus, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[], todos: ChatBoard["todos"] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos, plan });
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });

/** The class lines of a precheck's steps (`classLine`), board order. */
const actLines = (precheck: CheckInPrecheck, now: number): string[] => precheck.steps.flatMap(view => { const line = classLine(view, now); return line ? [line] : []; });
/** Each open step as "id (class)". */
const classes = (precheck: CheckInPrecheck): string[] => precheck.steps.map(view => `${view.item.id} (${view.cls})`);
/** The precheck text's list under one heading. */
const section = (text: string, head: string): string[] => text.split(`### ${head}\n`)[1]?.split("\n\n")[0]!.split("\n").map(line => line.slice(2)) ?? [];

test("job facts: direct subagents, a plan link to a subagent or to another thread by name or id; nested subagents and unknown links are left out; a cancelled job ended", () => {
  const children: ChildAgent[] = [
    { id: "k1", parentId: "chat", label: "a", sessionName: "api-audit", status: "running", lastActivityAt: 5, repliedSinceTask: false },
    { id: "k2", parentId: "k1", label: "nested", status: "running" },
    { id: "k3", parentId: "chat", label: "docs", status: "done", activity: { kind: "waiting" } },
    { id: "k4", parentId: "chat", label: "broken", status: "error", error: "model failed" },
    { id: "k5", parentId: "chat", label: "removed", status: "cancelled", error: "Deleted by parent orchestrator" },
  ];
  const plan = board([step("p1", "Reach chats from Slack", "doing", { children: [
    step("p2", "Plan", "doing", { job: "api-audit" }), step("p3", "Build", "doing", { job: "slack-bridge" }), step("p4", "Verify", "todo", { job: "s-9" }),
    step("p5", "Ghost", "todo", { job: "nobody" })] })]);
  const facts = jobFacts(children, plan, [row("s-1", "slack-bridge", { working: true, lastActivityAt: "2026-10-07T10:00:00Z" }), row("s-9", "verify-run", { failure: "429 rate limited" })]);
  assert.deepEqual(facts, [
    { key: "k1", name: "api-audit", state: "working", activityAt: 5, replied: false, item: { id: "p2", text: "Plan", status: "doing" } },
    { key: "k3", name: "docs", state: "working" },
    { key: "k4", name: "broken", state: "failed", error: "model failed" },
    { key: "k5", name: "removed", state: "ended", cancelled: true, error: "Deleted by parent orchestrator" },
    { key: "thread:s-1", name: "slack-bridge", state: "working", activityAt: Date.parse("2026-10-07T10:00:00Z"), messages: 1, item: { id: "p3", text: "Build", status: "doing" } },
    { key: "thread:s-9", name: "verify-run", state: "failed", error: "429 rate limited", messages: 1, item: { id: "p4", text: "Verify", status: "todo" } },
  ]);
});

test("check-in due: a job at work or an open plan step; ready steps wait for every earlier step under an open goal", () => {
  const working: JobFact = { key: "k", name: "a", state: "working" };
  assert.equal(checkInDue([working], null), true);
  assert.equal(checkInDue([{ ...working, state: "ended" }], null), false);
  assert.equal(checkInDue([], board([step("p1", "g", "done", { children: [step("p2", "s", "blocked")] })])), true, "a blocked step is open");
  assert.equal(checkInDue([], board([step("p1", "g", "done", { children: [step("p2", "s", "dropped")] })])), false);
  const plan = board([
    step("p1", "Goal", "doing", { children: [step("p2", "Plan", "done"), step("p3", "Decide", "dropped"), step("p4", "Build", "todo"), step("p5", "Verify", "todo")] }),
    step("p6", "Other", "doing", { children: [step("p7", "Plan", "doing", { job: "x" }), step("p8", "Build", "todo")] }),
    step("p9", "Done goal", "done", { children: [step("p10", "Left", "todo")] }),
    step("p11", "Linked", "todo", { children: [step("p12", "Plan", "todo", { job: "y" })] }),
  ]);
  assert.deepEqual(readySteps(plan).map(item => item.id), ["p4"], "after done and dropped steps, not after a doing one, not under a done goal, not one with a job");
});

test("step owner: a job name, a session id, thread:<id> (with or without @ms), else a thread link in the note; the reducer stores the bare form", () => {
  const id = "01a11649-95f3-77fc-b0e4-19717b002df5";
  assert.equal(stepOwner(step("p1", "a", "doing", { job: "api-audit" })), "api-audit");
  assert.equal(stepOwner(step("p1", "a", "doing", { job: id })), id);
  assert.equal(stepOwner(step("p1", "a", "doing", { job: `thread:${id}` })), id, "an old value written before the reducer normalized");
  assert.equal(stepOwner(step("p1", "a", "doing", { job: `thread:${id}@1791389368584` })), id);
  assert.equal(stepOwner(step("p1", "a", "doing", { note: `Asked the favicon thread (thread:${id}) to commit` })), id);
  assert.equal(stepOwner(step("p1", "a", "doing", { job: "usage backend", note: `thread:${id}` })), "usage backend", "the job wins over the note");
  assert.equal(stepOwner(step("p1", "a", "doing", { note: "W11 runs it" })), undefined);

  let board = emptyBoard("t0");
  const apply = (op: Parameters<typeof applyBoardOp>[1]) => { board = applyBoardOp(board, op, "agent", "t1", nextIds(board)).board; };
  apply({ op: "plan_add", text: "Favicon", job: `thread:${id}@5` });
  apply({ op: "plan_add", text: "Usage", job: `http://localhost:5182/#${id}` });
  apply({ op: "plan_add", text: "Audit", job: "job:api-audit" });
  apply({ op: "plan_add", text: "Old", job: id });
  apply({ op: "plan_set", items: [...board.plan, { text: "Docs", job: `  thread:${id}  ` }] });
  apply({ op: "plan_update", id: "p3", job: "usage backend" });
  assert.deepEqual(board.plan.map(item => item.job), [id, id, "usage backend", id, id]);
});

test("job facts: a thread an open step names by thread: link or note is watched with its message count; a closed step's thread is not", () => {
  const rows = [row("s-1", "usage backend", { messageCount: 40, lastActivityAt: "2026-10-07T10:00:00Z" }), row("s-2", "favicon", { working: true, messageCount: 7 }),
    row("s-3", "old audit", { messageCount: 3 })];
  const plan = board([step("p1", "Goal", "doing", { children: [
    step("p2", "Usage API", "doing", { job: "thread:s-1" }), step("p3", "Favicon", "doing", { note: "asked thread:s-2 to commit" }),
    step("p4", "Audit", "done", { job: "s-3" })] })]);
  assert.deepEqual(jobFacts([], plan, rows), [
    { key: "thread:s-1", name: "usage backend", state: "ended", activityAt: Date.parse("2026-10-07T10:00:00Z"), messages: 40, item: { id: "p2", text: "Usage API", status: "doing" } },
    { key: "thread:s-2", name: "favicon", state: "working", messages: 7, item: { id: "p3", text: "Favicon", status: "doing" } },
  ]);
});

test("step class: live, foryou, waiting, due, stale-chase and orphan, in that order of precedence", () => {
  const now = 100 * STEP_STALE_MS;
  const todos = [{ id: "t1", text: "Approve the Stripe price?" }];
  const cls = (item: PlanItem, extra: Partial<Parameters<typeof stepClass>[0]> = {}) => stepClass({ item, changedAt: now - 3 * STEP_STALE_MS, mine: false, openTodos: [], ...extra }, now);
  const job = (state: JobFact["state"], activityAt = now - 3 * STEP_STALE_MS): JobFact => ({ key: "k1", name: "api-audit", state, activityAt });
  const thread = (state: JobFact["state"], activityAt: number): JobFact => ({ key: "thread:s-1", name: "release owner", state, activityAt });
  assert.equal(cls(step("p1", "Build", "doing"), { owner: job("working") }), "live", "a job at work");
  assert.equal(cls(step("p1", "Build", "doing"), { owner: thread("ended", now - STEP_STALE_MS + MIN) }), "live", "a thread active in the last 2 h");
  assert.equal(cls(step("p1", "Build", "doing"), { mine: true, changedAt: now - MIN }), "live", "the chat's own step it changed in the last 2 h");
  assert.equal(cls(step("p1", "Stripe price", "blocked"), { openTodos: todos }), "foryou", "an open owner todo covers it");
  assert.equal(cls(step("p1", "Build", "blocked", { waitUntil: new Date(now + MIN).toISOString() })), "waiting");
  assert.equal(cls(step("p1", "Build", "blocked", { waitUntil: new Date(now - MIN).toISOString() }), { mine: true, changedAt: now - 30 * MIN }), "due",
    "a passed waitUntil the step has not changed since is due, even on the chat's own fresh step");
  assert.equal(cls(step("p1", "Build", "blocked", { waitUntil: new Date(now - 2 * STEP_STALE_MS).toISOString() }), { mine: true, changedAt: now - MIN }), "live",
    "a step changed after its time came was acted on");
  assert.equal(cls(step("p1", "Build", "blocked", { waitFor: "Promote 5" }), { changedAt: now - MIN }), "waiting", "a fresh waitFor");
  assert.equal(cls(step("p1", "Build", "blocked", { waitFor: "Promote 5" })), "stale-chase", "a waitFor with no progress for 2 h");
  assert.equal(cls(step("p1", "Build", "doing"), { owner: thread("ended", now - 3 * STEP_STALE_MS) }), "stale-chase", "an idle thread owner");
  assert.equal(cls(step("p1", "Build", "doing"), { owner: thread("failed", now - MIN), changedAt: now - MIN }), "waiting", "a failed thread is no live owner; its retries run apart");
  assert.equal(cls(step("p1", "Build", "doing"), { owner: job("ended", now - MIN), changedAt: now - MIN }), "orphan", "a job that ended leaves its step without a live owner");
  assert.equal(cls(step("p1", "Build", "doing")), "orphan", "no owner, no todo, no wait");
  assert.equal(cls(step("p1", "Build", "doing"), { mine: true }), "orphan", "the chat's own step, unmoved for 2 h");
});

test("check-in precheck: due, stale-chase and orphan steps keep their class line at every run until the chat acts; the open list shows each class", () => {
  const start = 100 * STEP_STALE_MS;
  const self = { self: ["c-self", "dev VP"] };
  const until = new Date(start + STEP_STALE_MS).toISOString();
  const plan = board([step("p1", "Goal", "doing", { children: [
    step("p7", "Check the load", "doing", { job: "c-self", waitUntil: until }), step("p9", "Revoke the old app", "blocked", { job: "c-self", waitFor: "Promote 5 green" }),
    step("p12", "Move the notices", "todo"), step("p13", "Done step", "done")] })]);
  const first = checkInPrecheck(undefined, [], plan, start, self);
  assert.deepEqual(actLines(first, start), ['p12 "Move the notices" has no live owner: start a job, take it yourself, or ask the owner in For you']);
  assert.deepEqual(classes(first), ["p7 (waiting)", "p9 (live)", "p12 (orphan)"]);
  const at = start + 2 * STEP_STALE_MS;
  const due = checkInPrecheck(first.memory, [], plan, at, self);
  assert.deepEqual(actLines(due, at), [`p7 "Check the load" is due since ${clockTime(Date.parse(until))}: act on it now (check whether what it waited for happened, then do the next action); the board refuses a later waitUntil (c47)`,
    'p9 "Revoke the old app" waits for "Promote 5 green" for 4 h: chase it now; after 24 h make it a For you todo or replan',
    'p12 "Move the notices" has no live owner: start a job, take it yourself, or ask the owner in For you']);
  assert.equal(actLines(checkInPrecheck(due.memory, [], plan, at + 15 * MIN, self), at + 15 * MIN).length, 3, "again at the next run");
  const day = start + CHASE_ESCALATE_MS;
  assert.ok(actLines(checkInPrecheck(due.memory, [], plan, day, self), day).includes('p9 "Revoke the old app" waits for "Promote 5 green" for 24 h: make it a For you todo or replan it now'));
  const acted = board([step("p1", "Goal", "doing", { children: [
    step("p7", "Check the load", "done", { job: "c-self" }), step("p9", "Revoke the old app", "blocked", { job: "c-self", waitFor: "Promote 5 green" }),
    step("p12", "Move the notices", "doing", { job: "notices" }), step("p13", "Done step", "done")] }),
    ], [{ id: "t1", text: "p9: revoke the old app now?", done: false, from: "agent", at: "", choices: ["Yes", "Wait"] }]);
  const notices: JobFact = { key: "k5", name: "notices", state: "working", activityAt: at + 20 * MIN };
  const calm = checkInPrecheck(due.memory, [notices], acted, at + 20 * MIN, self);
  assert.deepEqual(actLines(calm, at + 20 * MIN), [], "a For you todo, a live job and a closed step need nothing");
  assert.deepEqual(classes(calm), ["p9 (foryou)", "p12 (live)"]);
});

test("check-in precheck: a stale chase names the thread its waitFor names, never the chat itself or an archived thread", () => {
  const start = 100 * STEP_STALE_MS;
  const context = { self: ["c-self", "dev VP"], rows: [row("s-rel", "release owner"), row("c-self", "dev VP"), row("s-old", "release owner old", { archived: true })] };
  const plan = board([step("p1", "Goal", "doing", { children: [step("p9", "Revoke the old app", "blocked", { job: "c-self", waitFor: "the release owner's Promote 5 sha" }),
    step("p10", "Ship", "blocked", { job: "c-self", waitFor: "a real Claude outage" })] })]);
  const first = checkInPrecheck(undefined, [], plan, start, context);
  const at = start + 20 * 60 * MIN;
  const stale = checkInPrecheck(first.memory, [], plan, at, context);
  assert.deepEqual(stale.steps.map(view => view.target?.id), ["s-rel", undefined], "only a wait that names a thread has one");
  assert.ok(checkInPrecheckText(stale, [], [], at).includes(`- p9 "Revoke the old app" waits for "the release owner's Promote 5 sha" for 20 h: chase it now; after 24 h make it a For you todo ` +
    "or replan (the thread to chase: release owner, thread:s-rel)"));
  assert.equal(waitTarget("thread:s-rel says so", context.rows, new Set(context.self))?.id, "s-rel");
  assert.equal(waitTarget("dev VP decides", context.rows, new Set(context.self)), undefined, "never the chat itself");
  assert.equal(waitTarget("the release owner old one", context.rows, new Set(context.self))?.id, "s-rel", "an archived thread is never the target");
});

test("check-in precheck: a note-only edit is no change, a step the chat owns is the chat's, only leaf steps are listed, at most 30, with the jobs", () => {
  const now = 10 * STEP_STALE_MS;
  const self = { self: ["c-self", "chat-6394"] };
  const plan = (note: string) => board([step("p1", "Goal", "doing", { children: [
    step("p2", "Build", "doing", { job: "fixer", note }), step("p3", "Verify", "todo", { job: "chat-6394" }), step("p4", "Docs", "doing", { job: "thread:c-self" })] })]);
  const fixer: JobFact = { key: "k1", name: "fixer", state: "working", activityAt: now, item: { id: "p2", text: "Build", status: "doing" } };
  const first = checkInPrecheck(undefined, [fixer], plan("started"), now, self);
  const later = now + 30 * MIN;
  const ended: JobFact = { ...fixer, state: "ended", activityAt: later, lastMessage: { at: later, text: "Fixed in 4f1c2a." } };
  const run = checkInPrecheck(first.memory, [ended], plan("chased the owner again"), later, self);
  assert.equal(run.memory.steps.p2!.at, now, "a note edit is no change");
  const text = checkInPrecheckText(run, [ended], [], later);
  assert.deepEqual(section(text, "Every open step, oldest change first"), ['p2 (orphan) "Build" doing, owner job fixer (idle), last change 30 min ago; note: "chased the owner again"',
    'p3 (live) "Verify" todo, owner the chat, last change 30 min ago', 'p4 (live) "Docs" doing, owner the chat, last change 30 min ago'], "no goal line");
  assert.deepEqual(section(text, "Jobs"), [`job fixer: idle, last activity 0 min ago, on p2 "Build" (doing), last message at ${clockTime(later)}: "Fixed in 4f1c2a."`]);
  const quiet = checkInPrecheckText(run, [{ ...fixer, activityAt: now - 40 * MIN }], [], later);
  assert.deepEqual(section(quiet, "Jobs"), ['job fixer: working, no activity for 70 min, on p2 "Build" (doing)']);
  const rows = [row("c-self", "chat-6394", { working: true }), row("s-2", "other", { working: true })];
  const own = board([step("p1", "Goal", "doing", { children: [step("p3", "Verify", "todo", { job: "chat-6394" }), step("p5", "Ask", "doing", { job: "other" })] })]);
  assert.deepEqual(jobFacts([], own, rows, "c-self").map(fact => fact.key), ["thread:s-2"], "the chat's own row is no job");
  const many = board(Array.from({ length: 35 }, (_, index) => step(`p${index + 1}`, `Step ${index + 1}`, "todo")));
  const listed = section(checkInPrecheckText(checkInPrecheck(undefined, [], many, now), [], [], now), "Every open step, oldest change first");
  assert.equal(listed.length, 30);
  assert.equal(listed[29], "and 6 more");
  assert.equal(checkInPrecheckText(checkInPrecheck(undefined, [], board([]), now), [], [], now), "The board has no open step and no job.");
});

test("check-in precheck: a board read error, an ask overflow, steps that can start, and owner waits with no question are facts; the error keeps the steps", () => {
  const now = 10 * STEP_STALE_MS;
  const asks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, text: `ask ${index + 1}`, done: false, from: "agent" as const, at: "" }));
  const plan = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "doing")] })], asks(3));
  const first = checkInPrecheck(undefined, [], plan, now);
  assert.deepEqual(first.facts, [], "3 open asks is the limit, not past it");
  const broken = checkInPrecheck(first.memory, [], null, now + MIN, { boardError: "Chat board file is malformed." });
  assert.deepEqual(broken.facts, ["the board cannot be read: Chat board file is malformed."]);
  assert.deepEqual(Object.keys(broken.memory.steps), ["p2", "p1"], "the steps stay for when the board reads again");
  assert.deepEqual(broken.steps, []);
  const fixed = checkInPrecheck(broken.memory, [], plan, now + 40 * MIN);
  assert.equal(fixed.memory.steps.p2!.at, first.memory.steps.p2!.at, "the board reads again: no step looks new");
  const nine = board(plan.plan, [...asks(9), { id: "t10", text: "done one", done: true, from: "agent", at: "" }, { id: "t11", text: "mine", done: false, from: "owner", at: "" }]);
  assert.deepEqual(checkInPrecheck(fixed.memory, [], nine, now).facts, ["9 open owner todos; the limit is 3"], "the agent's open asks only");
  assert.equal(checkInDue([], board([], asks(4))), true, "an ask overflow wakes a chat with no open step");
  assert.equal(checkInDue([], board([], asks(3))), false);
  assert.equal(checkInDue([], null, "Chat board file is malformed."), true, "so does a board it cannot read");
  const ready = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "done"), step("p3", "Build", "todo")] })]);
  assert.deepEqual(checkInPrecheck(undefined, [], ready, now).facts, ['p3 "Build" can start: the steps before it are done and it has no job']);
  const waits = board([step("p1", "Goal", "doing", { children: [step("p2", "Decide the Stripe endpoint", "blocked", { job: "c-self", note: "Waits on the owner adding the endpoint" })] })]);
  assert.deepEqual(checkInPrecheck(undefined, [], waits, now, { self: ["c-self"] }).facts, ['p2 "Decide the Stripe endpoint" waits on the owner but For you has no question for it']);
  const withAsk = { ...waits, todos: [{ id: "t1", text: "Add the Clerk endpoint now?", choices: ["Yes", "Later"], done: false, from: "agent" as const, at: "" }] };
  assert.deepEqual(checkInPrecheck(undefined, [], withAsk, now, { self: ["c-self"] }).facts, [], "an open ask that shares a word (endpoint) with the step covers it");
  assert.equal(todoForStep({ id: "p9", text: "Sign in to Stripe" }, [{ text: "Approve the deploy?" }]), false);
  const t22 = [{ id: "t22", text: "ProxyCo failed twice in 40 min this morning and the job paused itself. Can I send ProxyCo support this note?" }];
  assert.equal(todoForStep({ id: "p92", text: "Fix: survey jobs failed on the ProxyCo gateway", status: "doing" }, t22), false,
    "a step at work is not covered by a shared word (a crawler thread 10-12, p92)");
  assert.equal(todoForStep({ id: "p92", text: "Fix: survey jobs failed on the ProxyCo gateway", status: "blocked" }, t22), true, "a blocked step still is");
  assert.equal(todoForStep({ id: "p92", text: "Fix", status: "doing" }, [{ id: "t30", text: "Go?", step: "p92" }]), true, "a todo linked to the step covers it");
  assert.equal(todoForStep({ id: "p14", text: "Build: move callers over", waitFor: "owner approves the page in For you (todo t8)" }, [{ id: "t8", text: "The revised page is ready. Approve it?" }]), true,
    "a step whose wait names the todo id is covered by that todo");
  assert.equal(waitsOnOwner(step("p9", "Build", "blocked")), false, "blocked alone is the board shape, not an owner wait");
  assert.equal(waitsOnOwner(step("p9", "Build", "blocked", { note: "waits on the owner's choice: A or B" })), true);
});

test("check-in precheck: an item that looks done is listed for a check, and an orphan that looks done gets no orphan line", () => {
  const now = 100 * STEP_STALE_MS;
  const plan = board([step("p1", "Usage panel", "doing", { note: "Shipped on 10-08, live on production", children: [step("p2", "Land", "doing", { note: "deployed to production" })] })]);
  const run = checkInPrecheck(undefined, [], plan, now);
  const text = checkInPrecheckText(run, [], [], now);
  assert.deepEqual(section(text, "Look done (check the real state: close, keep or reopen)"), ['p2 "Land" doing, looks done: its note says "deployed"'],
    "p1 has open p2 under it, so its own note does not make it look done until p2 closes");
  assert.deepEqual(section(text, "Steps whose class needs action"), [], "the orphan p2 needs a check and a close, not a new job");
  assert.deepEqual(idleGoals(run.steps), [], "a goal whose open steps look done is not idle");
});

test("idle goals: a goal with an open step nobody owns and no live job is idle; one with a live job, or only waiting and For you steps, is not", () => {
  const now = 100 * STEP_STALE_MS;
  const working: JobFact = { key: "k1", name: "crawler", state: "working", activityAt: now };
  const plan = board([
    step("p1", "Index catalog A", "doing", { children: [step("p2", "Plan", "done"), step("p3", "Build the crawler", "todo"), step("p4", "Verify", "todo", { waitFor: "p3 lands" })] }),
    step("p10", "Index catalog B", "doing", { children: [step("p11", "Build", "doing", { job: "crawler" }), step("p12", "Docs", "todo")] }),
    step("p20", "Index catalog C", "doing", { children: [step("p21", "Decide the region", "blocked", { note: "waits on the owner's choice" }),
      step("p22", "Build", "todo", { waitUntil: new Date(now + STEP_STALE_MS).toISOString() })] }),
  ], [{ id: "t1", text: "p21: which region?", done: false, from: "agent", at: "", choices: ["US", "KR"] }]);
  const run = checkInPrecheck(undefined, [working], plan, now);
  const idle = idleGoals(run.steps);
  assert.deepEqual(idle.map(entry => [entry.goal.id, entry.steps.map(view => view.item.id)]), [["p1", ["p3"]]],
    "p10 has a live job; p20 has only a For you step and a wait");
  const output = convergenceMisses("c1", run.steps, run, {}, 15 * MIN, now);
  assert.equal(output.metrics.idle_goals, 1);
  const slice = output.flagged.find(entry => entry.kind === "idle_goals")!;
  assert.deepEqual(slice, { chat: "c1", at: now, kind: "idle_goals", item: "p1",
    excerpt: 'p1 "Index catalog A" has no live job and 1 open step nobody owns (p3): start jobs for its independent work now, in parallel' });
  assert.deepEqual(section(checkInPrecheckText(run, [working], output.flagged, now), "Goals nobody works on (start parallel jobs for their independent work)"), [slice.excerpt]);
  const single = board([step("p30", "Write the runbook", "todo")]);
  assert.deepEqual(idleGoals(checkInPrecheck(undefined, [], single, now).steps).map(entry => entry.goal.id), ["p30"], "a top-level step with nobody on it is its own idle goal");
});

test("ended without report: a follow-up task that ends while the reply flag is false; a first task, a report, an unknown flag do not", () => {
  const base: ChildAgent = { id: "k1", label: "a", status: "done" };
  const busy = { ...base, activity: { kind: "writing" as const } };
  assert.deepEqual(endedWithoutReport([busy], [{ ...base, repliedSinceTask: false }]).map(child => child.id), ["k1"]);
  assert.deepEqual(endedWithoutReport([busy], [{ ...base, repliedSinceTask: true }]), []);
  assert.deepEqual(endedWithoutReport([busy], [base]), []);
  assert.deepEqual(endedWithoutReport([{ ...base, status: "running" }], [{ ...base, repliedSinceTask: false }]), [], "the first task: the daemon's notice");
  assert.deepEqual(endedWithoutReport([base], [{ ...base, repliedSinceTask: false }]), [], "already ended");
  assert.deepEqual(endedWithoutReport([], [{ ...base, repliedSinceTask: false }]), [], "not seen before");
});

test("check-in record keeps one memory per chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-in-"));
  const record = checkInRecord(join(dir, "check-ins.json"));
  const memory: CheckInMemory = { at: 5, steps: { p1: { sig: "x", at: 3 } } };
  assert.equal(await record.get("c1"), undefined);
  await record.set("c1", memory);
  assert.deepEqual(await record.get("c1"), memory);
  await record.forget("c1");
  assert.equal(await record.get("c1"), undefined);
  await record.set("c2", { at: 5, jobs: {}, answered: [], ready: [], steps: { p1: { sig: "x", at: 3, chased: 4 }, p2: { at: 1 } } } as unknown as CheckInMemory);
  assert.deepEqual(await record.get("c2"), { at: 5, steps: { p1: { sig: "x", at: 3 } } }, "an older memory reads as its step changes only");
});

test("feed: a [check-in] or [job] line from the server folds into updates and starts an agent turn, so the chat's text stays a note", () => {
  const messages: ThreadMessage[] = [
    { role: "user", content: "[check-in] What changed:\n- job api-audit finished", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Board updated." }], provider: "p", model: "m", stopReason: "stop", timestamp: 2 },
    { role: "user", content: "[job] api-audit ended with no report", timestamp: 3 },
  ];
  const lines = chatLines(messages);
  assert.deepEqual(lines.map(line => [line.kind, "from" in line ? line.from : ""]), [["job", "check-in"], ["notes", ""], ["job", "jobs"]]);
  const first = lines[0];
  assert.equal(first?.kind === "job" && first.title, "What changed:");
  assert.equal(turnStarter(messages), "agent");
  assert.equal(turnStarter([...messages, { role: "user", content: "what's up?", timestamp: 4 }]), "owner");
});

test("check-in setting: the interval range, the pause ends, the next run, the board line, and the file", async () => {
  for (const minutes of [1, 5, 15, 30, 60, 240, 7]) assert.equal(validCheckInEvery(minutes * 60_000), true, `${minutes} min`);
  for (const ms of [0, 30_000, 241 * 60_000, 90_000, Number.NaN, "300000"]) assert.equal(validCheckInEvery(ms), false, String(ms));
  const now = new Date(2026, 9, 8, 14, 30).getTime();
  assert.equal(pauseEnd("1h", now), now + 3_600_000);
  assert.equal(pauseEnd("tomorrow", now), new Date(2026, 9, 9, 9, 0).getTime());
  assert.equal(pauseEnd("tomorrow", new Date(2026, 9, 8, 2, 0).getTime()), new Date(2026, 9, 8, 9, 0).getTime(), "before 09:00 it ends this morning");
  assert.equal(pauseEnd("forever", now), "forever");

  const every5 = { everyMs: 5 * 60_000 };
  assert.equal(nextCheckIn(every5, now - 60_000, now), now + 4 * 60_000);
  assert.equal(nextCheckIn({ ...every5, pausedUntil: "forever" }, now - 60_000, now), null);
  assert.equal(nextCheckIn({ ...every5, pausedUntil: now + 3_600_000 }, now - 60 * 60_000, now), now + 3_600_000, "not before the pause ends");
  assert.equal(nextCheckIn({ ...every5, pausedUntil: now - 1 }, now - 10 * 60_000, now), now - 5 * 60_000, "an expired pause is no pause");
  assert.equal(activePause({ ...every5, pausedUntil: now - 1 }, now), null);

  assert.equal(checkInLine(every5, now), "Check-in: every 5 min");
  assert.equal(checkInLine({ everyMs: 60 * 60_000, pausedUntil: new Date(2026, 9, 9, 9, 0).getTime() }, now), "Check-in: paused until 2026-10-09 09:00");
  assert.equal(checkInLine({ ...every5, pausedUntil: "forever" }, now), "Check-in: paused until the owner resumes it");
  assert.equal(checkInLine({ ...every5, pausedUntil: now - 1 }, now), "Check-in: every 5 min");
  assert.equal(renderOpenPlan(null, "s-1", "Check-in: every 5 min").split("\n").join("|"), "This chat: thread:s-1|Check-in: every 5 min|The board is empty: no plan, no todos.");

  const path = join(await mkdtemp(join(tmpdir(), "check-in-settings-")), "check-in-settings.json");
  const settings = checkInSettings(path);
  assert.deepEqual(await settings.get("c1"), { everyMs: 120 * 60_000 }, "default 120 min");
  await settings.update("c1", setting => ({ ...setting, everyMs: 15 * 60_000, pausedUntil: "forever" }));
  assert.deepEqual(await checkInSettings(path).get("c1"), { everyMs: 15 * 60_000, pausedUntil: "forever" });
  assert.deepEqual(await checkInSettings(path).all(), { c1: { everyMs: 15 * 60_000, pausedUntil: "forever" } });
});

const MIN = 60_000;
const reply = (stopReason: "stop" | "error" | "aborted" | "toolUse", timestamp: number, errorMessage?: string): ThreadMessage =>
  ({ role: "assistant", content: [], provider: "p", model: "m", stopReason, timestamp, ...(errorMessage ? { errorMessage } : {}) });

test("retry schedule: 5, 10, then every 20 min", () => {
  assert.deepEqual([retryDue(0, 0, 5 * MIN - 1), retryDue(0, 0, 5 * MIN), retryDue(1, 0, 10 * MIN - 1), retryDue(1, 0, 10 * MIN), retryDue(2, 0, 20 * MIN), retryDue(7, 0, 20 * MIN)],
    [false, true, false, true, true, true], "5 min, then 10, then every 20");
});

test("waits on the owner: only a blocked step whose note says it waits on the owner's choice, and not when that ask was answered", () => {
  const now = 50 * STEP_STALE_MS;
  const wait = (id: string, status: PlanItem["status"], note: string) => step(id, "Delete the old route", status, { note });
  const plan = board([step("p1", "Goal", "doing", { children: [
    wait("p45", "blocked", "waits on land 25 reaching staging"),
    wait("p49", "blocked", "the owner answered: delete after land 25 is live"),
    wait("p112", "doing", "needs the owner's go"),
    wait("p50", "blocked", "waits on the owner's approval of the price"),
    wait("p51", "blocked", "needs your go before the deploy"),
  ] })]);
  const lines = checkInPrecheck(undefined, [], { ...plan, todos: [] }, now).facts.filter(line => line.includes("For you has no question"));
  assert.deepEqual(lines.map(line => line.split(" ")[0]), ["p50", "p51"], "a land wait, a note naming the owner, and a doing step are not owner waits");
  const answered = { ...plan, todos: [{ id: "t12", text: "p50: approve the price?", done: true, reply: "yes", from: "agent" as const, at: "" }] };
  const after = checkInPrecheck(undefined, [], answered, now).facts.filter(line => line.includes("For you has no question"));
  assert.deepEqual(after.map(line => line.split(" ")[0]), ["p51"], "an answered ask for the step counts");
});

test("chat check_in: the chat pauses itself for 1h or until 09:00, resumes its own pause, sets its interval; an owner pause stays; the owner's later choice wins", async () => {
  const settings = checkInSettings(join(await mkdtemp(join(tmpdir(), "check-in-")), "check-in-settings.json"));
  const now = new Date(2026, 9, 8, 14, 0).getTime();
  assert.deepEqual(parseChatCheckIn({ pause: "1h" }), { pause: "1h" });
  assert.deepEqual(parseChatCheckIn({ pause: null, every_minutes: 30 }), { pause: null, everyMs: 30 * 60_000 });
  for (const bad of [{ pause: "forever" }, { every_minutes: 0 }, { every_minutes: 2.5 }, {}, "1h"]) assert.throws(() => parseChatCheckIn(bad), /check_in/);
  assert.equal(await chatCheckIn(settings, "c1", { pause: "tomorrow" }, now), "The chat set its check-in: paused until 2026-10-09 09:00");
  assert.deepEqual(await settings.get("c1"), { everyMs: 120 * 60_000, pausedUntil: new Date(2026, 9, 9, 9, 0).getTime(), pausedBy: "agent", setter: "c1" });
  assert.equal(await chatCheckIn(settings, "c1", { pause: null }, now + 60_000), "The chat set its check-in: resumed, every 120 min");
  assert.equal(await chatCheckIn(settings, "c1", { everyMs: 180 * 60_000 }, now + 120_000), "The chat set its check-in: every 180 min");
  assert.equal(await chatCheckIn(settings, "c1", { pause: "1h" }, now + 180_000), "The chat set its check-in: paused until 2026-10-08 15:03");

  const owner = (change: Parameters<typeof changeCheckIn>[1], at: number) => settings.update("c1", current => { const result = changeCheckIn(current, change, at, OWNER_UI); return "setting" in result ? result.setting : current; });
  assert.deepEqual(await owner({ pause: null }, now + 240_000), { everyMs: 180 * 60_000 }, "the owner's later choice wins over the chat's pause");
  await owner({ pause: "forever" }, now + 300_000);
  await assert.rejects(chatCheckIn(settings, "c1", { pause: null }, now + 360_000), /check_in refused: the owner paused check-ins until they resume them; that stays/);
  await assert.rejects(chatCheckIn(settings, "c1", { pause: "1h" }, now + 360_000), /that stays/);
  assert.equal(await chatCheckIn(settings, "c1", { everyMs: 240 * 60_000 }, now + 420_000), "The chat set its check-in: every 240 min", "the interval still applies");
  assert.deepEqual(await settings.get("c1"), { everyMs: 240 * 60_000, pausedUntil: "forever", pausedBy: "owner", setter: "ui" });
});

test("check-in pause by another agent: recorded with its session, the chat's own check_in {pause: null} clears it, another agent cannot clear an owner pause", async () => {
  const settings = checkInSettings(join(await mkdtemp(join(tmpdir(), "check-in-")), "check-in-settings.json"));
  const now = new Date(2026, 9, 10, 21, 54).getTime();
  const lead = { by: "agent", setter: "01a00000-0000-7000-8000-000000000008" } as const;
  const agent = (change: Parameters<typeof changeCheckIn>[1], at: number) => settings.update("c1", current => { const result = changeCheckIn(current, change, at, lead); return "setting" in result ? result.setting : current; });
  assert.deepEqual(await agent({ pause: "forever" }, now), { everyMs: 120 * 60_000, pausedUntil: "forever", pausedBy: "agent", setter: lead.setter });
  assert.equal(checkInLine(await settings.get("c1"), now), `Check-in: paused by agent ${lead.setter} until resumed; check_in {pause: null} resumes it`);
  assert.equal(await chatCheckIn(settings, "c1", { pause: null }, now + 60_000), "The chat set its check-in: resumed, every 120 min");
  assert.deepEqual(await settings.get("c1"), { everyMs: 120 * 60_000 });

  assert.deepEqual(changeCheckIn({ everyMs: 60_000, pausedUntil: "forever", pausedBy: "owner", setter: "ui" }, { pause: null }, now, lead),
    { refused: "the owner paused check-ins until they resume them; that stays" }, "an agent calling the API cannot clear the owner's pause");
  assert.deepEqual(changeCheckIn({ everyMs: 60_000, pausedUntil: "forever", pausedBy: "agent", setter: lead.setter }, { pause: null }, now, OWNER_UI), { setting: { everyMs: 60_000 } });
});

test("check-in settings file: an owner pause with no setter stays the owner's, an older chat pause reads as an agent's, an unknown author counts as the owner's", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "check-in-")), "check-in-settings.json");
  await writeFile(path, JSON.stringify({ old: { everyMs: 900_000, pausedUntil: "forever", pausedBy: "owner" }, mine: { everyMs: 900_000, pausedUntil: 1_900_000_000_000, pausedBy: "chat" },
    none: { everyMs: 900_000, pausedUntil: "forever" } }));
  const settings = checkInSettings(path);
  const now = new Date(2026, 9, 12, 12, 0).getTime();
  assert.deepEqual(await settings.get("old"), { everyMs: 900_000, pausedUntil: "forever", pausedBy: "owner" }, "no silent migration of the owner's pause");
  await assert.rejects(chatCheckIn(settings, "old", { pause: null }, now), /check_in refused: the owner paused check-ins until they resume them; that stays/);
  assert.deepEqual(await settings.get("mine"), { everyMs: 900_000, pausedUntil: 1_900_000_000_000, pausedBy: "agent" });
  assert.equal(await chatCheckIn(settings, "mine", { pause: null }, now), "The chat set its check-in: resumed, every 15 min");
  await assert.rejects(chatCheckIn(settings, "none", { pause: null }, now), /the owner paused check-ins/);
});


test("job end: each bad end of a job's last turn from its transcript and its words; a good end, a new input or a running reply is none", () => {
  const user = (text: string, at: number): ThreadMessage => ({ role: "user", content: text, timestamp: at });
  const said = (stopReason: "stop" | "error" | "aborted" | "length" | "toolUse", at: number, errorMessage?: string): ThreadMessage =>
    ({ role: "assistant", content: [], provider: "p", model: "m", stopReason, timestamp: at, ...(errorMessage ? { errorMessage } : {}) });
  const result: ThreadMessage = { role: "toolResult", toolCallId: "t", toolName: "ipython", content: [], isError: false, timestamp: 40 };
  const notice: ThreadMessage = { role: "custom", customType: "rlm_child_terminal_notice", content: "[child-exited: no-reply child:x]", timestamp: 60 };
  const task = user("[task from parent] build it", 10);
  assert.deepEqual(jobEnd([task, said("toolUse", 20), result, said("error", 50, "429  rate_limit_error:\n too many")]), { cause: "error", at: 50, error: "429 rate_limit_error: too many", startedAt: 10 });
  assert.deepEqual(jobEnd([task, said("aborted", 30), notice]), { cause: "aborted", at: 30, startedAt: 10 }, "a notice after the end is skipped");
  assert.deepEqual(jobEnd([task, said("toolUse", 30)]), { cause: "mid-tool", at: 30, startedAt: 10 }, "a tool call that never returned");
  assert.deepEqual(jobEnd([task, said("toolUse", 30), result]), { cause: "mid-tool", at: 40, startedAt: 10 }, "a tool result the model never answered");
  assert.deepEqual(jobEnd([task, said("length", 30)]), { cause: "length", at: 30, startedAt: 10 });
  const followUp: ThreadMessage = { role: "custom", customType: "agent_message", content: "[agent-message from parent]\nalso do y", timestamp: 25 };
  assert.equal(jobEnd([task, said("stop", 20), followUp, said("length", 30)])!.startedAt, 25, "a follow-up from the chat is the last start");
  assert.equal(jobEnd([task, said("stop", 30)]), null, "ended well");
  assert.equal(jobEnd([task, said("error", 30, "x"), user("continue", 40)]), null, "a new input waits after the failure");
  assert.equal(jobEnd([]), null);

  const at = 1_000_000;
  const long = "invalid_request_error: " + "x".repeat(200);
  assert.equal(jobEndWords({ cause: "error", error: long }), `stopped on a provider error ("${long.slice(0, 119)}…")`, "the first 120 characters");
  assert.equal(jobEndWords({ cause: "error" }), "stopped on a provider error");
  assert.equal(jobEndText("api audit", { cause: "mid-tool", at }), `api audit stopped in the middle of a tool call at ${clockTime(at)} and sent no report`,
    "information only: the chat decides what to do");
  assert.match(jobEndText("x", { cause: "length", at }), /hit the output length limit/);
});

test("check-in record: told job ends per chat and job, kept apart from the precheck's memory; old ones go; forget drops them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-ends-"));
  const record = checkInRecord(join(dir, "check-ins.json"));
  assert.deepEqual(await record.ends("c1"), {});
  await record.told("c1", "sub-1", { at: 1_000, cause: "error" });
  await record.set("c1", { at: 5, steps: {} });
  assert.deepEqual(await record.ends("c1"), { "sub-1": { at: 1_000, cause: "error" } }, "a precheck's memory write keeps the told ends");
  await record.told("c1", "thread:s-root", { at: 1_000 + TOLD_END_KEEP_MS + 1, cause: "length" });
  assert.deepEqual(await record.ends("c1"), { "thread:s-root": { at: 1_000 + TOLD_END_KEEP_MS + 1, cause: "length" } }, "an end older than a week before the new one goes");
  assert.deepEqual(await checkInRecord(join(dir, "check-ins.json")).ends("c1"), { "thread:s-root": { at: 1_000 + TOLD_END_KEEP_MS + 1, cause: "length" } }, "read back from the file");
  await record.forget("c1");
  assert.deepEqual(await record.ends("c1"), {});
});

test("looks done: an open item with every step under it closed, or a note that says it shipped; a wait or a negation is not done", () => {
  assert.equal(looksDone(step("p1", "Goal", "doing", { children: [step("p2", "Build", "done"), step("p3", "Verify", "dropped")] })), "every step under it is closed");
  assert.equal(looksDone(step("p1", "Goal", "doing", { children: [step("p2", "Build", "done"), step("p3", "Verify", "todo")] })), null, "an open step under it");
  assert.equal(looksDone(step("p1", "Goal", "doing")), null, "a goal with no steps yet is not done");
  assert.equal(looksDone(step("p1", "Goal", "done", { children: [step("p2", "Build", "done")] })), null, "a closed item");
  assert.equal(looksDone(step("p4", "Ship", "doing", { note: "Now live on production at 4f1c2a." })), 'its note says "Now live"');
  assert.equal(looksDone(step("p4", "Ship", "doing", { note: "Checked: live on staging.virev.ai" })), 'its note says "live on staging"');
  assert.equal(looksDone(step("p4", "Ship", "blocked", { note: "PR 812 merged, staging green" })), 'its note says "merged"');
  assert.equal(looksDone(step("p4", "Ship", "doing", { note: "Deployed to prod by land 25" })), 'its note says "Deployed"');
  assert.equal(looksDone(step("p4", "Ship", "doing", { note: "Reviewed after the call, deployed at 14:10" })), 'its note says "deployed"', "a comma ends the clause");
  for (const note of ["not merged yet", "close after it is deployed", "waits until landed", "to be released on Monday", "a live owner runs it", "not yet deployed", "waits until the PR is merged"]) {
    assert.equal(looksDone(step("p4", "Ship", "doing", { note })), null, note);
  }
});

test("looks done: a note that says shipped does not make an item done while a step under it is open or it waits on the owner (AI harness 10-12: p254, p288)", () => {
  assert.equal(looksDone(step("p254", "Every agent tool works", "doing", { note: "The send guards for the browser and mail are live.",
    children: [step("p253", "Mail guard", "done"), step("p268", "Fix the three skill index fails", "doing")] })), null, "an open step under it");
  assert.equal(looksDone(step("p288", "Verify the theme", "todo", { note: "55c466b shipped in release-452e8a9.", waitFor: "the owner's answer on t41" })), null, "a wait on the owner's answer");
  assert.equal(looksDone(step("p289", "Ship the theme", "doing", { note: "55c466b shipped in release-452e8a9." })), 'its note says "shipped"', "no open step and no wait");
  assert.equal(looksDone(step("p41", "Build: second CI machine", "blocked", { waitFor: "owner's ok on the vendor reply draft in For you",
    children: [step("p46", "Check", "done"), step("p98", "Prepare the setup kit", "done")] })), null, "every step done but the build waits on the owner (VP of CI 10-12, p41)");
});

test("looks done: a ship word in a note whose wait names a run still in flight, or whose note lists work left, is not done (launch main bro 10-12: p68, p54)", () => {
  const p68 = step("p68", "Ship: promote land 32b to prod (rate-test caps, engage fixes, Watchlist batch fix), after it is proven on staging", "todo", {
    waitFor: "promote 8 run 38267006888 (dispatched 15:00:06Z), Vercel prod aliases about 15:35-15:50Z, then the read-back: virev.ai 200 and an account add check with Fable",
    note: "Promote 8 was dispatched at 15:00:06Z on the owner's go ('hey i approve the promote...'). Pre-checks were clean: IO 0.9%, backends 116. " +
      "Prod crawler roles stop for about 6 min in the metal step. Obs is deployed at 64a696e59b (14:59Z)." });
  assert.equal(looksDone(p68), null, "the promote run is still in flight");
  assert.equal(looksDone({ ...p68, waitFor: "promote 8 run 38267006888, then the read-back", note: "Obs is deployed at 64a696e59b (14:59Z)." }), null,
    "Obs is another service than the promote it waits for");
  assert.equal(looksDone({ ...p68, waitFor: "promote 8 run 38267006888, then the read-back", note: "Promote 8 deployed to prod at 15:40Z." }), 'its note says "deployed"',
    "a claim about the waited promote may mean the wait is over");
  const p54 = step("p54", "Build: engage dashboard and alerts (pages per hour and day, account health, buy-more, killing, near-capacity), Slack DM to the owner to buy accounts", "doing", {
    job: "engage monitoring alerts", waitFor: "the operator-cause fix probe (deliberate operator freezes get their own cause), Fable's ruling and land 33",
    note: "Board 39 is live on obs (https://obs.virev.ai/d/engage-capacity). The job applied the 10 alert rules at about 15:05Z, all health ok. I checked the staging " +
      "screenshot board39-staging-top.png. Left to do: give deliberate operator freezes their own cause, so the staging freeze alert stops going red." });
  assert.equal(looksDone(p54), null, "a Left to do line");
  const { waitFor: _wait, ...p54Free } = p54;
  assert.equal(looksDone(p54Free), null, "a Left to do line with no wait");
  assert.equal(looksDone({ ...p54Free, note: "Board 39 is live on obs. Left: the operator-cause fix." }), null, "a Left: line");
});

test("looks done: a note whose run is rerunning, or whose \"released\" is about a queue or a hold, is not done (AI harness 10-13: p319)", () => {
  // p319's note when the 02:39 KST check-in flagged it for "released": Fable released the CI queue, and the step's own run was rerunning.
  const p319 = step("p319", "The shared checkout's working tree stops lagging HEAD after object-path landings: sync the stale files now, and fix the landing path and " +
    "commit.mjs so a stale copy can never revert landed work", "doing", { job: "stale tree sync",
    note: "The tree sync is done: 170 stale files were synced to HEAD, and live and unknown files were left alone. Promote 8's metal prod deploy is green, and " +
      "Fable released the queue at about 17:19Z, so ci/stale-tree-guard-3 (run 38268518309) is rerunning with its same id. stale tree sync reads it once at its " +
      "expected end, puts the guard on the tip if green, and reports." });
  assert.equal(looksDone(p319), null, "its run is rerunning");
  assert.equal(looksDone({ ...p319, note: "The tree sync is done. Fable released the CI queue at about 17:19Z." }), null, "the CI queue is not the step's work");
  assert.equal(looksDone({ ...p319, note: "Fable released the hold on land 33 at 17:19Z." }), null, "a released hold is not a ship");
  assert.equal(looksDone({ ...p319, note: "The tree sync is done: 170 stale files were synced to HEAD. ci/stale-tree-guard-3 run 38268518309 has been queued on " +
    "attempt 3 since 17:33Z, per ci-run-status at 17:45Z, behind the land-33 runs Fable put first." }), null, "its run is queued");
  assert.equal(looksDone({ ...p319, note: "The guard fix released in 1.4.2 at 18:10Z." }), 'its note says "released"', "a released fix still counts");
});

test("c44: a step filed as a goal, a finished goal left open and too many open goals are counted misses with plan-shape lines", () => {
  const now = Date.parse("2026-10-12T03:00:00Z");
  const areas = Array.from({ length: 5 }, (_, i) => step(`p${i + 1}`, `Area ${i + 1}`, "doing", { children: [step(`p${i + 11}`, "Build", "doing", { job: "live-job" })] }));
  const plan = board([...areas,
    step("p6", "Chat system works well", "doing", { children: [step("p16", "Fix the reply cap", "done"), step("p17", "Verify", "done")] }),
    step("p253", "Agents can't send emails or vendor ticket replies unless you approved it in For you", "doing"),
    step("p7", "Old area", "done", { children: [step("p86", "Watch the cache ratio", "todo")] })]);
  const facts: JobFact[] = [{ key: "job:live-job", name: "live-job", state: "working", activityAt: now }];
  const precheck = checkInPrecheck(undefined, facts, plan, now);
  const { metrics, flagged } = convergenceMisses("c1", precheck.steps, precheck, {}, 15 * 60_000, now);
  assert.equal(metrics.loose_goals, 1);
  assert.ok(metrics.finished_open >= 1);
  assert.equal(metrics.extra_goals, 1);
  assert.equal(metrics.open_under_closed, 1);
  assert.deepEqual(flagged.filter(slice => slice.kind === "loose_goals").map(slice => slice.item), ["p253"]);
  assert.ok(flagged.some(slice => slice.kind === "finished_open" && slice.item === "p6"));
  const text = checkInPrecheckText(precheck, facts, flagged, now);
  const shape = section(text, "Plan shape (fix it in this run with board ops: close or fold what shipped, move a loose step under its goal with plan_update parent, " +
    "hand off or remove the rest; the owner should never have to tidy the plan)");
  assert.deepEqual(shape, ['p253 "Agents can\'t send emails or vendor ticket replies unless yo…" is a top-level item with no steps: move it under the goal ' +
    "it belongs to with plan_update parent, give it steps, or close it if its work shipped",
    '7 open goals, the limit is 6: fold goals of one area under one area goal (p1 "Area 1", p2 "Area 2", p3 "Area 3", p4 "Area 4", p5 "Area 5", ' +
    'p6 "Chat system works well", p253 "Agents can\'t send emails or vendor ticket replies unless yo…")',
    'p86 "Watch the cache ratio" is open under closed p7: close it, or reopen p7 if the work is real']);
  assert.ok(text.indexOf("### Plan shape") < text.indexOf("### Look done"));
});

test("c45: a goal whose only open step another thread holds is a counted miss with a close-or-hand-off line, even while that thread is busy", () => {
  const now = Date.parse("2026-10-12T03:00:00Z");
  const vp = row("01a00000-vp", "AI harness developer environment VP", { working: true, lastActivityAt: "2026-10-12T02:59:00Z" });
  const plan = board([
    step("p1", "Old chats show in the sidebar again and stay there", "todo", { children: [
      step("p2", "Restore the chat list and fix the overwrite bug", "done", { job: "chat list restore" }),
      step("p3", "Verify the old chats show in the sidebar after a new chat opens", "todo", { job: "01a00000-vp", waitFor: "next chat release with the fix" })] }),
    step("p4", "Mixed goal", "doing", { children: [
      step("p5", "Build", "doing", { job: "live-job" }), step("p6", "Ship", "todo", { job: "01a00000-vp" })] }),
    step("p7", "Asked goal", "doing", { children: [step("p8", "Verify the Gmail import after the owner signs in", "blocked", { waitFor: "AI harness developer environment VP sign-in fix" })] }),
    step("p9", "Waits on a named thread", "doing", { children: [step("p11", "Build the guard", "done"),
      step("p10", "Recheck after the land", "todo", { waitFor: "AI harness developer environment VP lands the guard" })] }),
    step("p12", "Short of its target", "doing", { target: { metric: "Mbps used", target: 180, unit: "Mbps", current: 32 }, children: [step("p13", "Build", "done"),
      step("p14", "Ramp", "doing", { job: "01a00000-vp" })] }),
    step("p15", "Nothing of its own done yet", "doing", { children: [step("p16", "Ramp", "doing", { job: "01a00000-vp" })] }),
  ], [{ id: "t1", text: "Sign in to Gmail for the import check", from: "agent", done: false, at: "" } as OwnerTodo]);
  const rows = [vp, row("chat", "chat bugfix temp")];
  const facts = [...jobFacts([], plan, rows, "chat"), { key: "job:live-job", name: "live-job", state: "working" as const, activityAt: now }];
  const precheck = checkInPrecheck(undefined, facts, plan, now, { self: ["chat", "chat bugfix temp"], rows });
  assert.equal(precheck.steps.find(view => view.item.id === "p3")!.cls, "live", "a busy holding thread makes the step live, so no class line names it");
  const { metrics, flagged } = convergenceMisses("chat", precheck.steps, precheck, {}, 15 * 60_000, now);
  assert.equal(metrics.held_elsewhere, 2);
  assert.deepEqual(flagged.filter(slice => slice.kind === "held_elsewhere").map(slice => slice.item), ["p1", "p9"], "a step of the chat's own job, a For you todo, a target gap or no closed step keeps the goal here");
  const shape = section(checkInPrecheckText(precheck, facts, flagged, now), "Plan shape (fix it in this run with board ops: close or fold what shipped, move a loose step under its " +
    "goal with plan_update parent, hand off or remove the rest; the owner should never have to tidy the plan)");
  assert.equal(shape[0], 'p1 "Old chats show in the sidebar again and stay there" has no open work of its own: p3 "Verify the old chats show in the sidebar after a ' +
    'new chat o…" is held by the AI harness developer environment VP thread (thread:01a00000-vp) and waits for "next chat release with the fix". Check the wait ' +
    "against the real state now: if it is met, close the step and the goal on that evidence. If not, send that thread the leftover in one message with " +
    "what it must check. A step whose run, probe, land or push has not finished green and landed stays open with its job, and board-apply refuses " +
    "that close; close a step here with a note naming the thread only when what is left is that thread's own work. Keep the goal while a step under " +
    "it is open, or when more work of this chat comes after the wait, and add that step now");
});

test("c45: a step whose named wait is a closed step or an answered todo is a counted miss; an open one or another thread's id is not", () => {
  const now = Date.parse("2026-10-12T03:00:00Z");
  const plan = board([step("p66", "Save contact on an old sender", "doing", { children: [
    step("p67", "Build: Save contact", "done"),
    step("p68", "Verify on staging", "todo", { waitFor: "p67 landing on staging" }),
    step("p62", "Ship the first-run card", "todo", { waitFor: "t8, the owner's go", waitUntil: "2026-10-13T00:00:00Z" }),
    step("p57", "Ship the replay", "todo", { waitFor: "t10, the owner's answer on the budget; then CI on #218" }),
    step("p70", "Clean up", "todo", { waitFor: "the launch thread's p67" }),
  ] })], [{ id: "t8", text: "Go for PR 221?", from: "agent", done: false, reply: "Go", at: "" } as OwnerTodo,
    { id: "t10", text: "GitHub Actions budget?", from: "agent", done: false, at: "" } as OwnerTodo]);
  const precheck = checkInPrecheck(undefined, [], plan, now, { self: ["chat"] });
  const { metrics, flagged } = convergenceMisses("chat", precheck.steps, precheck, {}, 15 * 60_000, now);
  assert.equal(metrics.wait_met, 2);
  assert.deepEqual(flagged.filter(slice => slice.kind === "wait_met").map(slice => slice.excerpt), [
    'p68 "Verify on staging" waits for "p67 landing on staging", and p67 is done: the wait is over, act on it now (start it, or close it if the wait made it moot)',
    'p62 "Ship the first-run card" waits for "t8, the owner\'s go", and t8 is answered (read the answer: a hold is not a go): the wait is over, act on it now (start it, or close it if the wait made it moot)']);
  assert.deepEqual(section(checkInPrecheckText(precheck, [], flagged, now), "Waits that are over (act on each in this run)").length, 2);
});

test("no progress: an hour with no item done while an open step is not blocked is a miss; an item done in the hour, only blocked or waiting steps, or under an hour of memory passes", () => {
  const now = Date.parse("2026-10-12T05:00:00Z");
  const earlier = now - 2 * 60 * 60_000;
  const facts: JobFact[] = [{ key: "job:build-job", name: "build-job", state: "working", activityAt: now }];
  const plan = (built: PlanItem["status"], ship: Partial<PlanItem> = {}) => board([step("p1", "Goal", "doing", { children: [
    step("p2", "Build", built, { job: "build-job" }), step("p3", "Ship", "doing", ship), step("p4", "Verify", "blocked", { waitFor: "the owner's go on t1" })] })]);
  const run = (before: ChatBoard, after: ChatBoard, first = earlier) => {
    const memory = checkInPrecheck(undefined, facts, before, first, { self: ["chat"] }).memory;
    const precheck = checkInPrecheck(memory, facts, after, now, { self: ["chat"] });
    return { precheck, ...convergenceMisses("chat", precheck.steps, precheck, {}, 15 * 60_000, now) };
  };
  const stuck = run(plan("done"), plan("done"));
  assert.equal(stuck.metrics.no_progress, 1, "p2 was done before the hour and p3 is doing");
  assert.deepEqual(stuck.precheck.noProgress?.moving.map(view => view.item.id), ["p3"], "blocked p4 is held");
  assert.match(section(checkInPrecheckText(stuck.precheck, facts, stuck.flagged, now), "No progress in the last hour (work should be moving)")[0]!,
    /^No plan item was done in the last hour and 1 open step is not blocked \(p3 "Ship" orphan\): move one in this run/);
  assert.equal(run(plan("doing"), plan("done")).metrics.no_progress, 0, "p2 turned done in the hour");
  assert.equal(run(plan("done"), plan("done", { waitUntil: "2026-10-12T06:00:00Z" })).metrics.no_progress, 0, "a wait on purpose still ahead is held");
  assert.equal(run(plan("done"), plan("done", { waitUntil: "2026-10-12T04:00:00Z" })).metrics.no_progress, 1, "a wait whose time passed is not held");
  assert.equal(run(plan("done"), plan("done"), now - 30 * 60_000).metrics.no_progress, 0, "under an hour of memory gives no verdict");
  const renamed = board([step("p1", "Goal", "doing", { children: [step("p2", "Build v2", "done", { job: "build-job" }), step("p3", "Ship", "doing"),
    step("p4", "Verify", "blocked", { waitFor: "the owner's go on t1" })] })]);
  assert.equal(run(plan("done"), renamed).metrics.no_progress, 1, "an edit to an item already done is no progress");
});

test("job facts: a job whose own turn ended while its subagent works is at work, so its step is live, not an orphan (frontend bro 10-12: p78)", () => {
  const children: ChildAgent[] = [
    { id: "k1", parentId: "chat", label: "a", sessionName: "watchlist table rework", status: "done", lastActivityAt: 5 },
    { id: "k2", parentId: "k1", label: "helper", status: "running" },
    { id: "k3", parentId: "chat", label: "b", sessionName: "idle job", status: "done" },
  ];
  const plan = board([step("p77", "Watchlist", "doing", { children: [step("p78", "Table v2", "doing", { job: "watchlist table rework" }), step("p79", "Other", "doing", { job: "idle job" })] })]);
  const facts = jobFacts(children, plan, []);
  assert.deepEqual(facts.map(fact => [fact.name, fact.state]), [["watchlist table rework", "working"], ["idle job", "ended"]]);
  assert.deepEqual(checkInPrecheck(undefined, facts, plan, 100 * STEP_STALE_MS).steps.map(view => `${view.item.id} ${view.cls}`), ["p78 live", "p79 orphan"]);
});

test("parked: a blocked step whose note says an owner correction in force parks it is the owner's to release, never a stall, a chase or a go question (frontend bro 10-12, c40)", () => {
  const start = 100 * STEP_STALE_MS;
  const plan = board([step("p62", "Real app: nothing moves until you say 5180 is good enough", "doing", { children: [
    step("p52", "16 held bug fixes for Home, Creators, Connections, Watchlist and Email", "blocked", { waitFor: "your go on 5180",
      note: "Parked by your rule: no real-app fix moves and no For you question until you say 5180 is good enough (c40). The Watchlist flag-check part is 3 files, see s107." }),
    step("p31", "Build: move the merged Staging versions into the real app", "blocked", { waitFor: "all 6 apps merged into Staging, the flow walk passing, then your go",
      go: "needed", kind: "build", note: "Parked by your rule: no For you question until you say 5180 is good enough (c40, c24). Then it needs all 6 apps in Staging and the flow walk passing." }),
    step("p53", "Ship the held fix", "blocked", { waitFor: "your go on 5180", note: "Parked under c12, which the owner retired." }),
  ] })]);
  const context = { self: ["c-self"], corrections: ["c24", "c40"] };
  const first = checkInPrecheck(undefined, [], plan, start, context);
  const at = start + 3 * STEP_STALE_MS;
  const later = checkInPrecheck(first.memory, [], plan, at, context);
  const { metrics, flagged } = convergenceMisses("c-self", later.steps, later, {}, 15 * MIN, at);
  assert.deepEqual(classes(later), ["p52 (parked)", "p31 (parked)", "p53 (stale-chase)"], "a retired correction parks nothing");
  assert.deepEqual(flagged.filter(slice => ["stalled_steps", "stale_chase_24h", "orphan_steps"].includes(slice.kind)).map(slice => slice.item), ["p53"]);
  assert.equal(metrics.go_missing, 0);
  const text = checkInPrecheckText(later, [], flagged, at);
  assert.ok(!/p52|p31/.test(section(text, "Stalled waits (take one action on each in this run: check whether what it waits for already happened, do the next action yourself, start or steer a job, or add a For you todo; \"still waiting\" and a later waitUntil are not answers)").join("\n")));
  assert.ok(!/p52|p31/.test(section(text, "Steps whose class needs action").join("\n")));
  assert.ok(!/p52|p31/.test(section(text, "Other facts").join("\n")), "no 'add a For you todo for p31'");
});

test("c45: a waitFor that names another chat by its short name is that chat's wait, so its step ids are not this board's (AI harness 10-12: p285 and ops guy's p53)", () => {
  const now = Date.parse("2026-10-12T05:50:00Z");
  const rows = [row("01a00000-0000-7000-8000-000000000009", "ops guy (+observability)"), row("01a00000-0000-7000-8000-000000000010", "AI harness developer environment VP")];
  const plan = board([step("p53", "Old goal", "done"), step("p283", "Check-ins heal plans", "doing", { children: [
    step("p285", "Verify: two self-heal rounds", "todo", { waitFor: "ops guy's 05:46Z check-in on release-9f79ecc folds its p53 by itself; then the report" })] })]);
  const precheck = checkInPrecheck(undefined, [], plan, now, { self: ["01a00000-0000-7000-8000-000000000010", "AI harness developer environment VP"], rows });
  assert.deepEqual(precheck.waitsMet, [], "p53 here is not ops guy's p53");
  assert.deepEqual(waitTarget("ops guy's 05:46Z check-in folds its p53", rows, new Set(["01a00000-0000-7000-8000-000000000010"])),
    { id: "01a00000-0000-7000-8000-000000000009", name: "ops guy (+observability)" });
});
