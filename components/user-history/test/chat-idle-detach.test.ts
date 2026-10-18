import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { CHILD_SILENT_MS } from "../src/chat-dormancy.ts";
import { type CheckInSource } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, ChildAgent, SessionRow, ThreadEvent, ThreadMessage } from "../src/shared/types.ts";

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
type Connection = { prompts: string[]; notices: string[]; disposed: boolean; emit: (event: unknown) => void };

/**
 * A hub on a fake daemon: each attach makes a new connection that records its prompts, and `create` (a resume of a session with no worker)
 * gives the session an active id. `children` and `messages` build each live snapshot; `saved` builds the snapshot read from the session file.
 */
function hub(options: { children?: (id: string) => ChildAgent[]; messages?: (id: string) => ThreadMessage[]; held?: (id: string) => Promise<boolean>; minutes?: number | "off";
  summaries?: Record<string, Partial<Summary>>; file?: string; childTimes?: Record<string, number[]> } = {}) {
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
  const catalog = { summary: async (id: string) => summary(id), refresh: async () => {}, connect: async () => {}, hostOf: () => null, daemonPath: (row: { sessionFile?: string }) => row.sessionFile, client, childActivity: (id: string) => options.childTimes?.[id] ?? [],
    subscribe: (listener: typeof fire) => { fire = listener; return () => {}; } } as unknown as Catalog;
  const threads = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), undefined,
    { minutes: () => options.minutes ?? 90, now: () => now, ...(options.held ? { held: options.held } : {}), ...(options.file ? { file: options.file } : {}) });
  const connections: Connection[] = [];
  const internals = threads as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(connection: unknown, summary: { sessionId: string }): Promise<unknown>;
    savedSnapshot(summary: { sessionId: string }): Promise<unknown>; rest(): Promise<void> };
  internals.attach = async () => {
    const record: Connection = { prompts: [], notices: [], disposed: false, emit: () => {} };
    connections.push(record);
    return { subscribe: (listener: (event: unknown) => void) => { record.emit = listener; return () => {}; }, dispose: async () => { record.disposed = true; }, setSteeringMode: async () => {}, getHeartbeat: async () => undefined, reload: async () => {},
      getQueue: async () => ({ steering: [], followUp: [] }), prompt: async (message: string) => { record.prompts.push(message); },
      appendCustomMessage: async (message: { content: string }) => { record.notices.push(message.content); } };
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
  fake.at(T0 + 120 * MIN);
  close();
  fake.at(T0 + 120 * MIN + 89 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true);
  fake.at(T0 + 120 * MIN + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false);
  await fake.threads.close();
});

