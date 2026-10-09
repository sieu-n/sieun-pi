import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activePause, changeCheckIn, chatCheckIn, parseChatCheckIn, checkInDigest, jobReport, lastJobMessages, checkInDue, checkInLine, checkInMessage, checkInRecord, checkInSettings, endedWithoutReport, nextCheckIn, pauseEnd, validCheckInEvery, jobFacts, readySteps,
  CHASE_ESCALATE_MS, clockTime, jobEnd, jobEndNotice, jobEndWords, localTime, NUDGE_EVERY_MS, ownedStep, retryDue, STALE_MS, STEP_STALE_MS, stepClass, stepOwner, TOLD_END_KEEP_MS, waitTarget, todoForStep,
  waitsOnOwner, type CheckInMemory, type JobFact } from "../src/chat-checkin.ts";
import { applyBoardOp, emptyBoard, nextIds, renderBoard } from "../src/shared/chat-board.ts";
import { chatLines, turnStarter } from "../src/shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, OwnerTodo, PlanItem, PlanStatus, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[], todos: ChatBoard["todos"] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", scratch: [], todos, plan });
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });

/** A step's class line (`classLine`); tests about other lines leave them out. */
const CLASS_LINE = /^p\d+ ".*?" (?:is due since|waits (?:for|on) |is yours and has not moved|has no live owner)/;
const noClass = (lines: readonly string[]): string[] => lines.filter(line => !CLASS_LINE.test(line));

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

test("check-in digest: transitions need a before; each change is reported once; no change gives no lines", () => {
  const now = 10 * STALE_MS;
  const plan = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "doing", { job: "api-audit" }), step("p3", "Build", "todo")] })],
    [{ id: "t1", text: "Slack or Telegram first?", done: false, from: "agent", at: "", choices: ["Slack", "Telegram"] }]);
  const audit: JobFact = { key: "k1", name: "api-audit", state: "working", activityAt: now - 60_000, replied: false, item: { id: "p2", text: "Plan", status: "doing" } };
  const first = checkInDigest(undefined, [audit], plan, now);
  assert.deepEqual(noClass(first.lines), [], "the baseline: nothing stale, no ready step (Plan is still doing)");
  assert.deepEqual({ ...first.memory, steps: Object.keys(first.memory.steps) }, { at: now, jobs: { k1: { state: "working", activityAt: now - 60_000 } }, steps: ["p2", "p3", "p1"], answered: [], ready: [] });
  assert.equal(first.memory.steps.p2!.at, now, "a step never seen before on a board with no updatedAt changed now");
  assert.deepEqual(noClass(checkInDigest(first.memory, [audit], plan, now + 1).lines), [], "no change");

  const later = now + 60_000;
  const answered = board(plan.plan, [{ ...plan.todos[0]!, reply: "Slack", done: true }]);
  const finished = checkInDigest(first.memory, [{ ...audit, state: "ended", activityAt: later }, { key: "k2", name: "docs", state: "failed", error: "context overflow", activityAt: later }],
    answered, later);
  assert.deepEqual(noClass(finished.lines), [
    "p2 (job api-audit) finished with no report; the board still says doing",
    "job docs failed: context overflow",
    'owner answered t1 "Slack or Telegram first?": Slack',
  ], "a new job that failed after the last tick counts as finished too");
  assert.deepEqual(noClass(checkInDigest(finished.memory, [{ ...audit, state: "ended", activityAt: later }], answered, later + 1).lines).filter(line => !line.includes("not updated")), [],
    "each change once (the next tick writes the report note on p2, which the note test covers)");
  const old = checkInDigest(first.memory, [{ key: "k9", name: "old", state: "ended", activityAt: now - 1 }], plan, later);
  assert.deepEqual(noClass(old.lines), [], "a new job whose last activity came before the last tick finished earlier");

  const ready = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "done", { job: "api-audit" }), step("p3", "Build", "todo")] })]);
  const next = checkInDigest(finished.memory, [], ready, later + 2);
  assert.deepEqual(noClass(next.lines), ['p3 "Build" can start: the steps before it are done and it has no job']);
  assert.deepEqual(noClass(checkInDigest(next.memory, [], ready, later + 3).lines), [], "a ready step is reported once");
});

