import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import type { CheckInRun } from "../src/chat-duty-run.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";
import { dutySink, fakeThreads, source } from "./chats-helpers.ts";

/**
 * The check-in pushes the chat's jobs (owner 10-16: "incompetance in our check in logic that didn't push the coordinator job"). The "IG index
 * gaps" chat's checklist sat at 0 of 3 for hours after its job "instagram index gaps" died at 00:19:57Z with "RLM quiescence wait cancelled",
 * leaving p2 and p3 orphaned; in the AI harness chat 9 jobs sat 1 to 3 hours with no progress and no report, and no check-in steered one.
 */
const MIN = 60_000;
const EVERY = 60 * MIN;
const NOW = Date.parse("2026-10-16T00:40:00Z");
const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "doing", children: [], ...extra });
const igBoard = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-15T21:00:00.000Z", todos: [], plan: [
  { id: "p1", text: "Find and close the Instagram index gaps", status: "doing", children: [
    step("p2", "Count the Tier A accounts missing from the index", { job: "instagram index gaps" }),
    step("p3", "Find why the census skips them", { job: "instagram index gaps" })] }] });
const precheck = (jobs: JobFact[], memory?: Parameters<typeof checkInPrecheck>[0], at = NOW, board = igBoard()) =>
  checkInPrecheck(memory, jobs, board, at, { self: ["chat", "IG index gaps"], everyMs: EVERY });

test("IG index gaps 10-16: a job whose last turn failed is restarted at once with what it owes", () => {
  const died: JobFact = { key: "k1", name: "instagram index gaps", state: "failed", error: "RLM quiescence wait cancelled", activityAt: Date.parse("2026-10-16T00:19:57Z") };
  const result = precheck([died]);
  assert.deepEqual(result.jobs.map(push => [push.fact.name, push.act, push.owes.length]), [["instagram index gaps", "restart", 2]]);
  assert.match(result.jobs[0]!.why, /its last turn ended in an error \(RLM quiescence wait cancelled\)/);
});

test("AI harness 10-16: a working job with no progress gets a nudge after one interval and a restart after two, once per interval", () => {
  const working: JobFact = { key: "k2", name: "quieter check ins", state: "working", activityAt: NOW - MIN };
  const first = precheck([working], undefined, NOW - 3 * EVERY);
  assert.deepEqual(first.jobs, [], "the first look starts the clock");
  const second = precheck([working], first.memory, NOW - 3 * EVERY + 70 * MIN);
  assert.deepEqual(second.jobs.map(push => push.act), ["nudge"]);
  const third = precheck([working], second.memory, NOW - 3 * EVERY + 100 * MIN);
  assert.deepEqual(third.jobs, [], "nudged under an interval ago");
  const fourth = precheck([working], third.memory, NOW - 3 * EVERY + 140 * MIN);
  assert.deepEqual(fourth.jobs.map(push => push.act), ["restart"]);
  const reported = { ...working, lastMessage: { at: NOW, text: "34 of 120 rows fixed", factsAt: NOW } };
  assert.deepEqual(precheck([reported], fourth.memory, NOW + 10 * MIN).jobs, [], "a report with a number is progress");
  const asleep = { ...working, wake: "a board.wake on run 38800442610" };
  assert.deepEqual(precheck([asleep], second.memory, NOW + 4 * EVERY).jobs, [], "a job asleep on a wake waits on purpose");
});

test("IG index gaps 10-16: the check-in run restarts the dead job in its session and tells the chat in one line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-push-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  await writeFile(join(dir, "check-in-settings.json"), JSON.stringify({ c1: { everyMs: EVERY } }));
  let now = NOW;
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: igBoard() }, () => now), duty: sink.duty });
  await chats.adopt();
  const job: ChildAgent = { id: "k1", label: "gaps", sessionName: "instagram index gaps", sessionId: "s-gaps", status: "error", error: "RLM quiescence wait cancelled",
    lastActivityAt: Date.parse("2026-10-16T00:19:57Z"), repliedSinceTask: false } as ChildAgent;
  threads.fire().live("c1", [job]);
  await chats.settled();
  calls.length = 0;
  now += EVERY;
  await chats.checkIn("c1");
  await chats.settled();
  assert.ok(calls.some(call => call.startsWith("restart s-gaps The check-in restarted you: you owe \"Count the Tier A accounts missing from the index\" and 1 more open step, " +
    "and its last turn ended in an error (RLM quiescence wait cancelled).")), calls.join("\n"));
  assert.ok(calls.includes("steer c1 [check-in] Check-in: restarted job instagram index gaps, because nothing moved on their work."), calls.join("\n"));
  const run = (sink.runs[0] as { run: CheckInRun & { prompt?: string } }).run;
  assert.match(run.prompt ?? "", /The server already restarted job instagram index gaps/);
});