test("thread hub: an open tab does not hold an idle chat: it detaches at its idle time from the tab's open, and the tab gets the snapshot when a message wakes it (frontend bro 10-14: a tab open from 16:02Z held its 4.3 GB worker through a 74 min idle spell)", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 30 * MIN);
  const tab: ThreadEvent[] = [];
  await fake.threads.subscribe("c1", event => { tab.push(event); });
  fake.at(T0 + 30 * MIN + 89 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "opening the tab counts as activity");
  fake.at(T0 + 30 * MIN + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true, "the open tab does not hold the chat");
  assert.equal(fake.connections[0]!.disposed, true, "the hub's daemon client is gone, so the daemon can evict the worker");
  const before = tab.length;
  await fake.threads.prompt("c1", { message: "status?", images: [], mode: "steer" });
  assert.equal(fake.threads.isLive("c1"), true);
  assert.deepEqual(fake.connections[1]!.prompts, ["status?"]);
  assert.ok(tab.slice(before).some(event => event.type === "snapshot"), "the open tab gets the live snapshot after the wake");
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
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [] };
  const source: CheckInSource = { board: async () => board, rows: async () => [{ id: "c1", name: "c1" } as SessionRow], home: dir,
    memory: checkInRecord(join(dir, "check-ins.json")), settings: checkInSettings(join(dir, "check-in-settings.json")),
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
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [] };
  const source: CheckInSource = { board: async () => board, rows: async () => ["crawler", "quiet", "busy"].map(id => ({ id, name: id }) as SessionRow), home: dir,
    memory: checkInRecord(join(dir, "check-ins.json")), settings: checkInSettings(join(dir, "check-in-settings.json")),
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

/** The hub's thread for `id`, to send it the child updates its daemon connection would. */
const threadOf = (fake: ReturnType<typeof hub>, id = "c1") =>
  (fake.threads as unknown as { threads: Map<string, { broadcast(event: ThreadEvent): void }> }).threads.get(id)!;
const childUpdate = (child: ChildAgent): ThreadEvent => ({ type: "event", event: { type: "rlm_child_update", child } });
/** A chat row in the catalog whose one job runs, last active at `at`. */
const jobRow = (at: number): Partial<SessionRow> => ({ id: "c1", kind: "live", status: "idle", working: true, lastActivityAt: new Date(T0 - 60 * MIN).toISOString(),
  agents: [{ key: "child:k1", childId: "k1", name: "stuck job", job: "stuck job", sender: "stuck job", link: "subagent", state: "working", steps: [],
    lastActivityAt: new Date(at).toISOString() } satisfies ChatAgent] });

test("thread hub: a chat whose only running child went silent past CHILD_SILENT_MS detaches, its repeated child entries do not restart the idle time, and it gets one notice naming the child (10-14 08:17 KST: 8 of 9 chat trees held running or stale children and never detached)", async () => {
  assert.equal(CHILD_SILENT_MS, 180 * MIN);
  const child: ChildAgent = { id: "k1", label: "stuck job", status: "running", lastActivityAt: T0 - 120 * MIN };
  const fake = await attached(hub({ children: () => [child] }));
  fake.at(T0 + 50 * MIN);
  threadOf(fake).broadcast(childUpdate({ ...child }));
  threadOf(fake).broadcast({ type: "snapshot", snapshot: { ...fake.threads.state("c1")!, children: [{ ...child }] } });
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false, "the silent child no longer holds the chat");
  assert.equal(fake.threads.isDormant("c1"), true);
  const notices = fake.connections[0]!.notices;
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /^\[job\] stuck job \(k1\) is silent since 07:00, 210 min, so it no longer holds this chat attached\. .*rlm\.delete_subagent.*agent_message\.send/);
  fake.fire([jobRow(T0 - 120 * MIN)]);
  await flush();
  assert.equal(fake.threads.isLive("c1"), false, "a row at work only through the silent job does not wake the chat");
  await fake.threads.close();
});

test("thread hub: the daemon unloading an idle done job and the cleanup deleting a finished one do not restart the chat's idle time, and a job that works again does (10-14 23:2x KST: no VP chat detached in 54,645 service log lines, and every rlm_child_update, a passivation or a delete included, reset the idle clock)", async () => {
  const done = (id: string): ChildAgent => ({ id, label: "done " + id, status: "done", repliedSinceTask: true, lastActivityAt: T0 - 5 * MIN, activity: { kind: "waiting" } });
  const fake = await attached(hub({ children: () => [done("k1"), done("k2")] }));
  const native = (child: ChildAgent) => fake.connections[0]!.emit({ type: "session_event", event: { type: "rlm_child_update", child } });
  fake.at(T0 + 60 * MIN);
  native({ id: "k1", label: "done k1", status: "done", repliedSinceTask: true });
  fake.at(T0 + 70 * MIN);
  native({ ...done("k2"), status: "cancelled" });
  await flush();
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false, "the unload at 60 min and the delete at 70 min left the idle clock at the attach");
  assert.equal(fake.threads.isDormant("c1"), true);
  await fake.threads.close();

  const again = await attached(hub({ children: () => [done("k1")] }));
  again.at(T0 + 60 * MIN);
  again.connections[0]!.emit({ type: "session_event", event: { type: "rlm_child_update", child: { ...done("k1"), status: "running", lastActivityAt: T0 + 60 * MIN } } });
  again.connections[0]!.emit({ type: "session_event", event: { type: "rlm_child_update", child: { ...done("k1"), lastActivityAt: T0 + 61 * MIN } } });
  await flush();
  again.at(T0 + 90 * MIN);
  await again.rest();
  assert.equal(again.threads.isLive("c1"), true, "the job's new turn at 60 min restarted the idle time");
  again.at(T0 + 151 * MIN);
  await again.rest();
  assert.equal(again.threads.isLive("c1"), false, "90 min after its last activity the chat detaches");
  await again.threads.close();
});

