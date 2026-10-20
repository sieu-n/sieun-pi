// Guards the 10-18 owner ask "just make this UX clean, snappy": the live chat's event loop stalled 4.4 to 12.9 s under load on 10-19, and on a
// scratch serve on a copy of the live data dir with its chats on 10-20 each projection ran a median 73 to 85 ms of its own code in one piece,
// which under the box's load waited behind about 3.7 runnable threads per core.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const ROWS = 6000;
const live = (n: number): SessionSummary => ({ sessionId: `s${n}`, activeSessionId: `a${n}`, cwd: "/tmp", sessionName: `thread ${n}`, messageCount: 3,
  lastActivityAt: new Date(Date.UTC(2026, 9, 20) - n * 1000).toISOString() }) as SessionSummary;

async function catalog(t: TestContext) {
  const reads = new ChatReadState("unused");
  const state = { baseline: 0 };
  t.mock.method(reads, "snapshot", async () => ({ baseline: state.baseline, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }), roster: async () => {} };
  const result = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => result.close());
  let connected = false;
  t.mock.method(result.client, "reconnect", async () => { connected = true; });
  t.mock.method(result.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  const sessions = Array.from({ length: ROWS }, (_, n) => live(n));
  t.mock.method(result.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(result.client as unknown as object, "isConnected", { get: () => connected });
  await result.refresh();
  await new Promise(resolve => setImmediate(resolve));
  return { catalog: result, state };
}

/**
 * Runs `work` while a setImmediate ticker counts the loop's turns and the most main-thread CPU time between two of them. CPU time and not wall
 * time: a test run shares the box with the job rigs, and at load 230 on 80 cores the wall time between two turns read 71 to 293 ms for the same work.
 */
const cpuMs = (): number => { const { user, system } = process.threadCpuUsage(); return (user + system) / 1000; };
async function loopDuring(work: () => Promise<unknown>): Promise<{ turns: number; longestMs: number }> {
  let turns = 0, longestMs = 0, last = cpuMs(), done = false;
  const tick = () => {
    const now = cpuMs();
    longestMs = Math.max(longestMs, now - last);
    last = now;
    turns++;
    if (!done) setImmediate(tick);
  };
  setImmediate(tick);
  await work();
  done = true;
  longestMs = Math.max(longestMs, cpuMs() - last);
  return { turns, longestMs };
}

test(`a projection of ${ROWS} new rows lets the loop run every few ms instead of holding it for the whole build`, async t => {
  const { catalog: c, state } = await catalog(t);
  // A first projection compiles the code; the measured one builds every row again, as a new read baseline makes it.
  await c.rows();
  state.baseline = Date.now();
  c.patchRow("s1", { sessionName: "renamed" });
  // The copy indexes its rows on the first read after a change (catalog-index-once.test.ts), here before the projection starts.
  c.hostOf("s1");
  const { turns, longestMs } = await loopDuring(() => c.rows());
  t.diagnostic(`loop turns ${turns}, longest hold ${longestMs.toFixed(1)} ms of CPU`);
  assert.ok(turns >= 3, `the loop ran ${turns} times during the projection`);
  // Before 10-20 this projection ran in one piece, 111 to 148 ms of CPU over four runs and no loop turn. Now the longest piece is 24 to 54 ms
  // over twelve runs at box load 200 to 230: the slices are 10 ms, and the rest is the young-generation GC of the new rows (28 to 92 ms with --trace-gc).
  assert.ok(longestMs < 75, `the projection held the loop ${longestMs.toFixed(1)} ms of CPU at once`);
});
