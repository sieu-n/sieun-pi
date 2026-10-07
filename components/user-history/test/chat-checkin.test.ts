import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activePause, checkInDigest, checkInDue, checkInLine, checkInMessage, checkInRecord, checkInSettings, endedWithoutReport, nextCheckIn, pauseEnd, validCheckInEvery, jobFacts, readySteps,
  retryDue, revivalMessage, STALE_MS, STEP_STALE_MS, stepOwner, turnFailure, type CheckInMemory, type JobFact } from "../src/chat-checkin.ts";
import { applyBoardOp, emptyBoard, nextIds, renderBoard } from "../src/shared/chat-board.ts";
import { chatLines, turnStarter } from "../src/shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, PlanItem, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[], todos: ChatBoard["todos"] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", scratch: [], todos, plan });
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });

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
  assert.deepEqual(first.lines, [], "the baseline: nothing stale, no ready step (Plan is still doing)");
  assert.deepEqual({ ...first.memory, steps: Object.keys(first.memory.steps) }, { at: now, jobs: { k1: { state: "working", activityAt: now - 60_000 } }, steps: ["p2", "p3", "p1"], answered: [], ready: [] });
  assert.equal(first.memory.steps.p2!.at, now, "a step never seen before on a board with no updatedAt changed now");
  assert.deepEqual(checkInDigest(first.memory, [audit], plan, now + 1).lines, [], "no change");

  const later = now + 60_000;
  const answered = board(plan.plan, [{ ...plan.todos[0]!, reply: "Slack", done: true }]);
  const finished = checkInDigest(first.memory, [{ ...audit, state: "ended", activityAt: later }, { key: "k2", name: "docs", state: "failed", error: "context overflow", activityAt: later }],
    answered, later);
  assert.deepEqual(finished.lines, [
    "p2 (job api-audit) finished with no report; the board still says doing",
    "job docs failed: context overflow",
    'owner answered t1 "Slack or Telegram first?": Slack',
  ], "a new job that failed after the last tick counts as finished too");
  assert.deepEqual(checkInDigest(finished.memory, [{ ...audit, state: "ended", activityAt: later }], answered, later + 1).lines, [], "each change once");
  const old = checkInDigest(first.memory, [{ key: "k9", name: "old", state: "ended", activityAt: now - 1 }], plan, later);
  assert.deepEqual(old.lines, [], "a new job whose last activity came before the last tick finished earlier");

  const ready = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "done", { job: "api-audit" }), step("p3", "Build", "todo")] })]);
  const next = checkInDigest(finished.memory, [], ready, later + 2);
  assert.deepEqual(next.lines, ['p3 "Build" can start: the steps before it are done and it has no job']);
  assert.deepEqual(checkInDigest(next.memory, [], ready, later + 3).lines, [], "a ready step is reported once");
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

test("check-in digest: a linked thread that went idle, posted while idle, or failed is reported once, by step id and owner", () => {
  const now = 10 * STEP_STALE_MS;
  const plan = board([step("p1", "Goal", "doing", { children: [step("p7", "Usage backend", "doing", { job: "s-1" }), step("p8", "Favicon", "blocked", { job: "s-2" })] })]);
  const usage: JobFact = { key: "thread:s-1", name: "usage backend", state: "working", activityAt: now - 1000, messages: 10, item: { id: "p7", text: "Usage backend", status: "doing" } };
  const favicon: JobFact = { key: "thread:s-2", name: "favicon", state: "ended", activityAt: now - 1000, messages: 4, item: { id: "p8", text: "Favicon", status: "blocked" } };
  const first = checkInDigest(undefined, [usage, favicon], plan, now);
  assert.deepEqual(first.lines, []);
  const t1 = now + 300_000;
  const idle = checkInDigest(first.memory, [{ ...usage, state: "ended", activityAt: t1, messages: 12 }, { ...favicon, messages: 6, activityAt: t1 }], plan, t1);
  assert.deepEqual(idle.lines, ["p7 (usage backend thread) went idle; the board still says doing", "p8 (favicon thread) has 2 new messages and is idle"]);
  const t2 = t1 + 300_000;
  assert.deepEqual(checkInDigest(idle.memory, [{ ...usage, state: "ended", activityAt: t1, messages: 12 }, { ...favicon, messages: 6, activityAt: t1 }], plan, t2).lines, [],
    "no duplicate wake");
  const failed = checkInDigest(idle.memory, [{ ...usage, state: "failed", error: "429", activityAt: t2, messages: 13 }, { ...favicon, state: "working", messages: 9, activityAt: t2 }], plan, t2);
  assert.deepEqual(failed.lines, ["p7 (usage backend thread) failed: 429; the board still says doing"], "a working thread's new messages wait for it to go idle");
  const back = checkInDigest(failed.memory, [{ ...usage, state: "failed", error: "429", activityAt: t2, messages: 13 }, { ...favicon, state: "ended", messages: 11, activityAt: t2 + 1 }], plan, t2 + 300_000);
  assert.deepEqual(back.lines, ["p7 (usage backend thread) is still stopped: its last turn failed 5 min ago: 429", "p8 (favicon thread) went idle"],
    "one line for a thread that worked and went idle, not one more for its messages; the failed owner of an open step again after 5 min");
});

