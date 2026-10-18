import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
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

const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: T0, plan: [{ id: "p1", text: "Chat system", status: "doing", children: [
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

/** One check-in of `chat` with no hub attach: Chats takes its children from `roster`, and the findings handed to the duty runner come back. */
async function checkInFindings(chat: string, board: ChatBoard, rows: SessionRow[], roster: ReadonlyMap<string, readonly ChildAgent[]>, now: number,
  more: Partial<CheckInSource> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "checkin-job-owners-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(chat);
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => false,
    async restart() {}, async prompt() {}, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe() { return () => {}; },
  } as unknown as ChatThreads;
  const findings: string[] = [];
  const source: CheckInSource = {
    board: async () => board, rows: async () => rows,
    memory: checkInRecord(join(dir, "check-ins.json")), settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => now, noReportGraceMs: 0,
    duty: { async checkIn(_id, run) { findings.push(run.findings); }, async lastCheckIn() { return undefined; } }, ...more,
  } as CheckInSource;
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await (chats as unknown as { roster(children: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(roster);
  await chats.runCheckIn(chat);
  await chats.settled();
  chats.close();
  assert.equal(findings.length, 1, "one check-in ran");
  return findings[0]!;
}

test("check-in owners: a step owned by a subagent of the chat's check-in job resolves to that job (p334, p349, p350), not '(... not found)'", async () => {
  const rows = [row({ id: CHAT, name: "AI harness developer environment VP", working: true }), row({ id: CHECK_IN, name: "check-in AI harness developer environment 01:54", working: true })];
  const text = await checkInFindings(CHAT, board, rows, roster, NOW, { dutyJobs: async () => [CHECK_IN] });
  assert.doesNotMatch(text, /not found/, text);
  assert.doesNotMatch(text, /p33[4]\b[^\n]*has no live owner|p349\b[^\n]*has no live owner/, text);
  assert.match(text, /busy chat inbox: working[^\n]*p334/, text);
  assert.match(text, /service start profile: working[^\n]*p349/, text);
});

/**
 * frontend bro 10-13 02:39 and 02:57 KST: the check-in flagged p92 to p97 as orphans, "(job connections from scratch idle)" and so on, 3 runs in a
 * row. Each job ends its turn while its own workers run (browser checkers, fix jobs), so the daemon lists the job itself as idle. The steps,
 * ids and names are the real ones; the daemon rows are the live ones of 03:03 KST, with each job between turns and last active 20 min before
 * (inbox into staging 2 min before, its real session change). p94 was still doing then.
 */
const FRONTEND = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const FRONTEND_NOW = Date.parse("2026-10-12T18:03:15.000Z");
const frontendBoard: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: T0, plan: [{ id: "p103", text: "Demo work in flight on 5180", status: "doing", children: [
  { id: "p92", text: "Connections from the shipped screen: delete every old version, then polish the shipped Connections screen part by part (list, connect flow including connecting mid-task, choosing a sender, health and reconnect and disconnect) until it covers every connection the product supports, each part built for Jiwon's task with the Watchlist patterns you liked",
    status: "doing", job: "connections from scratch", sessionId: "01a1301b-e144-7579-b2fc-e399d201140a", children: [] },
  { id: "p93", text: "Email from the current Staging screen: polish 5 parts one at a time (template list, new template flow, editor, sending, A/B testing), each built for Jiwon's canonical task and the Watchlist patterns you liked",
    status: "doing", job: "email from shipped", sessionId: "01a1301b-e9cc-748c-94ff-b9aaa3c84c77", children: [] },
  { id: "p94", text: "Inbox into Staging: your pick gmail (no split, default density), restyled with Virev's own components, built around Contacts (one person or brand with several accounts and ways to reach them, each account tied to a crawler-v3 profile), with the contact panel moved behind a See profile popup showing every account's feed",
    status: "doing", job: "inbox into staging", sessionId: "01a1301b-ecec-717d-96e3-fa4d913b8c16", children: [] },
  { id: "p95", text: "Home into Staging: brief made scrollable, any date range, configurable charts, a daily AI report, competitor story popups, Overlap, a request form and a live feel; plus creators working with us (clicks, sales, GMV, payouts), an outreach funnel viewer and a live monitoring stream; plus 2 or 3 story-format versions",
    status: "doing", job: "home into staging", sessionId: "01a1301b-fb97-75c9-8ca2-dfd5c49d1ed6", children: [] },
  { id: "p97", text: "Creators demos like a real product: a lists page with funnel numbers, a review where the email finder and AI columns fill in live as the crawler runs, Send email through a chosen template, list Settings with auto-send, default AI columns (group-buy creator, skin tone), one simple canonical flow",
    status: "doing", job: "creators product demos", sessionId: "01a1301c-1a94-72ac-a475-11691ba86755", children: [] },
] }] };
const sub = (id: string, name: string, sessionId: string, status: ChildAgent["status"], at: string): ChildAgent =>
  ({ id, label: name, sessionName: name, sessionId, status, lastActivityAt: Date.parse(at) });
/** Every job idle between turns. connections, email, home and creators each have a worker at work; inbox has none, and its session changed 2 min ago. */
const frontendRoster = new Map<string, ChildAgent[]>([
  [FRONTEND, [
    sub("sub-e063a6b5", "connections from scratch", "01a1301b-e144-7579-b2fc-e399d201140a", "done", "2026-10-12T17:43:00.304Z"),
    sub("sub-e6bb7e96", "email from shipped", "01a1301b-e9cc-748c-94ff-b9aaa3c84c77", "done", "2026-10-12T17:42:39.339Z"),
    sub("sub-f5f4efcf", "inbox into staging", "01a1301b-ecec-717d-96e3-fa4d913b8c16", "done", "2026-10-12T18:01:16.076Z"),
    sub("sub-325155bc", "home into staging", "01a1301b-fb97-75c9-8ca2-dfd5c49d1ed6", "done", "2026-10-12T17:40:53.863Z"),
    sub("sub-13fbd2e1", "creators product demos", "01a1301c-1a94-72ac-a475-11691ba86755", "done", "2026-10-12T17:41:50.143Z"),
  ]],
  ["01a1301b-e144-7579-b2fc-e399d201140a", [
    sub("sub-dd00abb7", "conn-browser", "01a130bb-ee81-719c-853f-e9641860c63e", "running", "2026-10-12T18:02:53.759Z"),
    sub("sub-fd5e9eaa", "conn-fix-picked", "01a13126-3a25-70b9-86b3-ac920d269d64", "running", "2026-10-12T18:03:08.525Z"),
    sub("sub-bde2906e", "conn-audit", "01a130bb-720c-731a-bd2f-d2a562f7904b", "done", "2026-10-12T17:30:22.578Z"),
  ]],
  ["01a1301b-e9cc-748c-94ff-b9aaa3c84c77", [
    sub("sub-10f3fe3f", "email-browser-check", "01a130d0-0926-715d-87be-9ad236ff5c28", "running", "2026-10-12T18:01:59.531Z"),
    sub("sub-6caacfd8", "email-send-job", "01a13139-61b6-7320-b693-b1a833cd7d21", "running", "2026-10-12T18:02:45.524Z"),
    sub("sub-65a5e052", "email-sender-fix", "01a130ea-d36e-70ab-92a5-378a1eb7c367", "done", "2026-10-12T17:02:36.144Z"),
  ]],
  ["01a1301b-ecec-717d-96e3-fa4d913b8c16", [
    sub("sub-b5779963", "inbox-p8-walk", "01a130b7-8199-759c-9c92-9e8f90f2dc84", "done", "2026-10-12T17:59:21.126Z"),
  ]],
  ["01a1301b-fb97-75c9-8ca2-dfd5c49d1ed6", [
    sub("sub-4cf4980c", "home-p8-polish", "01a13134-20f9-7046-bb23-110398f2d697", "running", "2026-10-12T18:03:00.626Z"),
    sub("sub-fb579a04", "home-p7-browser", "01a130c4-51c6-725b-a602-64402332ab0e", "done", "2026-10-12T17:40:15.818Z"),
  ]],
  ["01a1301c-1a94-72ac-a475-11691ba86755", [
    sub("sub-0ce8c378", "creators-check", "01a13142-d01e-72ba-920f-ad881cf17a06", "running", "2026-10-12T18:03:08.734Z"),
  ]],
]);

test("check-in owners: a job between turns counts as working while a worker below it runs or its session changed within the check-in interval (frontend bro p92 to p97)", async () => {
  const text = await checkInFindings(FRONTEND, frontendBoard, [row({ id: FRONTEND, name: "frontend bro", working: true })], frontendRoster, FRONTEND_NOW);
  assert.doesNotMatch(text, /has no live owner/, text);
  for (const [job, step] of [["connections from scratch", "p92"], ["email from shipped", "p93"], ["inbox into staging", "p94"], ["home into staging", "p95"], ["creators product demos", "p97"]]) {
    assert.match(text, new RegExp(`job ${job}: working[^\\n]*${step}\\b`), text);
  }
});
