/**
 * A due check-in starts its own check-in job, as Prime's chat does (server/check-in-job.ts):
 * 1. The job's name is Prime's `dutyJobName`, and its brief opens with Prime's lines and the owner's CHECK_IN_WORDS.
 * 2. The precheck lists goals and stuck steps, and nothing due starts no job.
 * 3. A due tick files one job under the agent, submits nothing to the work thread, and posts the job's report there as `[check-in]`.
 * 4. A paused check-in, a board with no open step and a last check-in job still at work start no job.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/check-in-job.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentSummary, ChatBoard, CheckInView, PlanItem } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import {
  CHECK_IN_REPORT, CHECK_IN_WORDS, checkInIdle, checkInJobBrief, checkInJobName, checkInPrecheck, checkInPrompt, datedName, IDLE_CHECK_IN_MS,
} from "../../server/check-in-job.ts";
import { start, until, type Running } from "./helpers.ts";

const AT = Date.parse("2026-11-21T22:00:00Z");
const item = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra });
const boardOf = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, plan, todos: [], updatedAt: new Date(AT).toISOString() });

test("the job name is Prime's dutyJobName in KST, cut to 32 characters, with the date on a clash", () => {
  assert.equal(checkInJobName("Prospect feature bro", AT), "check-in Prospect feature bro 07:00");
  assert.equal(checkInJobName("**A very long agent name that runs past the cut**", AT), "check-in A very long agent name that runs 07:00");
  assert.equal(datedName("check-in Prospect feature bro 07:00", AT), "check-in Prospect feature bro 11-22 07:00");
});

test("the brief opens with Prime's lines and the owner's words, and names the board, the steer call and the report", () => {
  const brief = checkInJobBrief({
    agent: "vent", workThread: "W1", job: "check-in vent 07:00", at: AT, prompt: "## Goals\nThe agent has no open goal.", detail: "/d/checkin.md",
    boardApi: "http://h/api/threads/W1/board", steerApi: "http://h/api/threads/W1/job-steer", itemsApi: "http://h/api/c/W1/items",
  });
  assert.ok(brief.startsWith('# check-in vent 07:00: the check-in of the agent "vent"\n\nYou are the check-in job "check-in vent 07:00" of the agent "vent", started 2026-11-22 07:00 KST.'));
  assert.ok(brief.includes(`The owner's words for the check-in (verbatim):\n\n> ${CHECK_IN_WORDS}`));
  assert.ok(brief.includes("The plan holds only tasks that finish, and this run pushes each open step toward done"));
  assert.ok(brief.includes("The full precheck, with every step and finding, is in /d/checkin.md."));
  assert.ok(brief.includes('httpx.post("http://h/api/threads/W1/board", json={"actor": "agent", "ops": ops}'));
  assert.ok(brief.includes('httpx.post("http://h/api/threads/W1/job-steer", json={"job": job_name, "text": text, "from": "check-in vent 07:00"}'));
  assert.ok(brief.includes(CHECK_IN_REPORT));
  assert.ok(brief.includes("`[check-in]` note"));
});

test("the precheck asks for a target, a push step and each stuck step, and an owned goal or a held step is not due", () => {
  const plan = [
    item("p1", "Crawl at 10k a minute", { target: { metric: "profiles a minute", target: 10_000, unit: "", current: 4_000 }, children: [item("p2", "Find the blocker")] }),
    item("p3", "Cut the bill", { target: { metric: "cost", target: 100, unit: "USD", current: 300, direction: "down" }, children: [item("p4", "Trim reads", { job: "trimmer" })] }),
    item("p5", "Write the docs"),
    item("p6", "Merge PR #12", { status: "doing" }),
  ];
  const board = { ...boardOf(plan), todos: [{ id: "t1", text: "ok to merge?", done: false, from: "agent" as const, at: new Date(AT).toISOString(), step: "p6" }] };
  const precheck = checkInPrecheck(board, [], new Set(["trimmer"]));
  assert.deepEqual(precheck.goals.map(view => [view.goal.id, view.met, view.owner ?? null]), [["p1", false, null], ["p3", false, "trimmer"], ["p5", null, null], ["p6", null, null]]);
  assert.deepEqual(precheck.stuck.map(step => step.id), ["p2", "p5"]);
  const prompt = checkInPrompt(precheck);
  assert.ok(prompt.includes('- "Crawl at 10k a minute" (p1): profiles a minute 4,000 of 10,000, 6,000 short; no live job owns it.'));
  assert.ok(prompt.includes('- "Cut the bill" (p3): cost 300 USD, target at most 100 USD, 200 USD over; trimmer owns it.'));
  assert.ok(prompt.includes('Add a push step under p1 with duty "checkin/goal_gaps"'));
  assert.ok(!prompt.includes("push step under p3"));
  assert.ok(prompt.includes('Give "Write the docs" a target from the owner\'s words, with plan_update target.'));
  assert.ok(prompt.includes("2 open steps have no live owner."));
  assert.equal(checkInIdle(precheck), false);
});

test("an empty board is idle for a root chat and due for an agent with a brief, which the prompt names", () => {
  const empty = checkInPrecheck(boardOf([item("p1", "Old work", { status: "done" })]), [], new Set());
  assert.equal(empty.planOpen, false);
  assert.equal(checkInIdle(empty), true);
  assert.ok(checkInPrompt(empty).includes("Nothing is due"));
  assert.equal(checkInIdle(empty, { brief: "/a/vent/brief.md" }), false);
  assert.ok(checkInPrompt(empty, { brief: "/a/vent/brief.md" }).includes("Read the agent's brief at /a/vent/brief.md and add the steps it calls for"));
});

let s: Running;
let host: FixtureHost;
let busy: AgentSummary;
let idle: AgentSummary;
const workInputs: { thread: string; requestId?: string; text: string }[] = [];

before(async () => {
  s = await start({ wordMs: 0 });
  assert.ok(s.host instanceof FixtureHost);
  host = s.host;
  busy = (await s.send("POST", "/api/agents", { name: "check-in busy agent" })).body;
  idle = (await s.send("POST", "/api/agents", { name: "check-in idle agent" })).body;
  host.beforeSubmit = (thread, input) => {
    if (thread === busy.thread || thread === idle.thread) workInputs.push({ thread, text: input.text ?? "", ...(input.requestId ? { requestId: input.requestId } : {}) });
  };
  for (const agent of [busy, idle]) await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
  await s.app.boards.apply(busy.id, [{ op: "plan_add", text: "Ship the relay" }], "agent");
});
after(async () => {
  await s.close();
});

const dutyFile = (agent: AgentSummary) => JSON.parse(readFileSync(s.app.boards.dutiesPath(agent.id), "utf8")) as { checkIn?: { lastAt: number; job?: { id: string; name: string; reported?: true; archived?: true } } };
const jobsOf = (agent: AgentSummary) => s.app.boards.chatAgents(agent.id).map(job => job.name).filter(name => name.startsWith("check-in "));
const nextAt = async (agent: AgentSummary) => (await s.get<CheckInView>(`/api/agents/${agent.id}/check-in`)).nextAt!;

test("a due check-in files one job under the agent, sends nothing into the work thread, and posts the job's report there", async () => {
  const at = await nextAt(busy);
  await s.app.boards.tick(at);
  const job = (await until(async () => dutyFile(busy).checkIn?.job, value => value !== undefined))!;
  assert.equal(job.name, checkInJobName("check-in busy agent", at));
  assert.deepEqual(s.app.store.state.threads[job.id], { kind: "job", parent: busy.id });
  assert.equal(s.app.agents.record(job.id)?.id, busy.id);
  assert.deepEqual(jobsOf(busy), [job.name]);
  assert.equal(workInputs.some(input => input.requestId?.startsWith("checkin:")), false);
  await until(async () => dutyFile(busy).checkIn?.job?.reported, reported => reported === true);
  const reports = workInputs.filter(input => input.thread === busy.thread && input.requestId === `checkin-report:${job.id}`);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.text.startsWith("[check-in] "));
  const details = readdirSync(join(s.app.boards.dir(busy.id), "check-ins"));
  assert.equal(details.length, 1);
  assert.ok(readFileSync(join(s.app.boards.dir(busy.id), "check-ins", details[0]!), "utf8").includes("Ship the relay"));
});

test("the check-in skips while its last check-in job still works, and the ended job is archived", async () => {
  const job = dutyFile(busy).checkIn!.job!;
  const thread = host.threadsById.get(job.id)!;
  // pi-pool holds the job for an account slot: pi-host reads it as sleeping, not running.
  thread.row.status = "sleeping";
  thread.row.updatedAt = Date.now() + 1;
  await s.app.threads.refresh();
  const at = await nextAt(busy);
  await s.app.boards.tick(at);
  await until(async () => dutyFile(busy).checkIn!.lastAt, lastAt => lastAt === at);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(dutyFile(busy).checkIn!.job!.id, job.id);
  thread.nodes[0]!.status = "idle";
  thread.row.status = "idle";
  thread.row.updatedAt = Date.now() + 2;
  await s.app.threads.refresh();
  await s.app.boards.tick(at + 1);
  await until(async () => dutyFile(busy).checkIn!.job!.archived, archived => archived === true);
  assert.equal(host.threadsById.get(job.id)!.row.archived, true);
});

test("a board with no open step checks in daily, and with no brief starts no job", async () => {
  await s.app.boards.board(idle.id);
  const view = await s.get<CheckInView>(`/api/agents/${idle.id}/check-in`);
  assert.equal(view.everyMs, IDLE_CHECK_IN_MS);
  assert.equal(view.planEveryMs, 120 * 60_000);
  assert.equal(view.nextAt, s.app.agents.record(idle.id)!.createdAt + IDLE_CHECK_IN_MS);
  await s.app.boards.tick(view.nextAt!);
  await until(async () => dutyFile(idle).checkIn?.lastAt, lastAt => lastAt === view.nextAt);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(dutyFile(idle).checkIn?.job, undefined);
  assert.deepEqual(jobsOf(idle), []);
  assert.equal(workInputs.some(input => input.thread === idle.thread), false);
});

test("a paused check-in starts no job", async () => {
  const before = dutyFile(busy).checkIn!.job!.id;
  await s.send("POST", `/api/agents/${busy.id}/check-in`, { pause: "forever" });
  await s.app.boards.tick(Date.now() + 30 * IDLE_CHECK_IN_MS);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(dutyFile(busy).checkIn!.job!.id, before);
  await s.send("POST", `/api/agents/${busy.id}/check-in`, { pause: null });
});

test("job-steer delivers a message to a job inside the work thread as an input from the check-in job, and refuses a job the agent lacks", async () => {
  const work = host.threadsById.get(busy.thread)!;
  const child = host.addChild(work, 1, "relay page job", Date.now(), "idle");
  work.row.updatedAt = Date.now() + 3;
  await s.app.threads.refresh();
  const steered: { conversation?: number; via?: string; from?: string }[] = [];
  const previous = host.beforeSubmit;
  host.beforeSubmit = (thread, input) => {
    if (thread === busy.thread && input.entry?.data.via === "job-steer") steered.push({ ...(input.conversation ? { conversation: input.conversation } : {}), via: input.entry.data.via, from: input.entry.data.from });
    return previous?.(thread, input);
  };
  const ok = await s.send("POST", `/api/threads/${busy.thread}/job-steer`, { job: "relay page job", text: "Push the relay fix.", from: "check-in busy agent 07:00" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.job, "relay page job");
  assert.deepEqual(steered, [{ conversation: child.id, via: "job-steer", from: "check-in busy agent 07:00" }]);
  const missing = await s.send("POST", `/api/threads/${busy.thread}/job-steer`, { job: "no such job", text: "hi" });
  assert.equal(missing.status, 400);
  host.beforeSubmit = previous;
});
