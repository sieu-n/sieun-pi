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
import type { ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";

// Every chat is pinned (ea83c53), and a pin is an attached daemon client. Prime 0.9.8 evicts a worker tree only when no session in it has a
// client and all of it idled for idleEvictionMinutes (default 90), so no chat worker was ever evicted. The hub now detaches a pinned chat once
// its whole tree rested that long, and attaches it again on its next prompt, tab, notice or session activity.

process.env.TZ = "Asia/Seoul";

const MIN = 60_000;
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const flush = () => new Promise(resolve => setTimeout(resolve, 5));
const TOKEN_HOOK = "Failed to resolve API key for provider \"anthropic\" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token pi-pool: the token hook gave no token; the retry uses a new hook run.";

type Summary = { sessionId: string; activeSessionId?: string; cwd: string; lifecycle: string; sessionFile: string; lastActivityAt?: string; isSessionActive: boolean;
  activity: string; isStreaming: boolean; hasRunningRlmChildren: boolean };
type Connection = { prompts: string[]; disposed: boolean };

/**
 * A hub on a fake daemon: each attach makes a new connection that records its prompts, and `create` (a resume of a session with no worker)
 * gives the session an active id. `children` and `messages` build each live snapshot; `saved` builds the snapshot read from the session file.
 */
function hub(options: { children?: (id: string) => ChildAgent[]; messages?: (id: string) => ThreadMessage[]; held?: (id: string) => Promise<boolean>; minutes?: number | "off";
  summaries?: Record<string, Partial<Summary>> } = {}) {
  let now = T0;
  let fire: (event: { daemon: string; sessions?: Partial<SessionRow>[] }) => void = () => {};
  const summaries = new Map<string, Summary>();
  const summary = (id: string): Summary => {
    let found = summaries.get(id);
    if (!found) {
      found = { sessionId: id, activeSessionId: "a-" + id, cwd: "/", lifecycle: "live", sessionFile: "/nonexistent/" + id + ".jsonl", isSessionActive: false, activity: "idle",
        isStreaming: false, hasRunningRlmChildren: false, ...options.summaries?.[id] };
      summaries.set(id, found);
    }
    return found;
  };
  const requests: string[] = [];
  const client = { request: async (command: { type: string; sessionPath?: string }) => {
    requests.push(command.type);
    if (command.type === "create") {
      const id = [...summaries.values()].find(row => row.sessionFile === command.sessionPath)!.sessionId;
      summary(id).activeSessionId = "a2-" + id;
      return { success: true, data: { sessionId: id, activeSessionId: "a2-" + id } };
    }
    return { success: true, data: {} };
  } };
  const catalog = { summary: async (id: string) => summary(id), refresh: async () => {}, connect: async () => {}, client,
    subscribe: (listener: typeof fire) => { fire = listener; return () => {}; } } as unknown as Catalog;
  const threads = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), undefined,
    { minutes: () => options.minutes ?? 90, now: () => now, ...(options.held ? { held: options.held } : {}) });
  const connections: Connection[] = [];
  const internals = threads as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(connection: unknown, summary: { sessionId: string }): Promise<unknown>;
    savedSnapshot(summary: { sessionId: string }): Promise<unknown>; rest(): Promise<void> };
  internals.attach = async () => {
    const record: Connection = { prompts: [], disposed: false };
    connections.push(record);
    return { subscribe: () => () => {}, dispose: async () => { record.disposed = true; }, setSteeringMode: async () => {}, getHeartbeat: async () => undefined, reload: async () => {},
      getQueue: async () => ({ steering: [], followUp: [] }), prompt: async (message: string) => { record.prompts.push(message); } };
  };
  const snapshot = (kind: "live" | "saved", id: string) => ({ kind, info: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 0 },
    messages: options.messages?.(id) ?? [], streaming: null, queue: { steering: [], followUp: [] }, children: kind === "live" ? options.children?.(id) ?? [] : [], tools: [], retry: null, runStartedAt: null });
  internals.liveSnapshot = async (_connection, row) => snapshot("live", row.sessionId);
  internals.savedSnapshot = async row => snapshot("saved", row.sessionId);
  const live = async (id: string) => { for (let wait = 0; wait < 40 && !threads.isLive(id); wait++) await flush(); return threads.isLive(id); };
  return { threads, connections, requests, summary, live, rest: () => internals.rest(), at: (ms: number) => { now = ms; }, now: () => now,
    fire: (sessions?: Partial<SessionRow>[]) => fire({ daemon: "up", ...(sessions ? { sessions } : {}) }) };
}

