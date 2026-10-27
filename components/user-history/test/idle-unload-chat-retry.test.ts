// Guards the 06:03Z state on us-metal02 on 10-19 under the owner's ask that agent RAM drop to near zero 15 minutes after the last turn ends:
// six chats sat asleep in Prime's provider retry after a 429 or pi-pool's slot refusal, each alone on its own worker with 0.20 to 0.40 GB PSS
// and a kernel, and the idle unload left every chat out (~/scratch/idle-ram/sessions-0603.json). The fixture holds those six chats and every
// session under them.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionSummary } from "prime-agent";
import { loadRecord } from "../src/chat-brief.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { Dormancy } from "../src/chat-dormancy.ts";
import { type PoolPart, type ThreadParts, threadKey } from "../src/chat-pool.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { type DaemonAnswer, IdleUnloader, poolHoldsPast, providerWaits, retryCandidates, unloadPlan } from "../src/idle-unload.ts";
import type { ModelInfo, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, ownerAsks, reply, row, source } from "./chats-helpers.ts";

type Fixture = { takenAt: string; chats: string[]; rows: SessionSummary[]; tails: Record<string, string> };
const day = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "chat-retry-rows-1019-0603.json"), "utf8")) as Fixture;
const at = Date.parse(day.takenAt);
const MIN = 60_000;
const QUIET = 15 * MIN;
const chats = new Set(day.chats);
const input = { attached: chats, pool: new Set<string>(), now: at, idleMs: QUIET, chats };
const part = (body: unknown): PoolPart => ({ code: 0, out: JSON.stringify(body), err: "" });
/** `pi-pool who` and `ls` for a tree held until `slotAt` (epoch ms), or served now by claude7 with null. */
const parts = (slotAt: number | null): ThreadParts => ({
  who: part({ providers: { anthropic: { selection: { mode: "auto" }, account: slotAt ? null : "claude7", wait: slotAt ? { account: "claude11", slot_at: slotAt / 1000 } : null } } }),
  ls: { anthropic: part({ provider: "anthropic", rows: [{ id: "claude7", email: "claude7@slack.green", usage: "", reason: null, usable: slotAt === null, current: false, pinned: false }] }),
    "openai-codex": part({ provider: "openai-codex", rows: [] }) },
});
const reads = (slot: (tree: string) => number | null) => ({
  all: day.rows, local: () => true, tail: async (file: string) => day.tails[file.slice("/sessions/".length, -".jsonl".length)] ?? "",
  read: async (threads: readonly { session: string | null; model: string | null }[]) =>
    ({ threads: new Map(threads.map(thread => [threadKey(thread), { ...parts(slot(thread.session ?? "")), at }] as const)) }),
});

test("the 06:03Z rows: each of the six chats asleep in its provider retry is planned once pi-pool holds its tree, where none was before", async () => {
  const candidates = retryCandidates(day.rows, input);
  assert.deepEqual(candidates.map(candidate => candidate.sessionId).sort(), [...chats].sort());
  const held = await providerWaits(candidates, at, QUIET, reads(() => at + 3 * 60 * MIN));
  assert.deepEqual([...held.keys()].sort(), [...chats].sort());
  const planned = new Set(unloadPlan(day.rows, { ...input, held }).map(planned => planned.sessionId));
  for (const chat of chats) assert.ok(planned.has(chat), chat);
  assert.equal(unloadPlan(day.rows, input).filter(stop => chats.has(stop.sessionId)).length, 0, "no chat stops without the pool's hold");
  const seo = day.rows.find(candidate => candidate.sessionName === "SEO guy")!;
  const others = day.rows.filter(candidate => candidate !== seo);
  assert.equal(retryCandidates([...others, { ...seo, attachedClients: 2 }], input).some(candidate => candidate.sessionId === seo.sessionId), false,
    "a client besides the service's own attach keeps the chat");
  const dormant = { ...input, attached: new Set([...chats].filter(id => id !== seo.sessionId)) };
  assert.equal(retryCandidates(day.rows, dormant).some(candidate => candidate.sessionId === seo.sessionId), false,
    "a chat the service let go of with a client still on it keeps it");
  assert.equal(retryCandidates([...others, { ...seo, attachedClients: 0 }], dormant).some(candidate => candidate.sessionId === seo.sessionId), true);
});

