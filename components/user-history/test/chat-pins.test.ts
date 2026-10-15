import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { type CheckInSource, replyCheckRecord } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, SessionRow, ThreadMessage } from "../src/shared/types.ts";

// Every chat is pinned. Until 10-13 ThreadHub.pin refused past MAX_LIVE (8) pins, and the owner runs 9 chats: Crawler VP (01a115e2) was the one
// left out on every service start from 10-08 on ("chat 01a115e2: live limit reached, not pinned", 160 times in service.log). On 10-13 its turn
// failed at 10:06:10Z on the token hook, the daemon restarted at 10:09:05Z, the service resumed the 8 pinned chats only, and `revive` (which
// reads only an attached thread) never saw the failure: 1.8 h with no message until an agent message woke the session at 11:56:38Z
// (chat-health unretried_errors 1, dead_hours 1.8).

process.env.TZ = "Asia/Seoul";

const TOKEN_HOOK = "Failed to resolve API key for provider \"anthropic\" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token pi-pool: the token hook gave no token; the retry uses a new hook run.";
const CHATS = ["crawler", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

/** A hub whose attaches answer at once, with each thread's live snapshot built from `messages`. */
function hub(messages: (id: string) => ThreadMessage[]) {
  let fire: (event: { daemon: string }) => void = () => {};
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: "a-" + id, cwd: "/", lifecycle: "live" }),
    subscribe: (listener: typeof fire) => { fire = listener; return () => {}; } } as unknown as Catalog;
  const threads = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const connection = { subscribe: () => () => {}, dispose: async () => {}, setSteeringMode: async () => {} };
  const internals = threads as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(connection: unknown, summary: { sessionId: string }): Promise<unknown> };
  internals.attach = async () => connection;
  internals.liveSnapshot = async (_connection, summary) => ({ kind: "live", info: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 0 }, messages: messages(summary.sessionId), streaming: null,
    queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });
  return { threads, up: () => fire({ daemon: "up" }) };
}

test("thread hub: every chat stays pinned past 8, and after a daemon restart all 9 attach", async () => {
  const { threads, up } = hub(() => []);
  for (const id of CHATS) threads.pin(id);
  up();
  for (let wait = 0; wait < 20 && CHATS.some(id => !threads.isLive(id)); wait++) await flush();
  assert.deepEqual(CHATS.filter(id => !threads.isLive(id)), [], "the 9th chat attaches like the other 8");
  await threads.close();
});

test("thread hub: pinned chats do not count against the unpinned attach limit, so 9 pins do not close every other thread", async () => {
  const { threads, up } = hub(() => []);
  for (const id of CHATS) threads.pin(id);
  up();
  for (let wait = 0; wait < 20 && CHATS.some(id => !threads.isLive(id)); wait++) await flush();
  await threads.open("job1", true);
  await threads.open("job2", true);
  assert.equal(threads.isLive("job1"), true, "an attached job stays open when a second one attaches");
  await threads.close();
});

test("chats: replay of Crawler VP 10-13 10:06Z: the 9th chat in the index is pinned, comes back after the daemon restart, and its token hook failure restarts in 30 s", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-pins-"));
  const failedAt = Date.parse("2026-10-13T10:06:10.035Z");
  const failed: ThreadMessage[] = [
    { role: "user", content: "[check-in] Re-check the board.", timestamp: failedAt - 10_000 },
    { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason: "error", errorMessage: TOKEN_HOOK, timestamp: failedAt } as ThreadMessage,
  ];
  const { threads, up } = hub(id => id === "crawler" ? failed : []);
  const restarts: string[] = [];
  (threads as unknown as { restart(id: string, message: string): Promise<void> }).restart = async (id, message) => { restarts.push(`${id} ${message}`); };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of CHATS) await index.add(id);
  let now = Date.parse("2026-10-13T10:09:03.186Z");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [] };
  const source: CheckInSource = { board: async () => board, rows: async () => CHATS.map(id => ({ id, name: id }) as SessionRow), home: dir,
    memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")), settings: checkInSettings(join(dir, "check-in-settings.json")),
    tickMs: 0, now: () => now, noReportGraceMs: 0 };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  const { pinned } = await chats.adopt();
  assert.equal(pinned.length, 9);
  assert.equal(pinned.at(-1), "crawler", "Crawler VP is the oldest chat, last in pin order, as on 10-13");
  up();
  for (let wait = 0; wait < 20 && !threads.isLive("crawler"); wait++) await flush();
  assert.equal(threads.isLive("crawler"), true);
  for (let half = 0; half < 4 && !restarts.length; half++) {
    now += 30_000;
    await chats.tick();
    await chats.settled();
  }
  assert.deepEqual(restarts, [`crawler [check-in] Your last turn failed at 19:06 (${TOKEN_HOOK.slice(0, 159)}…). Re-check the board and continue.`]);
  chats.close();
  await threads.close();
});