test("check-in digest: a stale job once per quiet stretch; more than six lines fold into the last", () => {
  const now = 10 * STALE_MS;
  const quiet: JobFact = { key: "k1", name: "api-audit", state: "working", activityAt: now - STALE_MS - 120_000 };
  const first = checkInDigest(undefined, [quiet], null, now);
  assert.deepEqual(first.lines, ["job api-audit: no activity for 32 min"], "a condition, so the baseline reports it");
  assert.deepEqual(checkInDigest(first.memory, [quiet], null, now + 600_000).lines, [], "still the same stretch");
  const moved = checkInDigest(first.memory, [{ ...quiet, activityAt: now }], null, now + 60_000);
  assert.deepEqual(moved.lines, [], "activity moved");
  assert.equal(moved.memory.jobs.k1!.stale, undefined);
  assert.deepEqual(checkInDigest(moved.memory, [{ ...quiet, activityAt: now }], null, now + STALE_MS + 60_000).lines, ["job api-audit: no activity for 31 min"]);

  const memory: CheckInMemory = { at: 0, jobs: {}, steps: {}, answered: [], ready: [] };
  const many = Array.from({ length: 8 }, (_, index): JobFact => ({ key: `k${index}`, name: `job-${index}`, state: "ended", activityAt: 1 }));
  const lines = checkInDigest(memory, many, null, 2).lines;
  assert.equal(lines.length, 6);
  assert.equal(lines[5], "and 3 more");
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

test("check-in digest: a linked thread that posted, or failed is reported once, by step id and owner", () => {
  const now = 10 * STEP_STALE_MS;
  const plan = board([step("p1", "Goal", "doing", { children: [step("p7", "Usage backend", "doing", { job: "s-1" }), step("p8", "Favicon", "blocked", { job: "s-2" })] })]);
  const usage: JobFact = { key: "thread:s-1", name: "usage backend", state: "working", activityAt: now - 1000, messages: 10, item: { id: "p7", text: "Usage backend", status: "doing" } };
  const favicon: JobFact = { key: "thread:s-2", name: "favicon", state: "ended", activityAt: now - 1000, messages: 4, item: { id: "p8", text: "Favicon", status: "blocked" } };
  const first = checkInDigest(undefined, [usage, favicon], plan, now);
  assert.deepEqual(first.lines, []);
  const t1 = now + 300_000;
  const idle = checkInDigest(first.memory, [{ ...usage, state: "ended", activityAt: t1, messages: 12 }, { ...favicon, messages: 6, activityAt: t1 }], plan, t1);
  assert.deepEqual(idle.lines, ["p7 (usage backend thread) has 2 new messages and is idle; the board still says doing", "p8 (favicon thread) has 2 new messages and is idle"],
    "a thread going idle is no news; what it posted is");
  const t2 = t1 + 300_000;
  assert.deepEqual(checkInDigest(idle.memory, [{ ...usage, state: "ended", activityAt: t1, messages: 12 }, { ...favicon, messages: 6, activityAt: t1 }], plan, t2).lines, [],
    "no duplicate wake");
  const failed = checkInDigest(idle.memory, [{ ...usage, state: "failed", error: "429", activityAt: t2, messages: 13 }, { ...favicon, state: "working", messages: 9, activityAt: t2 }], plan, t2);
  assert.deepEqual(failed.lines, ["p7 (usage backend thread) failed: 429; the board still says doing"], "a working thread's new messages wait for it to go idle");
  const back = checkInDigest(failed.memory, [{ ...usage, state: "failed", error: "429", activityAt: t2, messages: 13 }, { ...favicon, state: "ended", messages: 11, activityAt: t2 + 1 }], plan, t2 + 300_000);
  assert.deepEqual(back.lines, ["p7 (usage backend thread) is still stopped: its last turn failed 5 min ago: 429", "p8 (favicon thread) has 2 new messages and is idle"],
    "a thread that worked and went idle is told by its messages; the failed owner of an open step again after 5 min");
});

test("job report: a message since the job's last wake is its report; one that says it waits is a wait", () => {
  const messages = [
    { role: "custom", customType: "agent_message", content: "[agent-message from child:settings-reland-2]\n\nCI is green locally. Waiting for a CI slot from the coordinator.", timestamp: 500 },
    { role: "custom", customType: "agent_message", content: [{ type: "text", text: "[agent-message from realtime layer]\n\nDone." }], timestamp: 600 },
    { role: "user", content: "hi", timestamp: 700 },
  ];
  const last = lastJobMessages(messages);
  assert.deepEqual([...last.keys()], ["settings-reland-2", "realtime layer"]);
  const lastMessage = last.get("settings-reland-2")!;
  assert.deepEqual(jobReport({ replied: false, lastMessage, wokeAt: 400 }), { reported: true, waits: lastMessage });
  assert.deepEqual(jobReport({ replied: false, lastMessage, wokeAt: 900 }), { reported: false }, "a message before the last wake is not this run's report");
  assert.deepEqual(jobReport({ replied: false, lastMessage: { at: 950, text: "Fixed in e5b18ac; all tests pass." }, wokeAt: 900 }), { reported: true });
  assert.deepEqual(jobReport({}), { reported: true }, "the daemon does not know: no claim of a missing report");
});

test("check-in digest: a job that ended waiting is told its wait once, not finished; one that reported finished", () => {
  const now = 100 * STEP_STALE_MS;
  const plan = board([step("p1", "Goal", "doing", { children: [step("p12", "Re-land settings", "doing", { job: "settings-reland-2" }), step("p13", "Docs", "doing", { job: "docs" }),
    step("p22", "Instagram crawl", "doing", { job: "s-ig" }), step("p23", "Metal", "blocked", { job: "s-metal" })] })]);
  const wait = { at: now - 5_000, text: "CI is green locally. Waiting for a CI slot from the coordinator before I push." };
  const reland: JobFact = { key: "k12", name: "settings-reland-2", state: "working", activityAt: now - 1_000, replied: false, wokeAt: now - 60_000, item: { id: "p12", text: "Re-land settings", status: "doing" } };
  const docs: JobFact = { key: "k13", name: "docs", state: "working", activityAt: now - 1_000, replied: false, wokeAt: now - 60_000, item: { id: "p13", text: "Docs", status: "doing" } };
  const ig: JobFact = { key: "thread:s-ig", name: "Instagram Main thread.", state: "working", activityAt: now - 1_000, messages: 5, item: { id: "p22", text: "Instagram crawl", status: "doing" } };
  const metal: JobFact = { key: "thread:s-metal", name: "metal", state: "ended", activityAt: now - 2 * STEP_STALE_MS, messages: 3, item: { id: "p23", text: "Metal", status: "blocked" } };
  const first = checkInDigest(undefined, [reland, docs, ig, metal], plan, now);
  assert.deepEqual(noClass(first.lines), [], "a blocked step's idle thread is expected to be idle");
  const t1 = now + 60_000;
  const ended = checkInDigest(first.memory, [{ ...reland, state: "ended", lastMessage: wait }, { ...docs, state: "ended", lastMessage: { at: now - 2_000, text: "Docs updated in 4f1c2a." } },
    { ...ig, state: "ended", activityAt: now }, metal], plan, t1);
  assert.deepEqual(noClass(ended.lines), ['p12 (job settings-reland-2) waits: "CI is green locally. Waiting for a CI slot from the coordin…"',
    "p13 (job docs) finished; the board still says doing"], "a thread going idle gives no line");
  const docsEnded: JobFact = { ...docs, state: "ended", lastMessage: { at: now - 2_000, text: "Docs updated in 4f1c2a." } };
  const woken = checkInDigest(ended.memory, [{ ...reland, wokeAt: t1, activityAt: t1 }, docsEnded, { ...ig, state: "ended", activityAt: now }, metal], plan, t1 + 30_000);
  const t2 = t1 + 120_000;
  const again = checkInDigest(woken.memory, [{ ...reland, state: "ended", activityAt: t2, wokeAt: now - 60_000, lastMessage: wait }, docsEnded, { ...ig, state: "ended", activityAt: now }, metal], plan, t2);
  assert.deepEqual(noClass(again.lines).filter(line => !line.includes("ended at")), [], "the same wait is told once, at its next end too");
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

test("check-in digest: due, stale-chase and orphan steps give their line at every tick until the chat acts; the open list shows each class", () => {
  const start = 100 * STEP_STALE_MS;
  const self = { self: ["c-self", "dev VP"], name: "dev VP" };
  const until = new Date(start + STEP_STALE_MS).toISOString();
  const plan = board([step("p1", "Goal", "doing", { children: [
    step("p7", "Check the load", "doing", { job: "c-self", waitUntil: until }), step("p9", "Revoke the old app", "blocked", { job: "c-self", waitFor: "Promote 5 green" }),
    step("p12", "Move the notices", "todo"), step("p13", "Done step", "done")] })]);
  const first = checkInDigest(undefined, [], plan, start, self);
  assert.deepEqual(first.lines, ['p12 "Move the notices" has no live owner: start a job, take it yourself, or ask the owner in For you'], "the baseline reports conditions");
  assert.deepEqual(first.open.map(line => line.split(" ").slice(0, 2).join(" ")), ["p7 (waiting)", "p9 (live)", "p12 (orphan)"]);
  const at = start + 2 * STEP_STALE_MS;
  const due = checkInDigest(first.memory, [], plan, at, self);
  assert.deepEqual(due.lines, [`p7 "Check the load" is due since ${clockTime(Date.parse(until))}: act on it or set a new waitUntil`,
    'p9 "Revoke the old app" waits for "Promote 5 green" for 4 h: chase it now; after 24 h make it a For you todo or replan',
    'p12 "Move the notices" has no live owner: start a job, take it yourself, or ask the owner in For you']);
  assert.deepEqual(checkInDigest(due.memory, [], plan, at + 15 * MIN, self).lines.length, 3, "again at the next tick: the chat must act, not only read");
  const day = checkInDigest(due.memory, [], plan, start + CHASE_ESCALATE_MS, self);
  assert.ok(day.lines.includes('p9 "Revoke the old app" waits for "Promote 5 green" for 24 h: make it a For you todo or replan it now'), day.lines.join(" | "));
  const acted = board([step("p1", "Goal", "doing", { children: [
    step("p7", "Check the load", "done", { job: "c-self" }), step("p9", "Revoke the old app", "blocked", { job: "c-self", waitFor: "Promote 5 green" }),
    step("p12", "Move the notices", "doing", { job: "notices" }), step("p13", "Done step", "done")] }),
    ], [{ id: "t1", text: "p9: revoke the old app now?", done: false, from: "agent", at: "", choices: ["Yes", "Wait"] }]);
  const notices: JobFact = { key: "k5", name: "notices", state: "working", activityAt: at + 20 * MIN };
  const calm = checkInDigest(due.memory, [notices], acted, at + 20 * MIN, self);
  assert.deepEqual(calm.lines, [], "a For you todo, a live job and a closed step need nothing");
  assert.deepEqual(calm.open.map(line => line.split(" ").slice(0, 2).join(" ")), ["p9 (foryou)", "p12 (live)"]);
});

test("check-in digest: a stale chase nudges the thread its waitFor names at most every 2 h, and the line says so", () => {
  const start = 100 * STEP_STALE_MS;
  const context = { self: ["c-self", "dev VP"], name: "dev VP", rows: [row("s-rel", "release owner"), row("c-self", "dev VP"), row("s-old", "release owner old", { archived: true })] };
  const plan = board([step("p1", "Goal", "doing", { children: [step("p9", "Revoke the old app", "blocked", { job: "c-self", waitFor: "the release owner's Promote 5 sha" }),
    step("p10", "Ship", "blocked", { job: "c-self", waitFor: "a real Claude outage" })] })]);
  const first = checkInDigest(undefined, [], plan, start, context);
  assert.deepEqual(first.nudges, [], "fresh waits are not chased");
  const stale = checkInDigest(first.memory, [], plan, start + 20 * 60 * MIN, context);
  assert.deepEqual(stale.nudges, [{ id: "s-rel", step: "p9", message: '[from dev VP] your step p9 "Revoke the old app" (it waits for "the release owner\'s Promote 5 sha") has waited 20 h: ' +
    'what is left, and when? Answer with `await agent_message.send(answer, receiver_role="sibling", receiver_name="dev VP")`.' }], "only a wait that names a thread is nudged");
  assert.ok(stale.lines.includes(`p9 "Revoke the old app" waits for "the release owner's Promote 5 sha" for 20 h: chase it now; after 24 h make it a For you todo or replan (I asked release owner at ${clockTime(start + 20 * 60 * MIN)})`), stale.lines.join(" | "));
  assert.deepEqual(checkInDigest(stale.memory, [], plan, start + 20 * 60 * MIN + STEP_STALE_MS - MIN, context).nudges, [], "not again within 2 h");
  const again = checkInDigest(stale.memory, [], plan, start + 20 * 60 * MIN + NUDGE_EVERY_MS, context);
  assert.deepEqual(again.nudges.map(nudge => nudge.id), ["s-rel"], "again after 2 h");
  assert.ok(again.lines.some(line => line.startsWith('p9 "Revoke the old app" waits for "the release owner\'s Promote 5 sha" for 22 h: chase it now')));
  const late = checkInDigest(again.memory, [], plan, start + CHASE_ESCALATE_MS + MIN, context);
  assert.ok(late.lines.some(line => line.startsWith('p9 "Revoke the old app" waits for "the release owner\'s Promote 5 sha" for 24 h: make it a For you todo or replan it now')), "after 24 h: a todo or a new plan");
  assert.equal(waitTarget("thread:s-rel says so", context.rows, new Set(context.self))?.id, "s-rel");
  assert.equal(waitTarget("dev VP decides", context.rows, new Set(context.self)), undefined, "never the chat itself");
  assert.equal(waitTarget("the release owner old one", context.rows, new Set(context.self))?.id, "s-rel", "an archived thread is never the target");
});

test("check-in digest: a step whose job ended after its last change and is still not updated at the next tick gets the report note, once", () => {
  const start = 100 * STEP_STALE_MS;
  const plan = (note?: string) => board([step("p1", "Goal", "doing", { children: [step("p2", "Fix the dates", "doing", { job: "dates fix", ...(note ? { note } : {}) })] })]);
  const working: JobFact = { key: "k1", name: "dates fix", state: "working", activityAt: start };
  const first = checkInDigest(undefined, [working], plan("started"), start);
  const end = start + 10 * MIN;
  const ended: JobFact = { ...working, state: "ended", activityAt: end, lastMessage: { at: end, text: "Fixed in 4f1c2a.", head: "Fixed in 4f1c2a. The Korean page shows Korean dates now." } };
  const told = checkInDigest(first.memory, [ended], plan("started"), end + MIN);
  assert.deepEqual(told.notes, [], "the tick that sees the end gives the chat its turn first");
  const late = checkInDigest(told.memory, [ended], plan("started"), end + 16 * MIN);
  assert.deepEqual(late.notes, [{ step: "p2", note: `Job dates fix ended at ${clockTime(end)}, report: Fixed in 4f1c2a. The Korean page shows Korean dates now.\nstarted` }]);
  assert.ok(late.lines.includes(`p2 "Fix the dates": job dates fix ended at ${clockTime(end)} and the step was not updated; I put its report in the step's note: update the step now`));
  assert.deepEqual(checkInDigest(late.memory, [ended], plan(late.notes[0]!.note), end + 31 * MIN).notes, [], "once per end");
  const recorded = checkInDigest(told.memory, [ended], plan("Fixed in 4f1c2a, checked on staging"), end + 16 * MIN);
  assert.deepEqual(recorded.notes, [], "a note the chat wrote after the end counts as the update");
  const cancelled = checkInDigest(told.memory, [{ ...ended, cancelled: true }], plan("started"), end + 16 * MIN);
  assert.deepEqual(cancelled.notes, [], "a job the chat deleted was read first");
});
test("check-in message: what changed, then every open step with owner and age, oldest change first, at most 30", () => {
  const now = 10 * STEP_STALE_MS;
  const plan = board([step("p1", "Goal", "doing", { children: [step("p2", "Build", "doing", { job: "api-audit" }), step("p3", "Verify", "todo"), step("p4", "Ghost", "todo", { job: "nobody" }),
    step("p5", "Old", "done")] })]);
  const audit: JobFact = { key: "k1", name: "api-audit", state: "working", activityAt: now, item: { id: "p2", text: "Build", status: "doing" } };
  const first = checkInDigest(undefined, [audit], plan, now);
  const moved = board([step("p1", "Goal", "doing", { children: [step("p2", "Build", "doing", { job: "api-audit" }), step("p3", "Verify", "blocked"), step("p4", "Ghost", "todo", { job: "nobody" }),
    step("p5", "Old", "done")] })]);
  const tick = checkInDigest(first.memory, [{ ...audit, state: "ended" }], moved, now + 3 * 60_000);
  assert.deepEqual(tick.open, ['p2 (orphan) "Build" doing, owner job api-audit (idle), last change 3 min ago', 'p4 (orphan) "Ghost" todo, owner nobody (not found), last change 3 min ago',
    'p3 (orphan) "Verify" blocked, no owner, last change 0 min ago'], "leaf steps only: the goal p1 has open steps below it");
  assert.equal(tick.lines[0], "p2 (job api-audit) finished; the board still says doing", "event lines come before the class lines");
  assert.equal(checkInMessage("[check-in] ", tick.lines, tick.open),
    `[check-in] What changed:\n${tick.lines.map(line => `- ${line}`).join("\n")}\n\nOpen steps, oldest change first:\n` + tick.open.map(line => `- ${line}`).join("\n"));
  const many = board(Array.from({ length: 35 }, (_, index) => step(`p${index + 1}`, `Step ${index + 1}`, "todo")));
  const listed = checkInDigest(undefined, [], many, now).open;
  assert.equal(listed.length, 30);
  assert.equal(listed[29], "and 6 more");
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
  const memory: CheckInMemory = { at: 5, jobs: { k1: { state: "working", activityAt: 4 } }, steps: { p1: { sig: "x", at: 3, chased: 4, ended: 2, noted: 2 } }, answered: ["t1"], ready: ["p3"] };
  assert.equal(await record.get("c1"), undefined);
  await record.set("c1", memory);
  assert.deepEqual(await record.get("c1"), memory);
  await record.forget("c1");
  assert.equal(await record.get("c1"), undefined);
  await record.set("c2", { at: 5, jobs: {}, answered: [], ready: [] } as unknown as CheckInMemory);
  assert.deepEqual((await record.get("c2"))?.steps, {}, "a memory written before steps were kept reads with none");
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
  assert.equal(renderBoard(null, "s-1", "Check-in: every 5 min").split("\n").slice(1, 4).join("|"), "This chat: thread:s-1|Check-in: every 5 min|The board is empty: no plan, no todos, no scratchpad.");

  const path = join(await mkdtemp(join(tmpdir(), "check-in-settings-")), "check-in-settings.json");
  const settings = checkInSettings(path);
  assert.deepEqual(await settings.get("c1"), { everyMs: 15 * 60_000 }, "default 15 min");
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

test("check-in digest: a failed owner of an open step is reported again 5, 10 and 20 min apart, then every 20; a working or closed one is not", () => {
  const start = 10 * STEP_STALE_MS;
  const plan = board([step("p1", "Goal", "doing", { children: [step("p37", "Usage change", "doing", { job: "s-1" })] })]);
  const tps: JobFact = { key: "thread:s-1", name: "TPS", state: "working", activityAt: start, messages: 5, item: { id: "p37", text: "Usage change", status: "doing" } };
  const dead: JobFact = { ...tps, state: "failed", error: "429 rate_limit_error" };
  let memory = checkInDigest(undefined, [tps], plan, start).memory;
  const at = (minutes: number) => { const tick = checkInDigest(memory, [dead], plan, start + minutes * MIN); memory = tick.memory; return tick.lines; };
  assert.deepEqual(at(1), ["p37 (TPS thread) failed: 429 rate_limit_error; the board still says doing"]);
  const reminded: number[] = [];
  for (let minute = 2; minute <= 80; minute++) if (at(minute).some(line => line.includes("still stopped"))) reminded.push(minute);
  assert.deepEqual(reminded, [6, 16, 36, 56, 76], "5 min after the failure, then 10, then every 20");
  assert.equal(checkInDigest(memory, [dead], plan, start + 96 * MIN).lines[0], "p37 (TPS thread) is still stopped: its last turn failed 95 min ago: 429 rate_limit_error");
  const closed = board([step("p1", "Goal", "doing", { children: [step("p37", "Usage change", "done", { job: "s-1" })] })]);
  assert.deepEqual(checkInDigest(memory, [{ ...dead, item: { id: "p37", text: "Usage change", status: "done" } }], closed, start + 200 * MIN).lines.filter(line => line.includes("still")), [],
    "a closed step's owner is left alone");
  const back = checkInDigest(memory, [{ ...tps, activityAt: start + 97 * MIN }], plan, start + 97 * MIN);
  assert.equal(back.memory.jobs["thread:s-1"]!.failedAt, undefined, "working again: the count starts over at the next failure");
});

test("check-in digest: a note-only edit is no change, a cancelled job ends with no line, a step the chat owns says you, only leaf steps are listed", () => {
  const now = 10 * STEP_STALE_MS;
  const plan = (note: string) => board([step("p1", "Goal", "doing", { children: [
    step("p2", "Build", "doing", { job: "fixer", note }), step("p3", "Verify", "todo", { job: "chat-6394" }), step("p4", "Docs", "doing", { job: "thread:c-self" })] })]);
  const fixer: JobFact = { key: "k1", name: "fixer", state: "working", activityAt: now, item: { id: "p2", text: "Build", status: "doing" } };
  const first = checkInDigest(undefined, [fixer], plan("started"), now, { self: ["c-self", "chat-6394"] });
  const later = now + 30 * MIN;
  const tick = checkInDigest(first.memory, [{ ...fixer, state: "ended", cancelled: true, activityAt: later }], plan("chased the owner again"), later, { self: ["c-self", "chat-6394"] });
  assert.deepEqual(noClass(tick.lines), [], "the chat cancelled the job itself, and a chase note is no board change; a doing step that names the owner is no owner wait");
  assert.equal(tick.memory.steps.p2!.at, now);
  assert.deepEqual(tick.open, ['p2 (orphan) "Build" doing, owner job fixer (ended), last change 30 min ago', 'p3 (live) "Verify" todo, owner you, last change 30 min ago',
    'p4 (live) "Docs" doing, owner you, last change 30 min ago'], "no goal line, no '(working)' for the chat's own steps");
  const rows = [row("c-self", "chat-6394", { working: true }), row("s-2", "other", { working: true })];
  const own = board([step("p1", "Goal", "doing", { children: [step("p3", "Verify", "todo", { job: "chat-6394" }), step("p5", "Ask", "doing", { job: "other" })] })]);
  assert.deepEqual(jobFacts([], own, rows, "c-self").map(fact => fact.key), ["thread:s-2"], "the chat's own row is no job");
  const status = checkInDigest(undefined, jobFacts([], own, rows, "c-self"), own, now, { self: ["c-self", "chat-6394"] });
  assert.equal(status.open.find(line => line.startsWith("p3")), 'p3 (live) "Verify" todo, owner you, last change 0 min ago');
});

test("check-in digest: a board read error and more than 3 open owner asks are lines, once per change and again every 2 hours; the error keeps the steps", () => {
  const now = 10 * STEP_STALE_MS;
  const asks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, text: `ask ${index + 1}`, done: false, from: "agent" as const, at: "" }));
  const plan = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "doing")] })], asks(3));
  const first = checkInDigest(undefined, [], plan, now);
  assert.deepEqual(noClass(first.lines), [], "3 open asks is the limit, not past it");
  const broken = checkInDigest(first.memory, [], null, now + MIN, { boardError: "Chat board file is malformed." });
  assert.deepEqual(noClass(broken.lines), ["the board cannot be read: Chat board file is malformed.; call chat_board again"]);
  assert.deepEqual(Object.keys(broken.memory.steps), ["p2", "p1"], "the steps stay for when the board reads again");
  assert.deepEqual(broken.open, []);
  const still = checkInDigest(broken.memory, [], null, now + 30 * MIN, { boardError: "Chat board file is malformed." });
  assert.deepEqual(noClass(still.lines), [], "once per error");
  assert.equal(noClass(checkInDigest(still.memory, [], null, now + MIN + STEP_STALE_MS, { boardError: "Chat board file is malformed." }).lines).length, 1, "again after 2 hours");
  const fixed = checkInDigest(still.memory, [], plan, now + 40 * MIN);
  assert.equal(fixed.memory.steps.p2!.at, first.memory.steps.p2!.at, "the board reads again: no step looks new");
  assert.deepEqual(noClass(fixed.lines), []);

  const nine = board(plan.plan, [...asks(9), { id: "t10", text: "done one", done: true, from: "agent", at: "" }, { id: "t11", text: "mine", done: false, from: "owner", at: "" }]);
  const over = checkInDigest(fixed.memory, [], nine, now + 50 * MIN);
  assert.deepEqual(noClass(over.lines), ["9 open owner todos; keep 3: decide or remove the rest"], "the agent's open asks only");
  assert.deepEqual(noClass(checkInDigest(over.memory, [], nine, now + 60 * MIN).lines), [], "once per count");
  assert.deepEqual(noClass(checkInDigest(over.memory, [], board(plan.plan, asks(5)), now + 60 * MIN).lines), ["5 open owner todos; keep 3: decide or remove the rest"], "a new count");
  assert.deepEqual(noClass(checkInDigest(over.memory, [], nine, now + 50 * MIN + STEP_STALE_MS).lines).filter(line => line.includes("owner todos")),
    ["9 open owner todos; keep 3: decide or remove the rest"], "again after 2 hours");
  assert.equal(checkInDue([], board([], asks(4))), true, "an ask overflow wakes a chat with no open step");
  assert.equal(checkInDue([], board([], asks(3))), false);
  assert.equal(checkInDue([], null, "Chat board file is malformed."), true, "so does a board it cannot read");
});