test("a session stops on a hold past the quiet window or one with no time named, and a tree served within the quiet window keeps it", async () => {
  assert.equal(poolHoldsPast(at + 30 * 60 * MIN, at, QUIET), true, "a chat's revive and the job sweep ask the pool with no look-back");
  assert.equal(poolHoldsPast(null, at, QUIET), true);
  assert.equal(poolHoldsPast(at + QUIET - MIN, at, QUIET), false);
  assert.equal(poolHoldsPast(at, at, QUIET), false, "the pool serves the tree now");
  const candidates = retryCandidates(day.rows, input);
  assert.equal((await providerWaits(candidates, at, QUIET, reads(() => null))).size, 0, "pi-pool serves every tree now");
  const unread = { ...reads(() => null), read: async () => ({ threads: new Map() }) };
  assert.equal((await providerWaits(candidates, at, QUIET, unread)).size, 0, "a tree the pool gave no reading for stops nothing");
});

const retryState: DaemonAnswer = { success: true, data: { activity: "working", isSessionActive: true, isStreaming: false, isCompacting: false, isBashRunning: false, isRunningTools: false } };

test("a chat's stop lets go of the service's attach before the kill, and a chat the service keeps is not killed", async () => {
  const [keep, ...stop] = retryCandidates(day.rows, input);
  const calls: string[] = [], stopped: string[] = [], lines: string[] = [];
  const unloader = new IdleUnloader({
    rows: () => day.rows, localRows: () => [], idleMs: () => QUIET, chats: async () => chats, dormant: () => false, pool: async () => new Set(),
    waking: async () => new Set(), held: async rows => new Map(rows.filter(candidate => chats.has(candidate.sessionId)).map(candidate => [candidate.sessionId, null])),
    own: async () => new Map(), restNow: async () => false, title: () => null,
    release: async id => { calls.push(`release ${id}`); return id !== keep!.sessionId; },
    request: async (candidate, type) => { calls.push(`${type} ${candidate.sessionId}`); return type === "get_state" ? retryState : { success: true }; },
    stopped: async (candidate, isChat) => { stopped.push(`${candidate.sessionId}${isChat ? " chat" : ""}`); }, log: line => { lines.push(line); }, now: () => at,
  });
  await unloader.sweep();
  await unloader.settled();
  assert.deepEqual(stopped.sort(), stop.map(candidate => `${candidate.sessionId} chat`).sort());
  for (const candidate of stop) {
    const mine = calls.filter(call => call.endsWith(candidate.sessionId));
    assert.deepEqual(mine, [`get_state ${candidate.sessionId}`, `release ${candidate.sessionId}`, `kill ${candidate.sessionId}`]);
  }
  assert.equal(calls.includes(`kill ${keep!.sessionId}`), false);
  assert.ok(lines.some(line => line.includes(`${keep!.sessionId}: the service holds the chat for a duty or an open; kept`)), lines.join("\n"));
  assert.ok(lines.some(line => line.includes("(waits on pi-pool, which names no time)")), lines.join("\n"));
});

test("a chat let go of asleep in its retry stays dormant while the catalog lists its open turn, and new activity wakes it", () => {
  let now = at;
  const dormancy = new Dormancy({ now: () => now });
  const id = day.chats[0]!;
  const working = row(id, new Date(at - 30 * MIN).toISOString(), { working: true, status: "running" });
  dormancy.sleep(id, 30 * MIN, "detached asleep in its provider retry");
  assert.deepEqual(dormancy.woken([working]), []);
  now += MIN;
  assert.deepEqual(dormancy.woken([{ ...working, lastActivityAt: new Date(now).toISOString() }]), [id], "a retry that fired wakes it");
  dormancy.sleep(id, 30 * MIN, "detached");
  assert.deepEqual(dormancy.woken([working]), [id], "a chat that rested is woken by a turn at work as before");
});