/** A pinned chat attached at T0 and then left idle. */
async function attached(fake: ReturnType<typeof hub>, id = "c1") {
  fake.threads.pin(id);
  fake.fire();
  assert.equal(await fake.live(id), true);
  return fake;
}

test("thread hub: an idle pinned chat detaches after the daemon's 90 idle minutes, and not one minute before", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 89 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "at 89 min the chat stays attached");
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false);
  assert.equal(fake.threads.isDormant("c1"), true);
  assert.equal(fake.connections[0]!.disposed, true, "the hub's daemon client is gone, so the daemon can evict the worker");
  assert.ok(fake.threads.state("c1"), "the chat keeps its last state for revive");
  await fake.threads.close();
});

test("thread hub: idleEvictionMinutes off never detaches a chat", async () => {
  const fake = await attached(hub({ minutes: "off" }));
  fake.at(T0 + 48 * 60 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true);
  await fake.threads.close();
});

test("thread hub: a message to a dormant chat attaches it again and its turn gets the prompt", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 95 * MIN);
  await fake.rest();
  await fake.threads.prompt("c1", { message: "hi again", images: [], mode: "steer" });
  assert.equal(fake.threads.isLive("c1"), true);
  assert.equal(fake.threads.isDormant("c1"), false);
  assert.equal(fake.connections.length, 2);
  assert.deepEqual(fake.connections[1]!.prompts, ["hi again"]);
  fake.at(T0 + 95 * MIN + 89 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "the idle time counts again from the reattach");
  await fake.threads.close();
});

test("thread hub: a tab opening a dormant chat attaches it again, and the tab's close starts the idle time over", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  const events: string[] = [];
  const close = await fake.threads.subscribe("c1", event => { events.push(event.type); });
  assert.equal(await fake.live("c1"), true);
  assert.deepEqual(events, ["snapshot", "snapshot"], "the saved state at once, then the live snapshot");
  fake.at(T0 + 300 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "an open tab holds the chat");
  close();
  fake.at(T0 + 300 * MIN + 89 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true);
  fake.at(T0 + 300 * MIN + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false);
  await fake.threads.close();
});

test("thread hub: a chat with a running child never detaches, and a running duty holds it too", async () => {
  const child: ChildAgent = { id: "k1", label: "job", status: "running" };
  const fake = await attached(hub({ children: id => id === "c1" ? [child] : [], held: async id => id === "c2" }));
  await attached(fake, "c2");
  fake.at(T0 + 24 * 60 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "a running child holds the tree");
  assert.equal(fake.threads.isLive("c2"), true, "a duty that starts or runs holds the chat");
  await fake.threads.close();
});

test("thread hub: the catalog showing a dormant chat's session at work attaches it again, and a saved row with a newer file time does not", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  fake.fire([{ id: "c1", kind: "saved", working: false, lastActivityAt: new Date(T0 + 92 * MIN).toISOString() }]);
  await flush();
  assert.equal(fake.threads.isLive("c1"), false, "an evicted worker's row stays dormant");
  fake.fire([{ id: "c1", kind: "live", working: false, lastActivityAt: new Date(T0 + 80 * MIN).toISOString() }]);
  await flush();
  assert.equal(fake.threads.isLive("c1"), false, "the resident worker before the daemon's sweep shows no new activity");
  fake.fire([{ id: "c1", kind: "live", working: true, lastActivityAt: new Date(T0 + 93 * MIN).toISOString() }]);
  assert.equal(await fake.live("c1"), true, "an agent message woke the session, so the hub attaches it");
  assert.equal(fake.connections.length, 2);
  await fake.threads.close();
});

test("thread hub: a turn that ran and ended between two catalog updates still wakes the dormant chat", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  fake.fire([{ id: "c1", kind: "live", working: false, lastActivityAt: new Date(T0 + 91 * MIN).toISOString() }]);
  assert.equal(await fake.live("c1"), true);
  await fake.threads.close();
});

test("thread hub: the finished-job cleanup does not attach a dormant chat (10-14 23:19Z: it woke slack green guy 7 s after the service start left it detached)", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true);
  await assert.rejects(fake.threads.deleteSubagent("c1", "job1"), /dormant/);
  assert.equal(fake.connections.length, 1, "the delete did not attach the chat");
  assert.equal(fake.threads.isDormant("c1"), true);
  assert.equal(fake.requests.includes("delete_rlm_subagent"), false);
  await fake.threads.close();
});

