import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { checkInRecord } from "../src/chat-checkin.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { type ChatThreads, type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInSettings, clockTime } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { JOB_NOTICE_PREFIX } from "../src/shared/chat-feed.ts";
import type { ChildAgent } from "../src/shared/types.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

/**
 * Frontend bro's daemon worker stopped answering root-session requests (10-13), so every attach failed and the hub never told Chats its
 * children: the no-report notice, the brief check and the check-in gate lost the chat. The daemon's `list` still answers in about 540 ms with
 * every subagent row under the chat. These tests feed Chats from those rows with no attach at all.
 */
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const NOW = Date.parse("2026-10-13T02:00:00.000Z");

test("each catalog refresh hands Chats the subagents the daemon lists under every chat, with no attach", async t => {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const handed: ReadonlyMap<string, readonly ChildAgent[]>[] = [];
  const chats = { ids: async () => new Set([CHAT]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }),
    roster: async (children: ReadonlyMap<string, readonly ChildAgent[]>) => { handed.push(children); } };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  Object.defineProperty(catalog.client, "isConnected", { get: () => true });
  t.mock.method(catalog.client, "reconnect", async () => {});
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.after(() => catalog.close());
  const sessions = [
    { sessionId: CHAT, cwd: "/tmp", activeSessionId: "a-chat", messageCount: 10_854, sessionName: "frontend bro" },
    { sessionId: "s-1", cwd: "/tmp", activeSessionId: "a-1", messageCount: 40, parentSessionId: CHAT, rlmChildId: "child-1", sessionName: "inbox into staging",
      rosterStatus: "running", repliedSinceTask: false, lastActivityAt: "2026-10-13T01:58:00.000Z" },
    { sessionId: "s-2", cwd: "/tmp", sessionFile: "/s/s-2.jsonl", messageCount: 12, parentSessionId: CHAT, rlmChildId: "child-2", sessionName: "readme lines",
      repliedSinceTask: true, lastActivityAt: "2026-10-12T20:00:00.000Z" },
    { sessionId: "s-3", cwd: "/tmp", activeSessionId: "a-3", messageCount: 3, parentSessionId: "s-1", rlmChildId: "grandchild", sessionName: "deep", rosterStatus: "running" },
  ] as unknown as SessionSummary[];
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions } } : { success: true, data: { jobs: [] } });
  await catalog.refresh();
  await catalog.refresh("roster");
  assert.equal(handed.length, 2, "one hand-off per refresh");
  const children = handed.at(-1)!.get(CHAT);
  assert.deepEqual(children, [
    { id: "child-1", label: "inbox into staging", sessionName: "inbox into staging", sessionId: "s-1", status: "running", repliedSinceTask: false, lastActivityAt: Date.parse("2026-10-13T01:58:00.000Z") },
    { id: "child-2", label: "readme lines", sessionName: "readme lines", sessionId: "s-2", status: "done", repliedSinceTask: true, lastActivityAt: Date.parse("2026-10-12T20:00:00.000Z") },
  ], "the chat's direct subagents, as the hub would list them");
});

test("Chats takes a chat's children from the roster while the hub has no attach: links, the check-in gate and the no-report notice work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roster-children-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const prompts: string[] = [];
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => false,
    async restart() {}, async prompt(_id: string, input: { message: string }) { prompts.push(input.message); }, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe() { return () => {}; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async () => null, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 0,
  };
  const logged: string[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source, line => { logged.push(line); });
  const roster = chats as unknown as { roster(children: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> };
  const job = (status: ChildAgent["status"], repliedSinceTask: boolean, lastActivityAt: number): ChildAgent =>
    ({ id: "child-1", label: "inbox into staging", sessionName: "inbox into staging", status, repliedSinceTask, lastActivityAt });

  // The job finished its first task with a report, then got a follow-up, ran it, and stopped without a report.
  await roster.roster(new Map([[CHAT, [job("done", true, NOW - 600_000)]]]));
  assert.deepEqual((await chats.links(CHAT)).children.map(child => child.id), ["child-1"], "links lists the roster's children");
  await chats.runCheckIn(CHAT);
  assert.deepEqual(logged.filter(line => line.includes("check-in waits")), [], "the check-in reads the roster's children instead of waiting for an attach");
  await roster.roster(new Map([[CHAT, [job("running", false, NOW - 60_000)]]]));
  await roster.roster(new Map([[CHAT, [job("done", false, NOW - 30_000)]]]));
  await new Promise(resolve => setTimeout(resolve, 20));
  await chats.settled();
  chats.close();
  assert.equal(prompts.length, 1, "one no-report notice");
  assert.ok(prompts[0]!.startsWith(JOB_NOTICE_PREFIX) && prompts[0]!.includes("inbox into staging"), prompts[0]);
});

