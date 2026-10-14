import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { STEP_STALE_MS, classLine, stepView } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobBrief, jobResumes } from "../src/job-resume.ts";
import type { ChildAgent, PlanItem, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * A job that reported and then sat quiet on a board wait kept its kernel and its session in the chat's worker until the wait came: on 10-14
 * at 18:19 KST 18 idle jobs held 2.0 GB of kernels on waits, the longest quiet 277 min. Past PARK_IDLE_MS (60 min: of 2,870 quiet spells a
 * bash completion ended, 95% ended within 53.8 min, and of 14,523 an agent message ended, 95% within 55.4 min) the chat saves the job's brief,
 * last report and wait, notes them on the step, and deletes the job; the check-in's line for the step, once its wait is due or stale, tells
 * the chat to spawn a fresh job from that file.
 */
const START = Date.parse("2026-10-14T08:00:00Z");
const BRIEF = "You land the ClickHouse memory cap. Push ci/ci-clickhouse-memcap-r1, wait for verify-dev, and on green compare-and-set sieun/dev.";
const REPORT = "Pushed 673c61f464 to ci/ci-clickhouse-memcap-r1. I'm waiting for verify-dev run 38529508093; on green I CAS it.";
const WAIT = "verify-dev run 38529508093 on ci/ci-clickhouse-memcap-r1 green";
const STEP: PlanItem = { id: "p12", text: "Build: ClickHouse gets a memory cap in CI", status: "doing", job: "ci clickhouse memcap", waitFor: WAIT, note: "r1 pushed", children: [] };
const JOB: ChildAgent = { id: "sub-9", sessionId: "01a13a00-0000-7000-8000-000000000000", label: "ci clickhouse memcap", sessionName: "ci clickhouse memcap", status: "done", repliedSinceTask: true, lastActivityAt: START };

async function setup(spawn: { prompt?: string } | null, sessionLines: string[] = [], job: ChildAgent = JOB) {
  const dir = await mkdtemp(join(tmpdir(), "waiting-job-"));
  const childDir = join(dir, "session-artifacts", "c1", JOB.id);
  await mkdir(childDir, { recursive: true });
  if (spawn) await writeFile(join(childDir, "rlm-subagent.json"), JSON.stringify({ ...spawn, createdAt: START - 3_600_000 }));
  if (sessionLines.length) await writeFile(join(childDir, "01a13a00-0000-7000-8000-000000000000.jsonl"), sessionLines.join("\n") + "\n");
  const boards = new BoardStore(dir);
  await mkdir(boards.dir, { recursive: true });
  await writeFile(join(boards.dir, "c1.json"), JSON.stringify({ v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [STEP] }));
  let now = START;
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", content: `[agent-message from child:ci clickhouse memcap]\n${REPORT}`, display: true,
    timestamp: START } as ThreadMessage]);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", "c1.jsonl") }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now), board: id => boards.read(id),
      resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") } }, line => lines.push(line));
  await chats.adopt();
  threads.fire().live("c1", [job]);
  await chats.settled();
  const sweep = async (at: number) => { now = at; await chats.tick(); await chats.settled(); };
  return { dir, chats, threads, calls, lines, boards, sweep };
}