test("check-in digest: a step whose note waits on the owner with no ask for it is flagged once per change", () => {
  const now = 10 * STEP_STALE_MS;
  const self = { self: ["c-self"] };
  const plan = (status: PlanStatus, note?: string, todos: OwnerTodo[] = []) => ({ ...board([step("p1", "Goal", "doing", { children: [
    step("p2", "Decide the Stripe endpoint", status, { job: "c-self", ...(note ? { note } : {}) }), step("p3", "Build", "blocked", { job: "fixer" })] })]), todos });
  const waiting = plan("blocked", "Waits on the owner adding the endpoint in the Clerk dashboard");
  const asked = checkInDigest(undefined, [], waiting, now, self);
  assert.deepEqual(noClass(asked.lines), ["p2 waits on the owner but For you has no question for it: add one with choices"]);
  assert.deepEqual(noClass(checkInDigest(asked.memory, [], waiting, now + MIN, self).lines), [], "once per change");
  const withAsk = plan("blocked", "Waits on the owner adding the endpoint in the Clerk dashboard", [{ id: "t1", text: "Add the Clerk endpoint now?", choices: ["Yes", "Later"], done: false, from: "agent", at: "2026-10-08T00:00:00Z" }]);
  assert.deepEqual(noClass(checkInDigest(undefined, [], withAsk, now, self).lines), [], "an open ask that shares a word (endpoint) with the step covers it");
  const byId = plan("blocked", "needs your go", [{ id: "t2", text: "p2: go ahead?", choices: ["Go", "Wait"], done: false, from: "agent", at: "2026-10-08T00:00:00Z" }]);
  assert.deepEqual(noClass(checkInDigest(undefined, [], byId, now, self).lines), [], "an ask that names the step id covers it");
  const doneAsk = plan("blocked", "needs your go", [{ id: "t2", text: "p2: go ahead?", choices: ["Go", "Wait"], done: true, from: "agent", at: "2026-10-08T00:00:00Z" }]);
  assert.deepEqual(noClass(checkInDigest(undefined, [], doneAsk, now, self).lines), [], "the owner already answered the ask for this step: no new question");
  assert.equal(todoForStep({ id: "p9", text: "Sign in to Stripe" }, [{ text: "Approve the deploy?" }]), false);
  assert.equal(waitsOnOwner(step("p9", "Build", "blocked")), false, "blocked alone is the board shape, not an owner wait");
  assert.equal(waitsOnOwner(step("p9", "Build", "todo", { note: "Decide: A or B" })), false, "only a blocked step waits on the owner");
  assert.equal(waitsOnOwner(step("p9", "Build", "blocked", { note: "waits on the owner's choice: A or B" })), true);
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
  const lines = checkInDigest(undefined, [], { ...plan, todos: [] }, now).lines.filter(line => line.includes("For you has no question"));
  assert.deepEqual(lines.map(line => line.split(" ")[0]), ["p50", "p51"], "a land wait, a note naming the owner, and a doing step are not owner waits");
  const answered = { ...plan, todos: [{ id: "t12", text: "p50: approve the price?", done: true, reply: "yes", from: "agent" as const, at: "" }] };
  const after = checkInDigest(undefined, [], answered, now).lines.filter(line => line.includes("For you has no question"));
  assert.deepEqual(after.map(line => line.split(" ")[0]), ["p51"], "an answered ask for the step counts");
});