/**
 * VP of CI 10-13: the hub's attach kept job "repo rules check fix" at its 09:20:49Z end while it worked again from 09:45:10Z to 09:47:48Z,
 * and said it stopped at about 09:45:44Z, mid-tool. Its daemon row had the session file's newer activity and its running turn. The hub told
 * the chat "ended at 18:20 with no report" (queued 09:47:14Z). An attached chat now takes each child's clock and running turn from its row too.
 */
test("an attached chat's children take the daemon row's later activity and running turn: no notice mid-work, and the end it names is the real one (VP of CI 10-13)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roster-live-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const prompts: string[] = [];
  let observer: Parameters<ChatThreads["observe"]>[0] | undefined;
  const threads = {
    state: () => undefined, async view() { return null; }, busy: () => false, running: () => false, setWait() {}, isLive: () => true,
    async restart() {}, async prompt(_id: string, input: { message: string }) { prompts.push(input.message); }, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe(next: Parameters<ChatThreads["observe"]>[0]) { observer = next; return () => {}; },
  } as unknown as ChatThreads;
  let now = Date.parse("2026-10-13T09:45:44.000Z");
  const source: CheckInSource = {
    board: async () => null, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => now, noReportGraceMs: 0,
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  const roster = chats as unknown as { roster(children: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> };
  const name = "repo rules check fix";
  const stale = Date.parse("2026-10-13T09:20:49.126Z");
  const attach = (activity: ChildAgent["activity"]): ChildAgent =>
    ({ id: "sub-17eba397", label: name, sessionName: name, status: "done", repliedSinceTask: false, lastActivityAt: stale, ...(activity ? { activity } : {}) });
  const row = (status: ChildAgent["status"], at: string): ChildAgent =>
    ({ id: "sub-17eba397", label: name, sessionName: name, sessionId: "01a133a3", status, repliedSinceTask: false, lastActivityAt: Date.parse(at) });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 20)); await chats.settled(); };

  await chats.links(CHAT);
  observer!.live(CHAT, [attach({ kind: "waiting" })]);
  await roster.roster(new Map([[CHAT, [row("running", "2026-10-13T09:45:33.530Z")]]]));
  observer!.children(CHAT, [attach(undefined)]);
  await settle();
  assert.equal(prompts.length, 0, "the row shows the job mid-turn, so the attach's stop is no end");
  assert.equal((await chats.links(CHAT)).children[0]!.lastActivityAt, Date.parse("2026-10-13T09:45:33.530Z"), "the clock is the row's, not the attach's 09:20:49Z");

  now = Date.parse("2026-10-13T09:48:10.000Z");
  await roster.roster(new Map([[CHAT, [row("done", "2026-10-13T09:47:48.709Z")]]]));
  await settle();
  chats.close();
  assert.equal(prompts.length, 1, "one notice, once the row shows the turn ended");
  assert.ok(prompts[0]!.includes(`ended at ${clockTime(Date.parse("2026-10-13T09:47:48.709Z"))}`), prompts[0]);
  assert.ok(!prompts[0]!.includes(`ended at ${clockTime(stale)}`), prompts[0]);
});