test("an idle job whose only open work is a board wait is kept up to PARK_IDLE_MS, then saved on its step and deleted", async () => {
  const { dir, chats, calls, lines, boards, sweep } = await setup({ prompt: BRIEF });
  await sweep(START + PARK_IDLE_MS - 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [], "59 min quiet: kept, the wait may still end by itself");
  await sweep(START + PARK_IDLE_MS + 10 * 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-9"], "the next sweep, 10 min later");
  const path = join(dir, "job-resumes", "c1", "sub-9.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.brief, BRIEF);
  assert.equal(saved.report, REPORT);
  assert.equal(saved.event, `p12 waits for "${WAIT}"`);
  assert.deepEqual(saved.steps, ["p12"]);
  const step = (await boards.read("c1"))!.plan[0]!;
  assert.equal(step.waitFor, WAIT, "the wait stays on the step");
  assert.equal(step.job, "ci clickhouse memcap");
  assert.match(step.note!, new RegExp(`^Saved state: job ci clickhouse memcap ended at \\S+ while it was quiet; its brief, last report and wait are in ${path.replace(/[.]/g, "\\.")}\\.\\nr1 pushed$`));
  assert.ok(calls.some(call => call.startsWith("notice c1 [job] ci clickhouse memcap was ended after 70 min quiet while open steps named it") && call.includes(path)), calls.join("\n"));
  assert.ok(lines.some(line => line.startsWith("chat c1: ended waiting job ci clickhouse memcap (quiet 70 min")), lines.join("\n"));
  chats.close();
});

test("when the saved step's wait goes stale or due, the check-in tells the chat to spawn a fresh job from the saved state", async () => {
  const { dir, chats, boards, sweep } = await setup({ prompt: BRIEF });
  await sweep(START + PARK_IDLE_MS + 60_000);
  chats.close();
  const path = join(dir, "job-resumes", "c1", "sub-9.json");
  const step = (await boards.read("c1"))!.plan[0]!;
  const later = START + STEP_STALE_MS + 60_000;
  const stale = classLine(stepView(step, START, new Set(["c1"]), [], [], [], later), later);
  assert.match(stale ?? "", /^p12 .* waits for .*: chase it now/);
  assert.ok(stale!.endsWith(`Its job was ended while it waited: spawn a fresh job with the brief, last report and wait saved in ${path}`), stale!);
  const { waitFor: _wait, ...rest } = step;
  const timed: PlanItem = { ...rest, waitUntil: new Date(START + 2 * 3_600_000).toISOString() };
  const due = classLine(stepView(timed, START, new Set(["c1"]), [], [], [], START + 3 * 3_600_000), START + 3 * 3_600_000);
  assert.match(due ?? "", /^p12 .* is due since .*saved in /);
  const fresh = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual([fresh.brief, fresh.report], [BRIEF, REPORT], "the fresh job gets the old brief and the last report");
});

test("a brief over the daemon's 4,096 character spawn record comes from the job's session file; a job with no brief is kept", async () => {
  const long = "x".repeat(5000);
  const lines = [JSON.stringify({ type: "session", id: "01a13a00" }), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: long }] } })];
  const { dir, chats, calls, sweep } = await setup({}, lines);
  assert.equal(await jobBrief(join(dir, "session-artifacts", "c1", "sub-9")), long);
  const taskDir = await mkdtemp(join(tmpdir(), "job-task-"));
  // The way the daemon writes a spawned job's task (frontend bro's connections multiple accounts, 10-13 23:08Z): no user message at all.
  await writeFile(join(taskDir, "01a13785.jsonl"), [JSON.stringify({ type: "session", id: "01a13785" }),
    JSON.stringify({ type: "custom_message", customType: "harness_digest", content: "[harness-digest]\n..." }),
    JSON.stringify({ type: "custom_message", customType: "agent_message", content: `[task from parent]\n\n${long}`, display: true })].join("\n") + "\n");
  assert.equal(await jobBrief(taskDir), long, "the [task from parent] message is the brief");
  await sweep(START + PARK_IDLE_MS + 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-9"]);
  chats.close();
  const none = await setup(null);
  await none.sweep(START + PARK_IDLE_MS + 60_000);
  assert.deepEqual(none.calls.filter(call => call.startsWith("delete")), []);
  assert.ok(none.lines.includes("chat c1: kept waiting job ci clickhouse memcap: its brief could not be read"), none.lines.join("\n"));
  none.chats.close();
});

test("a quiet waiting job whose session holds a live tool call or a background bash wait is never deleted, and goes once that wait ends", async () => {
  const { chats, threads, calls, lines, sweep } = await setup({ prompt: BRIEF });
  threads.sessionBusy.add(JOB.sessionId!);
  await sweep(START + PARK_IDLE_MS + 10 * 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [], "ops guy's jobs sit in ci-run-status --wait and must compare-and-set on green");
  assert.ok(lines.includes("chat c1: kept job ci clickhouse memcap: its session runs a tool call or a background bash"), lines.join("\n"));
  threads.sessionBusy.delete(JOB.sessionId!);
  await sweep(START + PARK_IDLE_MS + 20 * 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-9"]);
  chats.close();
});

test("frontend bro 10-14 12:07Z: a quiet job that a doing step with no wait names is saved and deleted too, and the step asks for a fresh job", async () => {
  // connections multiple accounts sat 417 min after its report, held only by p106 doing and p115 blocked on a todo; neither had a waitFor.
  const { dir, chats, boards, calls, sweep } = await setup({ prompt: BRIEF });
  await boards.apply("c1", [{ op: "plan_update", id: "p12", waitFor: null }], "agent");
  await sweep(START + PARK_IDLE_MS + 10 * 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-9"]);
  const path = join(dir, "job-resumes", "c1", "sub-9.json");
  assert.equal(JSON.parse(await readFile(path, "utf8")).event, "p12 is doing");
  chats.close();
  const step = (await boards.read("c1"))!.plan[0]!;
  const later = START + STEP_STALE_MS + 60_000;
  const line = classLine(stepView(step, START, new Set(["c1"]), [], [], [], later), later);
  assert.match(line ?? "", /^p12 .* has no live owner .*saved in /, line ?? "");
});

test("Crawler VP 10-14 13:05Z: a quiet job that ended its task with no reply to the chat, under an open step, is saved and deleted too", async () => {
  // database explorer handed its commit to the sibling crawler ops train, sent the chat nothing, and sat 142 min under p160 until 15:2xZ.
  const { dir, chats, calls, sweep } = await setup({ prompt: BRIEF }, [], { ...JOB, repliedSinceTask: false });
  await sweep(START + PARK_IDLE_MS - 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [], "59 min quiet: kept");
  await sweep(START + PARK_IDLE_MS + 10 * 60_000);
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-9"]);
  const saved = JSON.parse(await readFile(join(dir, "job-resumes", "c1", "sub-9.json"), "utf8"));
  assert.deepEqual([saved.brief, saved.report, saved.steps], [BRIEF, REPORT, ["p12"]]);
  chats.close();
});