test("chat check_in: the chat pauses itself for 1h or until 09:00, resumes its own pause, sets its interval; an owner pause stays; the owner's later choice wins", async () => {
  const settings = checkInSettings(join(await mkdtemp(join(tmpdir(), "check-in-")), "check-in-settings.json"));
  const now = new Date(2026, 9, 8, 14, 0).getTime();
  assert.deepEqual(parseChatCheckIn({ pause: "1h" }), { pause: "1h" });
  assert.deepEqual(parseChatCheckIn({ pause: null, every_minutes: 30 }), { pause: null, everyMs: 30 * 60_000 });
  for (const bad of [{ pause: "forever" }, { every_minutes: 0 }, { every_minutes: 2.5 }, {}, "1h"]) assert.throws(() => parseChatCheckIn(bad), /check_in/);
  assert.equal(await chatCheckIn(settings, "c1", { pause: "tomorrow" }, now), "The chat set its check-in: paused until 2026-10-09 09:00");
  assert.deepEqual(await settings.get("c1"), { everyMs: 15 * 60_000, pausedUntil: new Date(2026, 9, 9, 9, 0).getTime(), pausedBy: "chat" });
  assert.equal(await chatCheckIn(settings, "c1", { pause: null }, now + 60_000), "The chat set its check-in: resumed, every 15 min");
  assert.equal(await chatCheckIn(settings, "c1", { everyMs: 30 * 60_000 }, now + 120_000), "The chat set its check-in: every 30 min");
  assert.equal(await chatCheckIn(settings, "c1", { pause: "1h" }, now + 180_000), "The chat set its check-in: paused until 2026-10-08 15:03");

  const owner = (change: Parameters<typeof changeCheckIn>[1], at: number) => settings.update("c1", current => { const result = changeCheckIn(current, change, at, "owner"); return "setting" in result ? result.setting : current; });
  assert.deepEqual(await owner({ pause: null }, now + 240_000), { everyMs: 30 * 60_000 }, "the owner's later choice wins over the chat's pause");
  await owner({ pause: "forever" }, now + 300_000);
  await assert.rejects(chatCheckIn(settings, "c1", { pause: null }, now + 360_000), /check_in refused: the owner paused check-ins until they resume them; that stays/);
  await assert.rejects(chatCheckIn(settings, "c1", { pause: "1h" }, now + 360_000), /that stays/);
  assert.equal(await chatCheckIn(settings, "c1", { everyMs: 60 * 60_000 }, now + 420_000), "The chat set its check-in: every 60 min", "the interval still applies");
  assert.deepEqual(await settings.get("c1"), { everyMs: 60 * 60_000, pausedUntil: "forever", pausedBy: "owner" });
  assert.deepEqual(changeCheckIn({ everyMs: 60_000 }, { pause: "forever" }, now, "chat"), { refused: "a chat pauses its check-ins for 1h or until tomorrow 09:00; only the owner pauses them until resumed" });
});