test("thread hub: a chat whose job the daemon shows running, though the hub's own record of it is done, is not detached, so the catalog does not attach it again 0 min later (SEO guy 22:56 and slack green guy 23:09 KST on 10-14: 'dormant 01a11a24: idle 30 min, detached' then 'wake 01a11a24: catalog, dormant 0 min', 6 of the last 10 detaches)", async () => {
  const stale: ChildAgent = { id: "k1", label: "creator count copy fix", status: "done", repliedSinceTask: true, lastActivityAt: T0 - 5 * MIN };
  const fake = await attached(hub({ children: () => [stale] }));
  fake.fire([jobRow(T0 + 85 * MIN)]);
  await flush();
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), false, "the catalog shows the job at work, so the chat stays attached");
  assert.equal(fake.threads.isLive("c1"), true);
  assert.equal(fake.connections.length, 1, "no detach and no attach again");
  fake.fire([{ ...jobRow(T0 + 85 * MIN), working: false, agents: [] }]);
  await flush();
  fake.at(T0 + 91 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true, "once the catalog shows it resting, it detaches");
  fake.fire([{ id: "c1", kind: "live", status: "running", working: true, lastActivityAt: new Date(T0 + 92 * MIN).toISOString() }]);
  assert.equal(await fake.live("c1"), true, "a real new turn still wakes it");
  await fake.threads.close();
});

test("thread hub: a running child silent for less than CHILD_SILENT_MS still holds its chat, and detaches it once it reaches the limit", async () => {
  const child: ChildAgent = { id: "k1", label: "slow job", status: "running", lastActivityAt: T0 - 80 * MIN };
  const fake = await attached(hub({ children: () => [child] }));
  fake.at(T0 + 99 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "silent 179 min holds the chat");
  assert.deepEqual(fake.connections[0]!.notices, []);
  fake.at(T0 + 100 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false, "silent 180 min no longer does");
  await fake.threads.close();
});

test("thread hub: a silent child gets its notice once: a second detach in the same silent spell sends none, and neither does a service start whose transcript already holds it", async () => {
  const child: ChildAgent = { id: "k1", label: "stuck job", status: "running", lastActivityAt: T0 - 120 * MIN };
  const fake = await attached(hub({ children: () => [child] }));
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  const told = fake.connections[0]!.notices;
  assert.equal(told.length, 1);
  await fake.threads.prompt("c1", { message: "hi again", images: [], mode: "steer" });
  fake.at(T0 + 180 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false);
  assert.deepEqual(fake.connections[1]!.notices, [], "the same silent spell is not told twice");
  await fake.threads.close();

  const restarted = await attached(hub({ children: () => [child], messages: () => [{ role: "custom", customType: "chat_notice", content: told[0]!, timestamp: T0 } as ThreadMessage] }));
  restarted.at(T0 + 90 * MIN);
  await restarted.rest();
  assert.equal(restarted.threads.isLive("c1"), false);
  assert.deepEqual(restarted.connections[0]!.notices, [], "the transcript holds the notice from before the service start");
  await restarted.threads.close();
});

test("thread hub: a silent child that works again counts again: the catalog wakes its dormant chat, it holds the chat until it is silent past the limit again, and that new silent spell gets its own notice", async () => {
  const child: ChildAgent = { id: "k1", label: "stuck job", status: "running", lastActivityAt: T0 - 120 * MIN };
  const fake = await attached(hub({ children: () => [{ ...child }] }));
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true);
  fake.at(T0 + 95 * MIN);
  child.lastActivityAt = T0 + 95 * MIN;
  fake.fire([jobRow(T0 + 95 * MIN)]);
  assert.equal(await fake.live("c1"), true, "the job at work again wakes the chat");
  fake.at(T0 + 95 * MIN + 179 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), true, "the job counts as running again");
  fake.at(T0 + 95 * MIN + 180 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isLive("c1"), false);
  assert.equal(fake.connections[1]!.notices.length, 1);
  assert.match(fake.connections[1]!.notices[0]!, /stuck job \(k1\) is silent since 10:35, 180 min/);
  await fake.threads.close();
});

