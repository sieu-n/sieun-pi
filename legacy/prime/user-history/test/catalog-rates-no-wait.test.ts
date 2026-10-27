// Guards the 10-18 projection latency at the live rate: a scratch serve (13.3 roster updates a second, 17 chats) waited about 225 ms for the usage worker's rates on every fourth catalog projection, a 90th percentile of 300 ms against a 60 ms median.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import type { TokenRate } from "../src/shared/types.ts";

test("a projection takes the last rates and never waits for the usage store", async (t: TestContext) => {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set(["chat"]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  const rows = [
    { sessionId: "chat", activeSessionId: "a-chat", cwd: "/tmp", sessionName: "chat", messageCount: 3 },
    { sessionId: "job", activeSessionId: "a-job", parentSessionId: "chat", rlmChildId: "sub-1", runtimeKind: "subagent", rosterStatus: "running", cwd: "/tmp", sessionName: "job", messageCount: 3 },
  ] as SessionSummary[];
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: rows } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  const asked: string[][] = [];
  let answer: (rates: Record<string, TokenRate>) => void = () => {};
  catalog.ratesSource = async ids => { asked.push([...ids]); return new Promise(resolve => { answer = resolve; }); };
  await catalog.refresh();

  const late = Symbol("late");
  const within = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<typeof late>(resolve => setTimeout(resolve, 1000, late))]);
  const first = await within(catalog.event());
  assert.notEqual(first, late, "the projection does not wait for the rates");
  assert.deepEqual(asked, [["job"]]);
  answer({ job: { outputTokensPerSecond: 42 } as unknown as TokenRate });
  await new Promise(resolve => setImmediate(resolve));
  const second = await within(catalog.event());
  assert.notEqual(second, late);
  const job = (second as Awaited<ReturnType<Catalog["event"]>>).sessions.find(row => row.id === "chat")?.agents?.find(agent => agent.sessionId === "job");
  assert.deepEqual(job?.rate, { outputTokensPerSecond: 42 }, "the next projection carries the answer");
  assert.equal(asked.length, 1, "rates answered under RATES_MS ago are not asked again");
});
