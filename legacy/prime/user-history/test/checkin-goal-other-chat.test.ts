// VP of CI's check-in at 16:25Z on 10-23 sent its p1 goal steer ("push to verdict p90, 24 h 297.6 min, target at most 10 min") to the AI harness
// chat, because p342 under p1 named that chat as its job and the precheck read the chat's working thread as p1's owner. A goal's message goes
// only to a job of the chat whose board holds the goal.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { goalDueLine } from "../src/checkin-goals.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const NOW = Date.parse("2026-10-23T16:20:00Z");
const HARNESS = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const board = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-23T03:32:31Z", todos: [], plan: [{
  id: "p1", text: "Every push gets its test result within 10 minutes at p90, with no queue in front of it", status: "doing",
  target: { metric: "push to verdict p90, 24 h", target: 10, unit: "min", current: 297.6, measuredAt: "2026-10-23T03:32:31.611Z", direction: "down" },
  children: [
    { id: "p342", text: "Alert triage jobs get their first turn quickly inside the per-host agent queue", status: "doing", job: HARNESS, sessionId: HARNESS, children: [] },
    { id: "p360", text: "Push wait root cause", status: "doing", job: "push wait root cause", duty: "d1/push_to_verdict_p90_min", children: [] }] }] } as unknown as ChatBoard);

test("a goal's owner and steer never name another chat that holds a step under it", () => {
  const facts: JobFact[] = [
    { key: `thread:${HARNESS}`, sessionId: HARNESS, name: "AI harness developer environment VP", state: "working", chat: true, activityAt: NOW - 60_000 },
    { key: "sub-push", name: "push wait root cause", state: "ended", activityAt: NOW - 5 * 60 * 60_000 },
  ];
  const memo = { readings: [{ value: 297.6, at: Date.parse("2026-10-23T03:32:31.611Z") - 3_600_000 }, { value: 297.6, at: Date.parse("2026-10-23T03:32:31.611Z") - 1_800_000 }], still: 2 };
  const { goals } = checkInPrecheck({ at: NOW - 3_600_000, steps: {}, goals: { p1: memo } } as never, facts, board(), NOW, { jobs: [] });
  const p1 = goals.find(push => push.goal.id === "p1")!;
  assert.equal(p1.owner, undefined, "the AI harness chat's thread is not VP of CI's job");
  assert.equal(p1.act, "start");
  assert.equal(p1.stepJob?.step, "p360");
  const due = goalDueLine(p1) ?? "";
  assert.doesNotMatch(due, /AI harness|01a1164b/);
  assert.match(due, /Steer the job push wait root cause on p360/);
});

test("job-steer refuses a session that is another chat and sends it nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "goal-other-chat-"));
  const calls: string[] = [];
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add("ci");
  await index.add(HARNESS);
  const rows = (): SessionRow[] => [row("ci", new Date(NOW).toISOString(), { chat: true }), row(HARNESS, new Date(NOW).toISOString(), { chat: true })];
  const threads = fakeThreads(calls);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
    { ...source(home, { ci: board() }, () => NOW, rows), home });
  await chats.adopt();
  calls.length = 0;
  const steered = await chats.steerJob("ci", HARNESS, "Owner's words for p1 ...");
  assert.ok(steered && "otherChat" in steered, `steerJob answered ${JSON.stringify(steered)}`);
  assert.deepEqual(calls.filter(call => /^(restart|steer|prompt|tell) /.test(call)), []);
  chats.close();
});