test("thread hub: a service start keeps each chat's idle clock, so a chat idle 40 min before the start detaches 50 min after it at 90 idle min (10-14 11:18 to 13:52 KST: 13 service restarts reset every clock and 1 of 9 chats detached)", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "chat-idle-")), "idle-clocks.json");
  const before = await attached(hub({ file }));
  before.at(T0 + 40 * MIN);
  await before.rest();
  assert.equal(before.threads.isLive("c1"), true);
  await before.threads.close();

  const after = hub({ file });
  after.at(T0 + 41 * MIN);
  await attached(after);
  after.at(T0 + 89 * MIN);
  await after.rest();
  assert.equal(after.threads.isLive("c1"), true, "idle 89 min across the start holds");
  after.at(T0 + 90 * MIN);
  await after.rest();
  assert.equal(after.threads.isDormant("c1"), true, "idle 90 min counts from the activity before the start, not from the new attach");
  await after.threads.prompt("c1", { message: "hi", images: [], mode: "steer" });
  after.at(T0 + 90 * MIN + 89 * MIN);
  await after.rest();
  assert.equal(after.threads.isLive("c1"), true, "a wake after the start restarts the clock as before");
  await after.threads.close();
});

test("thread hub: at a service start a chat whose running subagents were all silent past CHILD_SILENT_MS stays detached, and one with a subagent active within it resumes", async () => {
  const restedFor = { lastActivityAt: new Date(T0 - 120 * MIN).toISOString(), hasRunningRlmChildren: true };
  const fake = hub({ summaries: { stale: { ...restedFor }, fresh: { ...restedFor }, unknown: { ...restedFor } },
    childTimes: { stale: [T0 - CHILD_SILENT_MS, T0 - 300 * MIN], fresh: [T0 - 300 * MIN, T0 - 20 * MIN], unknown: [T0 - 300 * MIN, Number.NaN] } });
  for (const id of ["stale", "fresh", "unknown"]) { delete fake.summary(id).activeSessionId; fake.threads.pin(id); }
  fake.fire();
  for (let wait = 0; wait < 40 && !(fake.threads.isDormant("stale") && fake.threads.isLive("fresh") && fake.threads.isLive("unknown")); wait++) await flush();
  assert.equal(fake.threads.isDormant("stale"), true, "its subagents last worked 180 and 300 min ago");
  assert.equal(fake.threads.isLive("fresh"), true, "a subagent worked 20 min ago");
  assert.equal(fake.threads.isLive("unknown"), true, "a subagent with no activity time is not judged silent");
  await fake.threads.close();
});

test("thread hub: a Slack feed does not hold its chat attached: api portal vp's case, a bridged chat with all jobs done detaches at its idle time, and the bridge's resubscribe leaves it dormant (10-14 14:00 to 15:00 KST: idle 61 min with 30 of 30 jobs done, held by its #api-portal-bot feed)", async () => {
  const done: ChildAgent[] = [{ id: "k1", label: "staging dm ingress", status: "done", lastActivityAt: T0 - 600 * MIN }, { id: "k2", label: "portal api spec", status: "done" }];
  const fake = await attached(hub({ children: () => done }));
  const slack: string[] = [];
  const unsubscribe = await fake.threads.subscribe("c1", event => { slack.push(event.type); }, true);
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true, "the Slack feed is not a tab");
  unsubscribe();
  await fake.threads.subscribe("c1", event => { slack.push(event.type); }, true);
  await flush();
  assert.equal(fake.threads.isDormant("c1"), true, "the bridge's resubscribe does not wake the chat");
  assert.equal(fake.connections.length, 1);
  await fake.threads.close();
});