const RATE = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later.";

test("the revive restarts a stopped chat's turn once pi-pool admits its tree, and leaves it stopped until then", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-retry-revive-"));
  const CHAT = day.chats.find(id => day.rows.find(candidate => candidate.sessionId === id)?.sessionName === "api portal vp")!;
  const calls: string[] = [];
  const live = new Set<string>();
  const threads = { ...fakeThreads(calls), isLive: (id: string) => live.has(id) };
  const failedAt = at - 60 * MIN;
  threads.transcripts.set(CHAT, [ownerAsks("ship the portal fix", failedAt - MIN), reply("error", failedAt, RATE)]);
  const hub = (retryAttempt: number) => threads.extras.set(CHAT, {
    info: { model: { provider: "anthropic", id: "claude-opus-5-5" } as ModelInfo, retryAttempt, queuedActions: 0 },
    queue: { steering: [], followUp: [] }, retry: retryAttempt ? { error: RATE } : null } as never);
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = at;
  let admits = false;
  const asked: number[] = [];
  const revived = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")), {
    ...source(home, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), home,
    poolAdmits: async () => { asked.push(now); return admits; } });
  const wake = async (minutes: number) => {
    now = at + minutes * MIN;
    calls.length = 0;
    await revived.tick();
    await revived.settled();
    await new Promise(resolve => setTimeout(resolve, 20));
    return calls.filter(call => call.startsWith("restart ") || call.startsWith("abort "));
  };

  hub(3);
  live.add(CHAT);
  threads.busyIds.add(CHAT);
  admits = true;
  assert.deepEqual(await wake(0), [], "attached, the retry is the session's own");
  assert.deepEqual(asked, [], "and the pool is not asked");
  live.delete(CHAT);
  admits = false;
  assert.deepEqual(await wake(1), [], "stopped while pi-pool holds its tree");
  assert.equal(asked.length, 1);
  admits = true;
  const restarted = await wake(2);
  assert.equal(restarted.length, 1);
  assert.match(restarted[0]!, new RegExp(`^restart ${CHAT} \\[check-in\\] Your last turn failed at .*"ship the portal fix"\\. Answer it first\\. \\(abort\\)$`));

  // After a service start the hub opens the stopped chat saved: no retry in its state, only the failed reply.
  threads.busyIds.delete(CHAT);
  hub(0);
  admits = false;
  for (const minutes of [30, 60, 120]) assert.deepEqual(await wake(minutes), [], `still held at +${minutes} min, past every restart on the schedule`);
  admits = true;
  assert.equal((await wake(121)).length, 1);
  revived.close();
});

