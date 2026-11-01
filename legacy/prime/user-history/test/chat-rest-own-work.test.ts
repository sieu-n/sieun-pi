// Guards d7's lingering finding at 18:32 KST on 11-01 and the two before it at 17:02 KST: Prospect feature bro sat loaded on worker 2652166
// (0.68 GB, the whole of that run's quiet_agent_gb), quiet since 09:08Z, because the tabs that reopened after the 09:23:10Z service restart
// restarted the chat's idle clock, and metal-management sat attached past a catalog wake at 07:56:37Z and past its jobs' last steps. The idle
// unload and d7 count a chat's quiet time from its own work, so the hub's idle clock does too: an attach, a page that subscribes again and a
// child's step leave it alone, while a first tab open and a send still move it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import type { ChildAgent, ThreadEvent } from "../src/shared/types.ts";

const MIN = 60_000;
const CHAT = "01a11bd7-072f-7591-ad1d-f123c276cde5";
const ownWork = Date.parse("2026-11-01T09:08:00Z");

/** A hub on a 15 min idle time whose clock the test moves, with one pinned chat whose session last worked at `ownWork`. */
function hub(tree: () => object[] = () => []) {
  const clock = { now: ownWork };
  const catalog = { tree, summary: async (id: string) => ({ sessionId: id, activeSessionId: "a-" + id, cwd: "/", lifecycle: "live", lastActivityAt: new Date(ownWork).toISOString() }),
    hostOf: () => null, daemonPath: (row: { sessionFile?: string }) => row.sessionFile, subscribe: () => () => {} } as unknown as Catalog;
  const threads = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }), async () => undefined,
    { minutes: () => 15, now: () => clock.now });
  const connection = { subscribe: () => () => {}, flushBufferedSessionEvents: async () => {}, dispose: async () => {}, setSteeringMode: async () => {} };
  const internals = threads as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(connection: unknown, summary: { sessionId: string }): Promise<unknown>; rest(): Promise<void>;
    threads: Map<string, { broadcast(event: ThreadEvent): void }> };
  internals.attach = async () => connection;
  internals.liveSnapshot = async () => ({ kind: "live", info: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 0 },
    messages: [], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });
  threads.pin(CHAT);
  const restAt = async (at: number) => { clock.now = at; await internals.rest(); return threads.isDormant(CHAT); };
  return { threads, clock, restAt, broadcast: (event: ThreadEvent) => internals.threads.get(CHAT)!.broadcast(event) };
}

test("a chat the catalog woke rests 15 min after its own last work, not 15 min after the attach", async () => {
  const { threads, clock, restAt } = hub();
  clock.now = ownWork + 10 * MIN;
  await threads.resume(CHAT, true, "catalog");
  assert.equal(threads.isLive(CHAT), true);
  assert.equal(await restAt(ownWork + 14 * MIN), false);
  assert.equal(await restAt(ownWork + 15 * MIN + 1000), true, "the 10 min the chat sat quiet before the attach count");
  assert.equal(threads.isLive(CHAT), false);
  await threads.close();
});

test("a page that subscribes again after a restart leaves the idle clock alone, and a first tab open still restarts it", async () => {
  const { threads, clock, restAt } = hub();
  clock.now = Date.parse("2026-11-01T09:23:13Z");
  const reconnect = await threads.subscribe(CHAT, () => {}, false, { last: "m1793524000000.0" });
  await threads.open(CHAT);
  assert.equal(threads.isLive(CHAT), true);
  reconnect();
  assert.equal(await restAt(ownWork + 15 * MIN + 1000), true, "detached at 09:23:01Z plus a sweep, not at 09:38:13Z");
  await threads.close();

  const fresh = hub();
  fresh.clock.now = ownWork + 10 * MIN;
  const close = await fresh.threads.subscribe(CHAT, () => {});
  await fresh.threads.open(CHAT);
  close();
  assert.equal(await fresh.restAt(ownWork + 15 * MIN + 1000), false, "the owner opened the chat 5 min ago");
  assert.equal(await fresh.restAt(ownWork + 25 * MIN + 1000), true, "the tab's close is no activity");
  await fresh.threads.close();
});

test("a job's steps hold the chat only while the job runs, and the chat rests from its own last work once the job is done", async () => {
  const { threads, clock, restAt, broadcast } = hub();
  clock.now = ownWork + MIN;
  await threads.resume(CHAT, true, "catalog");
  const job: ChildAgent = { id: "sub-1", label: "watchlist read errors spike", status: "running", lastActivityAt: ownWork + 12 * MIN };
  clock.now = ownWork + 12 * MIN;
  broadcast({ type: "children", children: [job] });
  assert.equal(await restAt(ownWork + 16 * MIN), false, "a running job holds its chat");
  broadcast({ type: "children", children: [{ ...job, status: "done", lastActivityAt: ownWork + 16 * MIN }] });
  assert.equal(await restAt(ownWork + 16 * MIN + 1000), true, "the job's steps do not restart the chat's 15 min");
  await threads.close();
});

test("a job the roster still reads running holds its chat only while the daemon lists it loaded", async () => {
  // The 18:48Z state of api portal vp: its roster kept portal-logs running with its 16:36:40Z activity time after the idle unload stopped it.
  let loaded = false;
  const { threads, clock, restAt, broadcast } = hub(() => [{ sessionId: "job-row", rlmChildId: "sub-b9040225", ...loaded ? { activeSessionId: "a-job" } : {} }]);
  clock.now = ownWork + MIN;
  await threads.resume(CHAT, true, "catalog");
  broadcast({ type: "children", children: [{ id: "sub-b9040225", label: "portal-logs", status: "running", lastActivityAt: ownWork + 10 * MIN }] });
  loaded = true;
  assert.equal(await restAt(ownWork + 16 * MIN), false, "a loaded running job holds its chat");
  loaded = false;
  assert.equal(await restAt(ownWork + 17 * MIN), true, "the daemon lists the job unloaded, so its stale roster entry holds nothing");
  await threads.close();
});
