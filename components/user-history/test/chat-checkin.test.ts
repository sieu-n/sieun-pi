import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInDigest, checkInDue, checkInRecord, endedWithoutReport, jobFacts, readySteps, STALE_MS, type CheckInMemory, type JobFact } from "../src/chat-checkin.ts";
import { chatLines, turnStarter } from "../src/shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, PlanItem, SessionRow, ThreadMessage } from "../src/shared/types.ts";

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[], todos: ChatBoard["todos"] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", scratch: [], todos, plan });
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });

test("job facts: direct subagents, a plan link to a subagent or to another thread by name or id; nested subagents and unknown links are left out", () => {
  const children: ChildAgent[] = [
    { id: "k1", parentId: "chat", label: "a", sessionName: "api-audit", status: "running", lastActivityAt: 5, repliedSinceTask: false },
    { id: "k2", parentId: "k1", label: "nested", status: "running" },
    { id: "k3", parentId: "chat", label: "docs", status: "done", activity: { kind: "waiting" } },
    { id: "k4", parentId: "chat", label: "broken", status: "error", error: "model failed" },
  ];
  const plan = board([step("p1", "Reach chats from Slack", "doing", { children: [
    step("p2", "Plan", "doing", { job: "api-audit" }), step("p3", "Build", "doing", { job: "slack-bridge" }), step("p4", "Verify", "todo", { job: "s-9" }),
    step("p5", "Ghost", "todo", { job: "nobody" })] })]);
  const facts = jobFacts(children, plan, [row("s-1", "slack-bridge", { working: true, lastActivityAt: "2026-10-07T10:00:00Z" }), row("s-9", "verify-run", { failure: "429 rate limited" })]);
  assert.deepEqual(facts, [
    { key: "k1", name: "api-audit", state: "working", activityAt: 5, replied: false, item: { id: "p2", text: "Plan", status: "doing" } },
    { key: "k3", name: "docs", state: "working" },
    { key: "k4", name: "broken", state: "failed", error: "model failed" },
    { key: "thread:s-1", name: "slack-bridge", state: "working", activityAt: Date.parse("2026-10-07T10:00:00Z"), item: { id: "p3", text: "Build", status: "doing" } },
    { key: "thread:s-9", name: "s-9", state: "failed", error: "429 rate limited", item: { id: "p4", text: "Verify", status: "todo" } },
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
  assert.deepEqual(first.memory, { at: now, jobs: { k1: { state: "working", activityAt: now - 60_000 } }, answered: [], ready: [] });
  assert.deepEqual(checkInDigest(first.memory, [audit], plan, now + 1).lines, [], "no change");

  const later = now + 60_000;
  const answered = board(plan.plan, [{ ...plan.todos[0]!, reply: "Slack", done: true }]);
  const finished = checkInDigest(first.memory, [{ ...audit, state: "ended", activityAt: later }, { key: "k2", name: "docs", state: "failed", error: "context overflow", activityAt: later }],
    answered, later);
  assert.deepEqual(finished.lines, [
    'job api-audit (p2 "Plan") finished with no report; the board still says doing',
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

  const memory: CheckInMemory = { at: 0, jobs: {}, answered: [], ready: [] };
  const many = Array.from({ length: 8 }, (_, index): JobFact => ({ key: `k${index}`, name: `job-${index}`, state: "ended", activityAt: 1 }));
  const lines = checkInDigest(memory, many, null, 2).lines;
  assert.equal(lines.length, 6);
  assert.equal(lines[5], "and 3 more");
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
  const memory: CheckInMemory = { at: 5, jobs: { k1: { state: "working", activityAt: 4 } }, answered: ["t1"], ready: ["p3"] };
  assert.equal(await record.get("c1"), undefined);
  await record.set("c1", memory);
  assert.deepEqual(await record.get("c1"), memory);
  await record.forget("c1");
  assert.equal(await record.get("c1"), undefined);
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