test("thread hub: a dormant chat that wakes mid-turn starts its quiet time at the attach, so the hung-turn check does not count its dormant minutes (slack green guy 10-14 00:47Z: woken by catalog after 75 min, then stopped as hung 76 min)", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  const thread = (fake.threads as unknown as { threads: Map<string, { lastEventAt: number }> }).threads.get("c1")!;
  thread.lastEventAt = Date.now() - 76 * MIN;
  const before = Date.now();
  fake.fire([{ id: "c1", kind: "live", working: true }]);
  assert.equal(await fake.live("c1"), true);
  assert.ok(thread.lastEventAt >= before, "the attach restarted the quiet time");
  await fake.threads.close();
});

test("thread hub and chats: reads and ticks do not attach a dormant chat, and a daemon restart skips it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-idle-"));
  const fake = await attached(hub());
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [] };
  const source: CheckInSource = { board: async () => board, rows: async () => [{ id: "c1", name: "c1" } as SessionRow], home: dir,
    memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")), settings: checkInSettings(join(dir, "check-in-settings.json")),
    tickMs: 0, now: fake.now, noReportGraceMs: 0 };
  const chats = new Chats(index, fake.threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  await chats.settled();
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true);
  assert.equal(await fake.threads.view("c1"), null);
  await fake.threads.open("c1", true);
  await fake.threads.warm("c1");
  for (let tick = 0; tick < 4; tick++) {
    fake.at(T0 + (91 + tick) * MIN);
    await chats.tick();
    await chats.settled();
  }
  fake.fire();
  await flush();
  assert.equal(fake.connections.length, 1, "no read, tick or daemon restart attached the chat again");
  assert.equal(fake.threads.isDormant("c1"), true);
  chats.close();
  await fake.threads.close();
});

test("chats: replay of a daemon restart with Crawler VP's failed turn 2 h old: the chat opens saved and stays detached, and the check-in tick's revive attaches it and restarts the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-idle-"));
  const failedAt = T0 - 120 * MIN;
  const failed: ThreadMessage[] = [
    { role: "user", content: "[check-in] Re-check the board.", timestamp: failedAt - 10_000 },
    { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason: "error", errorMessage: TOKEN_HOOK, timestamp: failedAt } as ThreadMessage,
  ];
  const restedFor = { lastActivityAt: new Date(failedAt).toISOString() };
  const fake = hub({ messages: id => id === "crawler" ? failed : [], summaries: { crawler: { ...restedFor }, quiet: { ...restedFor }, busy: { lastActivityAt: new Date(T0 - 5 * MIN).toISOString() } } });
  for (const id of ["crawler", "quiet", "busy"]) delete fake.summary(id).activeSessionId;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["crawler", "quiet", "busy"]) await index.add(id);
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [] };
  const source: CheckInSource = { board: async () => board, rows: async () => ["crawler", "quiet", "busy"].map(id => ({ id, name: id }) as SessionRow), home: dir,
    memory: checkInRecord(join(dir, "check-ins.json")), replyChecks: replyCheckRecord(join(dir, "reply-checks.json")), settings: checkInSettings(join(dir, "check-in-settings.json")),
    tickMs: 0, now: fake.now, noReportGraceMs: 0 };
  const chats = new Chats(index, fake.threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  await chats.adopt();
  fake.fire();
  assert.equal(await fake.live("busy"), true, "a chat that worked 5 min ago resumes as in ea83c53");
  for (let wait = 0; wait < 40 && !(fake.threads.isDormant("crawler") && fake.threads.isDormant("quiet")); wait++) await flush();
  assert.equal(fake.threads.isDormant("quiet"), true, "an idle chat with no worker is not loaded again");
  assert.equal(fake.threads.isDormant("crawler"), true);
  assert.equal(fake.connections.length, 1);
  for (let half = 0; half < 4 && fake.connections.length < 2; half++) {
    fake.at(fake.now() + 30_000);
    await chats.tick();
    await chats.settled();
  }
  assert.equal(fake.threads.isLive("crawler"), true);
  assert.equal(fake.threads.isDormant("quiet"), true, "the tick leaves the idle chat with a good last turn alone");
  assert.equal(fake.requests.filter(type => type === "create").length, 2, "workers started again for the busy chat and the failed one only");
  assert.match(fake.connections[1]!.prompts[0] ?? "", /^\[check-in\] Your last turn failed at 07:00 /);
  chats.close();
  await fake.threads.close();
});