test("job end: each bad end of a job's last turn from its transcript, the words and the step note; a good end, a new input or a running reply is none", () => {
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
  assert.deepEqual(jobEndNotice("api audit", { cause: "mid-tool", at }), { line: `Job api audit stopped in the middle of a tool call at ${clockTime(at)} and sent no report: re-brief it with a follow-up, restart it, or replace it` });
  const text = `Job api audit was aborted at ${clockTime(at)} and sent no report: re-brief it with a follow-up, restart it, or replace it`;
  assert.deepEqual(jobEndNotice("api audit", { cause: "aborted", at }, step("p3", "Audit the API", "doing", { note: "older note" })),
    { line: `p3 "Audit the API": ${text}`, note: { step: "p3", note: `${text}\nolder note` } }, "the step's note gets the same text on top");
  assert.match(jobEndNotice("x", { cause: "length", at }).line, /hit the output length limit/);

  const plan = board([step("g", "Goal", "doing", { children: [step("p1", "Old", "done", { job: "api audit" }), step("p2", "Build", "doing", { job: "api audit" }),
    step("p3", "Root work", "todo", { job: "thread:s-root" })] })]);
  assert.equal(ownedStep(plan, ["sub-1", "api audit"])?.id, "p2", "the open step it owns, not a done one");
  assert.equal(ownedStep(plan, ["thread:s-root", "s-root"])?.id, "p3");
  assert.equal(ownedStep(plan, ["nobody"]), undefined);
  assert.equal(ownedStep(null, ["api audit"]), undefined);
});

test("check-in record: told job ends per chat and job, kept apart from the tick's memory; old ones go; forget drops them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-ends-"));
  const record = checkInRecord(join(dir, "check-ins.json"));
  assert.deepEqual(await record.ends("c1"), {});
  await record.told("c1", "sub-1", { at: 1_000, cause: "error" });
  await record.set("c1", { at: 5, jobs: {}, steps: {}, answered: [], ready: [] });
  assert.deepEqual(await record.ends("c1"), { "sub-1": { at: 1_000, cause: "error" } }, "a digest's memory write keeps the told ends");
  await record.told("c1", "thread:s-root", { at: 1_000 + TOLD_END_KEEP_MS + 1, cause: "length" });
  assert.deepEqual(await record.ends("c1"), { "thread:s-root": { at: 1_000 + TOLD_END_KEEP_MS + 1, cause: "length" } }, "an end older than a week before the new one goes");
  assert.deepEqual(await checkInRecord(join(dir, "check-ins.json")).ends("c1"), { "thread:s-root": { at: 1_000 + TOLD_END_KEEP_MS + 1, cause: "length" } }, "read back from the file");
  await record.forget("c1");
  assert.deepEqual(await record.ends("c1"), {});
});
