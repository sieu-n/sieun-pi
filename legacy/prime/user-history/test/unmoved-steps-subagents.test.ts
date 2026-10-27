// 10-27 22:57Z: d9 read stuck_steps_all 1 for frontend bro's p354. Its job "ai chat like claude" (01a17d7d on the Mac) went idle at 22:58Z after its
// turn failed on a pi-pool token, while its subagents chat-cards-fix and chat-endpage-fix still worked on p354 below it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobsByChat, withCatalogOwners } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const FB = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const JOB = "01a17d7d-a30b-722d-80d9-d3667b6c06a3";
const CARDS = "01a17e90-0000-7000-8000-000000000001";
const DEEP = "01a17e90-0000-7000-8000-000000000002";
const now = Date.parse("2026-10-27T23:20:00Z");
const board = { v: 2, rev: 1, updatedAt: "2026-10-27T22:00:00Z", todos: [], plan: [{ id: "p354", text: "5180's AI Chat feels like Claude", status: "doing",
  job: "ai chat like claude", sessionId: JOB, children: [] }] } as unknown as ChatBoard;
const plan = { now, chats: [{ id: FB, name: "frontend bro", runs: [], everyMs: 3_600_000, paused: true, duties: [] }], boards: new Map([[FB, board]]),
  ownerActivity: new Map<string, number>(), waking: new Set<string>(), poolWaiting: new Set<string>(), named: new Map<string, Map<string, string[]>>() } as unknown as PlanInputs;
const file = (session: string) => `/Users/sieunpark/.prime/agent/session-artifacts/${FB}/sub-387dd702/${session}.jsonl`;
const job = { sessionId: JOB, sessionName: "ai chat like claude", sessionFile: file(JOB), activity: "idle", lastActivityAt: "2026-10-27T22:10:00Z" };
const stuck = (rows: object[]) => planCounts({ ...plan, ...withCatalogOwners(plan, jobsByChat(rows as never), now, rows as never) }).stuck.flatMap(entry => entry.items);

test("a step whose idle job has a subagent at work below it, at any depth, is moved", () => {
  assert.deepEqual(stuck([job]), ["p354"], "the job alone has been quiet 70 min");
  assert.deepEqual(stuck([job, { sessionId: CARDS, sessionName: "chat-cards-fix", sessionFile: file(CARDS), activity: "working", parentSessionId: JOB }]), []);
  assert.deepEqual(stuck([job, { sessionId: CARDS, sessionFile: file(CARDS), activity: "idle", lastActivityAt: "2026-10-27T22:15:00Z", parentSessionId: JOB },
    { sessionId: DEEP, sessionFile: file(DEEP), activity: "idle", lastActivityAt: "2026-10-27T23:05:00Z", parentSessionId: CARDS }]), [], "a grandchild that wrote 15 min ago moves it");
});

test("a subagent that went quiet too, or a session that is no child of the job, leaves the step stuck", () => {
  assert.deepEqual(stuck([job, { sessionId: CARDS, sessionFile: file(CARDS), activity: "idle", lastActivityAt: "2026-10-27T22:20:00Z", parentSessionId: JOB }]), ["p354"]);
  assert.deepEqual(stuck([job, { sessionId: CARDS, sessionFile: file(CARDS), activity: "working", parentSessionId: FB }]), ["p354"]);
});