test("thread hub: a Slack message wakes a dormant bridged chat at once, its turn gets the message, and the reply reaches the Slack feed", async () => {
  const fake = await attached(hub());
  const slack: ThreadEvent[] = [];
  await fake.threads.subscribe("c1", event => { slack.push(event); }, true);
  fake.at(T0 + 90 * MIN);
  await fake.rest();
  assert.equal(fake.threads.isDormant("c1"), true);
  await fake.threads.prompt("c1", { message: "is the portal up?", images: [], mode: "steer" });
  assert.equal(fake.threads.isLive("c1"), true);
  assert.deepEqual(fake.connections[1]!.prompts, ["is the portal up?"]);
  const reply = { role: "assistant", content: [{ type: "text", text: "yes, all green" }], provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", timestamp: T0 + 91 * MIN,
    api: "anthropic-messages", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  fake.connections[1]!.emit({ type: "session_event", event: { type: "message_end", message: reply } });
  await flush();
  const ended = slack.filter(event => event.type === "event" && event.event.type === "message_end");
  assert.equal(ended.length, 1, "the feed gets the reply's message_end, which the bridge posts");
  assert.match(JSON.stringify(fake.threads.state("c1")!.messages), /yes, all green/);
  await fake.threads.close();
});

test("thread hub: a job check's view lets go of the job's daemon client right after the read, so it holds no tree past a sweep (10-14 19:16:17Z: the checks attached 3 VP of CI jobs and Prime skipped the tree at 19:20:23Z)", async () => {
  const fake = await attached(hub());
  const jobs = ["metal ci runners", "ci train", "gate job checkout"];
  const states = await Promise.all(jobs.map(id => fake.threads.view(id)));
  assert.ok(states.every(state => state !== null), "each check reads the live job");
  await flush();
  for (const id of jobs) assert.equal(fake.threads.isLive(id), false, `${id} is detached after the read`);
  assert.equal(fake.connections.filter(connection => connection.disposed).length, 3, "each job's daemon client is gone");
  assert.equal(await fake.threads.view("c1") !== null, true);
  await flush();
  assert.equal(fake.threads.isLive("c1"), true, "a pinned chat stays attached");
  await fake.threads.subscribe("tabbed", () => {});
  await fake.threads.view("tabbed");
  await flush();
  assert.equal(fake.threads.isLive("tabbed"), true, "a job a tab watches stays attached");
  await fake.threads.close();
});

test("thread hub: at a service start a rested chat whose thread an open tab already opened stays detached, so the tab loads no worker (api portal vp and launch main bro, paused and idle 19 to 58 min, got a new worker at the 23:16Z, 23:34Z and 23:55Z starts on 10-17)", async () => {
  const fake = hub({ minutes: 10, summaries: { tab: { lastActivityAt: new Date(T0 - 58 * MIN).toISOString() } } });
  delete fake.summary("tab").activeSessionId;
  await fake.threads.open("tab");
  fake.threads.pin("tab");
  fake.fire();
  for (let wait = 0; wait < 40 && !fake.threads.isDormant("tab"); wait++) await flush();
  assert.equal(fake.threads.isDormant("tab"), true);
  assert.equal(fake.requests.includes("create"), false, "no resume");
  await fake.threads.close();
});

// The idle unload recycles a worker that grew past RECYCLE_OWN_BYTES once every session on it is quiet (src/idle-unload.ts): the AI harness VP's
// worker held 1.24 to 1.50 GB of its own at 00:47Z to 00:54Z on 10-18, and the chat never rested the 10 idle minutes a plain detach waits for.
test("thread hub: restNow detaches a resting pinned chat after the given quiet time with no idleEvictionMinutes wait, and a duty hold keeps it", async () => {
  const fake = await attached(hub());
  fake.at(T0 + 2 * MIN);
  assert.equal(await fake.threads.restNow("c1", 3 * MIN), false, "not before the quiet time");
  assert.equal(fake.threads.isLive("c1"), true);
  fake.at(T0 + 3 * MIN);
  assert.equal(await fake.threads.restNow("c1", 3 * MIN), true);
  assert.equal(fake.threads.isDormant("c1"), true);
  assert.equal(fake.connections[0]!.disposed, true, "the service's attach is gone, so the unload can stop the session");
  assert.equal(await fake.threads.restNow("c1", 3 * MIN), false, "a detached chat is not detached twice");
  await fake.threads.close();
  const held = await attached(hub({ held: async () => true }));
  held.at(T0 + 30 * MIN);
  assert.equal(await held.threads.restNow("c1", 3 * MIN), false, "a duty that holds the chat keeps it attached");
  assert.equal(held.threads.isLive("c1"), true);
  await held.threads.close();
});