test("thread hub: a chat let go of asleep in its retry stays detached through the catalog's working rows, and the revive's restart opens it once pi-pool admits it", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-retry-hub-"));
  const CHAT = day.chats[0]!;
  const failedAt = at - 40 * MIN;
  let fire: (event: { daemon: string; sessions?: SessionRow[] }) => void = () => {};
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: "a-" + id, cwd: "/", lifecycle: "live" }), hostOf: () => null,
    daemonPath: (row: { sessionFile?: string }) => row.sessionFile, subscribe: (listener: typeof fire) => { fire = listener; return () => {}; } } as unknown as Catalog;
  let now = at;
  const threads = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), async () => undefined, { now: () => now });
  const disposed: string[] = [];
  const attaches: string[] = [];
  const internals = threads as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(connection: unknown, summary: { sessionId: string }): Promise<unknown> };
  internals.attach = async (id: string) => {
    attaches.push(id);
    return { subscribe: () => () => {}, flushBufferedSessionEvents: async () => {}, dispose: async () => { disposed.push(id); }, setSteeringMode: async () => {} };
  };
  internals.liveSnapshot = async () => ({ kind: "live", info: { model: { provider: "anthropic", id: "claude-opus-5-5" }, isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 3, sessionAction: null, queuedActions: 0 }, messages: [ownerAsks("ship it", failedAt - MIN), reply("error", failedAt, RATE)], streaming: null,
    queue: { steering: [], followUp: [] }, children: [], tools: [], retry: { error: RATE }, runStartedAt: null });
  const restarts: string[] = [];
  (threads as unknown as { restart(id: string, message: string): Promise<void> }).restart = async (id, message) => { restarts.push(`${id} ${message}`); await threads.resume(id); };
  const flush = () => new Promise(resolve => setTimeout(resolve, 5));
  threads.pin(CHAT);
  fire({ daemon: "up" });
  for (let wait = 0; wait < 20 && !threads.isLive(CHAT); wait++) await flush();
  assert.equal(threads.isLive(CHAT), true);

  assert.equal(await threads.restAsleep(CHAT), true);
  assert.equal(threads.isLive(CHAT), false);
  assert.equal(threads.isDormant(CHAT), true);
  assert.deepEqual(disposed, ["a-" + CHAT], "the service's attach is let go before the kill");
  const working = { id: CHAT, name: CHAT, kind: "live", status: "running", working: true, lastActivityAt: new Date(failedAt).toISOString() } as SessionRow;
  for (let i = 0; i < 3; i++) { fire({ daemon: "up", sessions: [working] }); await flush(); }
  assert.equal(threads.isLive(CHAT), false, "the open turn the catalog still lists does not attach it again");
  assert.equal(attaches.length, 1);

  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  let admits = false;
  const revived = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")), {
    ...source(home, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), home, poolAdmits: async () => admits });
  const wake = async (minutes: number) => { now = at + minutes * MIN; await revived.tick(); await revived.settled(); await flush(); };
  await wake(1);
  await wake(30);
  assert.deepEqual(restarts, [], "no restart while pi-pool holds the tree");
  assert.equal(threads.isLive(CHAT), false);
  admits = true;
  await wake(31);
  assert.equal(restarts.length, 1);
  assert.match(restarts[0]!, /Your last turn failed at .*"ship it"\. Answer it first\.$/);
  for (let wait = 0; wait < 20 && !threads.isLive(CHAT); wait++) await flush();
  assert.equal(threads.isLive(CHAT), true, "the restart opens the chat again");
  assert.equal(threads.isDormant(CHAT), false);
  revived.close();
  await threads.close();
});

// Guards 21:00Z on 10-26 to 00:20Z on 10-27: two stopped Mac chats restarted every 30 s while Tailscale read the Mac offline, 593 resumes that
// each failed at once with "mac is offline", and the one at 00:20:10.042Z came 0.55 s before the service read the Mac back.
test("the revive leaves a stopped chat on a box Tailscale reads offline alone, and restarts it at the first pass after the box is back", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-retry-away-"));
  const CHAT = day.chats[0]!;
  const calls: string[] = [];
  const threads = { ...fakeThreads(calls), isLive: () => false };
  const failedAt = at - 60 * MIN;
  threads.transcripts.set(CHAT, [ownerAsks("ship it", failedAt - MIN), reply("error", failedAt, RATE)]);
  threads.extras.set(CHAT, { info: { model: { provider: "anthropic", id: "claude-opus-5-5" } as ModelInfo, retryAttempt: 0, queuedActions: 0 },
    queue: { steering: [], followUp: [] }, retry: null } as never);
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = at;
  let macOffline = true;
  const asked: string[] = [];
  const revived = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")), {
    ...source(home, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true, host: "mac" })]), home, poolAdmits: async () => true,
    hostAway: async name => { asked.push(name); return macOffline ? { name, lastSeen: new Date(now).toISOString() } : null; } });
  const wake = async (seconds: number) => {
    now = at + seconds * 1000;
    calls.length = 0;
    await revived.tick();
    await revived.settled();
    await new Promise(resolve => setTimeout(resolve, 20));
    return calls.filter(call => call.startsWith("restart "));
  };
  for (const seconds of [0, 30, 60, 90]) assert.deepEqual(await wake(seconds), [], `no restart at +${seconds} s while the Mac reads offline`);
  assert.ok(asked.includes("mac"));
  macOffline = false;
  assert.equal((await wake(120)).length, 1, "the first pass after the Mac reads online restarts it");
  revived.close();
});
