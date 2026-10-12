import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, SessionRow } from "../src/shared/types.ts";

/**
 * AI harness developer environment VP 10-13 02:39 KST: the check-in flagged p334, p349 and p350 as orphans, "(busy chat inbox not found)" and
 * "(service start profile not found)". Both jobs were at work as subagents of the chat's 01:54 check-in job (a duty job, a root session of its
 * own), so the chat's own children never listed them. The items, ids and names below are the real ones from the board and the daemon.
 */
const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const CHECK_IN = "01a13111-fc7c-724b-ab0c-01a763447729";
const NOW = Date.parse("2026-10-12T17:39:00.000Z");
const T0 = "2026-10-12T15:00:00.000Z";

const board: ChatBoard = { v: 2, rev: 1, scratch: [], todos: [], updatedAt: T0, plan: [{ id: "p1", text: "Chat system", status: "doing", children: [
  { id: "p86", text: "Chat service bugs", status: "doing", children: [
    { id: "p334", text: "send_message to a busy chat's worker times out at 30 s (Crawler VP 10-12 from 15:07Z)", status: "doing", children: [],
      job: "busy chat inbox", sessionId: "01a13117-6864-773c-91a8-0235380b9402" },
    { id: "p349", text: "Profile one chat service start", status: "doing", job: "service start profile", kind: "build", children: [],
      sessionId: "01a13117-d157-768f-955e-3a3e7b5288e3" },
    { id: "p350", text: "Relay the Chat system run's two asks to Crawler VP (clear waits on p42, p46 and p47, record two missed corrections) and frontend bro (rerun 5 jobs' checks now)",
      status: "done", job: "busy chat inbox", children: [], sessionId: "01a13117-6864-773c-91a8-0235380b9402" },
  ] },
] }] };

/** The daemon's subagents by parent session, as `rosterChildren` hands them over: the chat's own jobs, and the check-in job's. */
const roster = new Map<string, ChildAgent[]>([
  [CHAT, [
    { id: "sub-2b53f833", label: "stale tree sync", sessionName: "stale tree sync", sessionId: "01a13064-e102-72c9-97a3-4ac603994a72", status: "running", lastActivityAt: NOW - 60_000 },
    { id: "sub-5b41e80f", label: "grandchild job lookup", sessionName: "grandchild job lookup", sessionId: "01a1313a-f249-75eb-b6c1-840b14b358c5", status: "running", lastActivityAt: NOW - 60_000 },
  ]],
  [CHECK_IN, [
    { id: "sub-55d0ceb9", label: "busy chat inbox", sessionName: "busy chat inbox", sessionId: "01a13117-6864-773c-91a8-0235380b9402", status: "running", lastActivityAt: NOW - 120_000 },
    { id: "sub-064c854a", label: "send gap log", sessionName: "send gap log", sessionId: "01a13117-a117-718e-853c-000000000000", status: "done", lastActivityAt: NOW - 400_000 },
    { id: "sub-14aa31cd", label: "service start profile", sessionName: "service start profile", sessionId: "01a13117-d157-768f-955e-3a3e7b5288e3", status: "running", lastActivityAt: NOW - 60_000 },
  ]],
]);
const row = (over: Partial<SessionRow>): SessionRow => ({ id: "r", name: "row", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 1, working: false, subagentsRunning: 0,
  unread: false, tags: [], priority: 0, progress: "none", ...over });

test("check-in owners: a step owned by a subagent of the chat's check-in job resolves to that job (p334, p349, p350), not '(... not found)'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-job-owners-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => false,
    async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe() { return () => {}; },
  } as unknown as ChatThreads;
  const findings: string[] = [];
  const source: CheckInSource = {
    board: async () => board,
    rows: async () => [row({ id: CHAT, name: "AI harness developer environment VP", working: true }), row({ id: CHECK_IN, name: "check-in AI harness developer environment 01:54", working: true })],
    memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 0,
    duty: { async checkIn(_id, run) { findings.push(run.findings); } },
    dutyJobs: async () => [CHECK_IN],
  } as CheckInSource;
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await (chats as unknown as { roster(children: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(roster);
  await chats.runCheckIn(CHAT);
  await chats.settled();
  chats.close();
  assert.equal(findings.length, 1, "one check-in ran");
  const text = findings[0]!;
  assert.doesNotMatch(text, /not found/, text);
  assert.doesNotMatch(text, /p33[4]\b[^\n]*has no live owner|p349\b[^\n]*has no live owner/, text);
  assert.match(text, /busy chat inbox: working[^\n]*p334/, text);
  assert.match(text, /service start profile: working[^\n]*p349/, text);
});