test("check-in digest: an open step with no board change and no owner activity for 2 hours, once per 2-hour stretch", () => {
  const start = 100 * STEP_STALE_MS;
  const goal = (stepChildren: PlanItem[]) => board([step("p1", "Goal", "doing", { children: stepChildren })]);
  const plan = goal([step("p2", "Plan", "done"), step("p3", "Build", "doing", { job: "s-1" }), step("p4", "Verify", "blocked", { note: "waits on the owner" })]);
  const owner: JobFact = { key: "thread:s-1", name: "build", state: "ended", activityAt: start, messages: 2, item: { id: "p3", text: "Build", status: "doing" } };
  const first = checkInDigest(undefined, [owner], plan, start);
  assert.deepEqual(first.lines, []);
  const quiet = start + STEP_STALE_MS;
  const due = checkInDigest(first.memory, [owner], plan, quiet);
  assert.deepEqual(due.lines, ['p3 "Build" is doing with no board change and no owner activity for 2 h', 'p4 "Verify" is blocked with no board change and no owner activity for 2 h'],
    "the goal is not reported while a step below it is open");
  assert.deepEqual(checkInDigest(due.memory, [owner], plan, quiet + 300_000).lines, [], "once per stretch");
  const later = checkInDigest(due.memory, [{ ...owner, activityAt: quiet + 60_000 }], plan, quiet + STEP_STALE_MS);
  assert.deepEqual(later.lines, ['p4 "Verify" is blocked with no board change and no owner activity for 4 h'], "owner activity restarts p3's stretch; p4 is due again");
  const edited = goal([step("p2", "Plan", "done"), step("p3", "Build", "doing", { job: "s-1" }), step("p4", "Verify", "blocked", { note: "waits on the owner's login" })]);
  const changed = checkInDigest(later.memory, [owner], edited, quiet + STEP_STALE_MS + 60_000);
  assert.equal(changed.memory.steps.p4!.at, later.memory.steps.p4!.at, "a note edit is no change: a chase note does not reset the step's clock");
  const doneSteps = goal([step("p2", "Plan", "done"), step("p3", "Build", "done"), step("p4", "Verify", "done")]);
  const closed = checkInDigest(changed.memory, [], doneSteps, quiet + 2 * STEP_STALE_MS);
  assert.deepEqual(closed.lines, [], "the goal moved with its steps");
  assert.deepEqual(checkInDigest(closed.memory, [], doneSteps, quiet + 3 * STEP_STALE_MS).lines,
    ['p1 "Goal" is doing with no board change and no owner activity for 2 h'], "a goal whose steps are all done is due");
  const old = { ...plan, updatedAt: new Date(start - 3 * STEP_STALE_MS).toISOString() };
  assert.equal(checkInDigest(undefined, [], old, start).lines.length, 2, "on the first tick a step dates from the board's updatedAt");
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
  assert.deepEqual(tick.open, ['p2 "Build" doing, owner job api-audit (idle), last change 3 min ago', 'p4 "Ghost" todo, owner nobody (not found), last change 3 min ago',
    'p3 "Verify" blocked, no owner, last change 0 min ago'], "leaf steps only: the goal p1 has open steps below it");
  assert.equal(checkInMessage("[check-in] ", tick.lines, tick.open),
    "[check-in] What changed:\n- p2 (job api-audit) finished; the board still says doing\n\nOpen steps, oldest change first:\n" + tick.open.map(line => `- ${line}`).join("\n"));
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
  const memory: CheckInMemory = { at: 5, jobs: { k1: { state: "working", activityAt: 4 } }, steps: { p1: { sig: "x", at: 3, nudged: 4 } }, answered: ["t1"], ready: ["p3"] };
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
  assert.equal(renderBoard(null, "s-1", "Check-in: every 5 min").split("\n").slice(0, 3).join("|"), "This chat: thread:s-1|Check-in: every 5 min|The board is empty: no plan, no todos, no scratchpad.");

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

test("turn failure: the last reply stopped on an error or an abort with nothing after it; the revival text; the 5, 10, 20 min schedule", () => {
  const owner: ThreadMessage = { role: "user", content: "hows this doing?", timestamp: 1 };
  assert.deepEqual(turnFailure([owner, reply("error", 5, "Provider rate limit exceeded (rate_limit_error, 429)")]), { error: "Provider rate limit exceeded (rate_limit_error, 429)", at: 5 });
  assert.deepEqual(turnFailure([owner, reply("aborted", 6)]), { error: "aborted", at: 6 });
  assert.deepEqual(turnFailure([owner, reply("error", 7, "Connection error."), { role: "custom", customType: "refinement_notice", content: "x", timestamp: 8 }]),
    { error: "Connection error.", at: 7 }, "a display-only entry after the failure changes nothing");
  assert.equal(turnFailure([reply("error", 5, "429"), owner]), null, "the owner wrote after it: a new turn");
  assert.equal(turnFailure([owner, reply("stop", 5)]), null);
  assert.equal(turnFailure([owner, reply("toolUse", 5)]), null, "mid-turn");
  assert.equal(turnFailure([]), null);
  assert.equal(revivalMessage("429"), "[check-in] Your last turn failed (429). Re-check the board and continue.");
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
  assert.deepEqual(tick.lines, [], "the chat cancelled the job itself, and a chase note is no board change");
  assert.equal(tick.memory.steps.p2!.at, now);
  assert.deepEqual(tick.open, ['p2 "Build" doing, owner job fixer (ended), last change 30 min ago', 'p3 "Verify" todo, owner you, last change 30 min ago',
    'p4 "Docs" doing, owner you, last change 30 min ago'], "no goal line, no '(working)' for the chat's own steps");
  const rows = [row("c-self", "chat-6394", { working: true }), row("s-2", "other", { working: true })];
  const own = board([step("p1", "Goal", "doing", { children: [step("p3", "Verify", "todo", { job: "chat-6394" }), step("p5", "Ask", "doing", { job: "other" })] })]);
  assert.deepEqual(jobFacts([], own, rows, "c-self").map(fact => fact.key), ["thread:s-2"], "the chat's own row is no job");
  const status = checkInDigest(undefined, jobFacts([], own, rows, "c-self"), own, now, { self: ["c-self", "chat-6394"] });
  assert.equal(status.open.find(line => line.startsWith("p3")), 'p3 "Verify" todo, owner you, last change 0 min ago');
});

test("check-in digest: a board read error and more than 3 open owner asks are lines, once per change and again every 2 hours; the error keeps the steps", () => {
  const now = 10 * STEP_STALE_MS;
  const asks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, text: `ask ${index + 1}`, done: false, from: "agent" as const, at: "" }));
  const plan = board([step("p1", "Goal", "doing", { children: [step("p2", "Plan", "doing")] })], asks(3));
  const first = checkInDigest(undefined, [], plan, now);
  assert.deepEqual(first.lines, [], "3 open asks is the limit, not past it");
  const broken = checkInDigest(first.memory, [], null, now + MIN, { boardError: "Chat board file is malformed." });
  assert.deepEqual(broken.lines, ["the board cannot be read: Chat board file is malformed.; call chat_board again"]);
  assert.deepEqual(Object.keys(broken.memory.steps), ["p2", "p1"], "the steps stay for when the board reads again");
  assert.deepEqual(broken.open, []);
  const still = checkInDigest(broken.memory, [], null, now + 30 * MIN, { boardError: "Chat board file is malformed." });
  assert.deepEqual(still.lines, [], "once per error");
  assert.equal(checkInDigest(still.memory, [], null, now + MIN + STEP_STALE_MS, { boardError: "Chat board file is malformed." }).lines.length, 1, "again after 2 hours");
  const fixed = checkInDigest(still.memory, [], plan, now + 40 * MIN);
  assert.equal(fixed.memory.steps.p2!.at, first.memory.steps.p2!.at, "the board reads again: no step looks new");
  assert.deepEqual(fixed.lines, []);

  const nine = board(plan.plan, [...asks(9), { id: "t10", text: "done one", done: true, from: "agent", at: "" }, { id: "t11", text: "mine", done: false, from: "owner", at: "" }]);
  const over = checkInDigest(fixed.memory, [], nine, now + 50 * MIN);
  assert.deepEqual(over.lines, ["9 open owner todos; keep 3: decide or remove the rest"], "the agent's open asks only");
  assert.deepEqual(checkInDigest(over.memory, [], nine, now + 60 * MIN).lines, [], "once per count");
  assert.deepEqual(checkInDigest(over.memory, [], board(plan.plan, asks(5)), now + 60 * MIN).lines, ["5 open owner todos; keep 3: decide or remove the rest"], "a new count");
  assert.deepEqual(checkInDigest(over.memory, [], nine, now + 50 * MIN + STEP_STALE_MS).lines.filter(line => line.includes("owner todos")),
    ["9 open owner todos; keep 3: decide or remove the rest"], "again after 2 hours");
  assert.equal(checkInDue([], board([], asks(4))), true, "an ask overflow wakes a chat with no open step");
  assert.equal(checkInDue([], board([], asks(3))), false);
  assert.equal(checkInDue([], null, "Chat board file is malformed."), true, "so does a board it cannot read");
});
