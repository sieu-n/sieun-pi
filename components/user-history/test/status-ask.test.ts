import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInPrecheck, checkInRecord, convergenceMisses, lastJobMessages } from "../src/chat-checkin.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { JOB_NOTICE_PREFIX } from "../src/shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { STATUS_ASK } from "../src/status-ask.ts";

/**
 * Chat health 10-13: no_progress_hours counted 32 hours, and in 27 of them a step the check-in listed as moving had a job at work that had sent its
 * chat no report for the hour. The check-in job is a root session and cannot message the chat's subagents, so nothing asked those jobs where
 * they stood. Now the server has the chat send such a job one status ask, and only an answer with a fact moves its goal.
 */
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const JOB = "collab backfill";
const START = Date.parse("2026-10-13T10:00:00Z");
const MIN = 60_000;
const board: ChatBoard = { v: 2, rev: 1, updatedAt: new Date(START).toISOString(), scratch: [], todos: [], plan: [
  { id: "p1", text: "Collab posts on staging", status: "doing", children: [{ id: "p2", text: "Copy collab posts to staging", status: "doing", job: JOB, children: [] }] }] };
const working: ChildAgent = { id: "sub-5f2c", label: JOB, sessionName: JOB, status: "running", lastActivityAt: START };
const report = (text: string, at: number): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${JOB}]\n\n${text}`, timestamp: at }) as ThreadMessage;

async function server() {
  const dir = await mkdtemp(join(tmpdir(), "status-ask-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const messages: ThreadMessage[] = [];
  const prompts: string[] = [];
  let now = START;
  const threads = {
    state: () => ({ messages }), async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => false, async restart() {},
    async prompt(_id: string, input: { message: string }) { prompts.push(input.message); messages.push({ role: "user", content: [{ type: "text", text: input.message }], timestamp: now } as ThreadMessage); },
    async notice() {}, async deleteSubagent() {}, pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {},
    async reload() {}, observe() { return () => {}; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async () => board, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => now, noReportGraceMs: 0,
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source, () => {});
  await (chats as unknown as { roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(new Map([[CHAT, [working]]]));
  const checkInAt = async (at: number) => { now = at; await chats.checkIn(CHAT); return prompts.splice(0); };
  return { chats, messages, checkInAt };
}

test("status ask: a job at work on a step with no report for an hour gets one status ask through its chat, once per silence (Chat health 10-13, no_progress_hours)", async () => {
  const { chats, messages, checkInAt } = await server();
  assert.deepEqual(await checkInAt(START + 50 * MIN), [], "50 min of work is inside the hour");
  const asked = await checkInAt(START + 61 * MIN);
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.startsWith(`${JOB_NOTICE_PREFIX}${JOB} has worked on p2 "Copy collab posts to staging" for over an hour with no report`), asked[0]);
  assert.ok(asked[0]!.includes(`agent_message.send(${JSON.stringify(STATUS_ASK)}, receiver_role="child", receiver_name="${JOB}")`), asked[0]);
  assert.deepEqual(await checkInAt(START + 76 * MIN), [], "the chat holds the ask and the job has not answered");
  messages.push(report("Window B done: 412 pages written, run 38391122040 green.", START + 80 * MIN));
  assert.deepEqual(await checkInAt(START + 125 * MIN), [], "the job answered 45 min ago");
  assert.equal((await checkInAt(START + 141 * MIN)).length, 1, "a new hour of silence after the answer gets a new ask");
  chats.close();
});

test("status ask: only an answer with a fact moves the job's goal in no_progress; \"still on it\" does not", () => {
  const self = { self: [CHAT, "launch main bro"], everyMs: 15 * MIN };
  const fact = (said: ThreadMessage[]): JobFact => {
    const lastMessage = lastJobMessages(said).get(JOB);
    return { key: working.id, name: JOB, state: "working", item: { id: "p2", text: "Copy collab posts to staging", status: "doing" }, ...(lastMessage ? { lastMessage } : {}) };
  };
  const noProgressAt = (said: ThreadMessage[]): number => {
    const first = checkInPrecheck(undefined, [fact([])], board, START, self);
    const at = START + 90 * MIN;
    const run = checkInPrecheck(first.memory, [fact(said)], board, at, self);
    return convergenceMisses(CHAT, run.steps, run, {}, 15 * MIN, at).metrics.no_progress;
  };
  assert.equal(noProgressAt([]), 1, "silent for 90 min");
  assert.equal(noProgressAt([report("Still on it, will report when done.", START + 80 * MIN)]), 1, "an answer with no fact is no move");
  assert.equal(noProgressAt([report("Still copying.\nWindow B: 412 pages written so far.", START + 80 * MIN)]), 0, "a count on any line of the answer moves the goal");
  assert.equal(noProgressAt([report("Window B: 412 pages written.", START + 70 * MIN), report("Thanks, noted.", START + 80 * MIN)]), 0,
    "a fact earlier in the hour still counts after a later message with none");
});
