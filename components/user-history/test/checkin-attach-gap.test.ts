import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, SessionRow } from "../src/shared/types.ts";

/**
 * VP of CI 10-15: the chat server and the daemon restarted at 13:49:57Z and 13:50:04Z. At 13:50:29Z the check-in's after-job measure of the
 * 21:07 run read stuck_steps 23, and the scheduled run at 13:57Z read 2. The hub had opened the chat (isLive) but its attach had not given
 * Chats its children yet, so `roster` skipped the chat and every step a subagent owned read as owned by nobody. That one measure became the
 * run's verdict and opened a fix job for a miss that was not there. The live precheck replays it: no roster for the chat gives 23 stuck, the
 * roster gives 1.
 */
const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const NOW = Date.parse("2026-10-15T13:50:29.000Z");

const board: ChatBoard = { v: 2, rev: 1, updatedAt: new Date(NOW - 3_600_000).toISOString(), todos: [], plan: [
  { id: "p1", text: "Top priority: every CI run takes about 6 to 8 minutes", status: "doing", children: [
    { id: "p2", text: "The small gate jobs that start every test run finish in seconds", status: "doing", job: "ci train", children: [] },
  ] },
] };
const train: ChildAgent = { id: "child-train", label: "ci train", sessionName: "ci train", sessionId: "s-train", status: "running", lastActivityAt: NOW - 60_000 };
const chatRow = { id: CHAT, name: "VP of CI", working: false, archived: false, messageCount: 983, subagentsRunning: 0 } as unknown as SessionRow;

async function setup(live: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "checkin-attach-gap-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => live,
    async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {}, pin: () => true, unpin() {}, async setSteeringMode() {},
    async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {}, observe() { return () => {}; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async () => board, rows: async () => [chatRow], memory: checkInRecord(join(dir, "check-ins.json")), settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 60 * 60_000,
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  return { chats, roster: (chats as unknown as { roster(children: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }) };
}

test("a chat the hub opened but has not attached yet takes its jobs from the roster, so its check-in counts no false stuck step (VP of CI 10-15 13:50Z)", async () => {
  const { chats, roster } = await setup(true);
  await roster.roster(new Map([[CHAT, [train]]]));
  const output = await chats.measureCheckIn(CHAT);
  chats.close();
  assert.ok(output, "the roster gives the chat's jobs, so the check-in can be measured");
  assert.equal(output.metrics.stuck_steps, 0, JSON.stringify(output.flagged?.filter(slice => slice.kind === "stuck_steps")));
});

