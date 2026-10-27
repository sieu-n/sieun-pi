import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import type { SessionSummary } from "prime-agent";

function catalog(t: TestContext) {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const result = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }));
  Object.defineProperty(result.client, "isConnected", { get: () => true });
  t.mock.method(result.client, "reconnect", async () => {});
  t.mock.method(result.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.after(() => result.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return result;
}

const row = (id: string, live: boolean, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId: id, cwd: "/tmp", sessionFile: `/s/${id}.jsonl`, messageCount: 3, ...(live ? { activeSessionId: `a-${id}` } : {}), ...extra }) as SessionSummary;

test("a refresh lists the roster only and lays it over the copy; a session that starts or stops needs no full list either (daemon list latency, 10-18 owner report on us-metal02)", async t => {
  const c = catalog(t);
  const daemon = { live: [row("a", true, { sessionName: "first" })], saved: [row("b", false), row("c", false)] };
  const asked: string[] = [];
  t.mock.method(c.client, "request", async (command: { type: string; all?: boolean }) => {
    if (command.type !== "list") return { success: true, data: { jobs: [] } };
    asked.push(command.all ? "all" : "roster");
    const savedOnly = daemon.saved.filter(saved => !daemon.live.some(live => live.sessionId === saved.sessionId));
    return { success: true, data: { sessions: command.all ? [...daemon.live, ...savedOnly] : daemon.live } };
  });
  await c.refresh();
  assert.deepEqual(asked, ["all"]);
  daemon.live = [row("a", true, { sessionName: "renamed" })];
  for (let i = 0; i < 5; i++) await c.refresh();
  assert.deepEqual(asked, ["all", "roster", "roster", "roster", "roster", "roster"], "116 roster_updates a minute no longer mean 116 disk scans");
  assert.deepEqual([...rowsOf(c).keys()].sort(), ["a", "b", "c"], "the saved sessions from the full list stay listed");
  assert.equal(rowsOf(c).get("a")?.sessionName, "renamed", "the live row is the roster's");
  daemon.live = [row("a", true), row("d", true)];
  asked.length = 0;
  await c.refresh();
  assert.deepEqual(asked, ["roster"], "a session the full list lacks joins from the roster");
  assert.equal(rowsOf(c).has("d"), true);
  daemon.live = [row("d", true)];
  asked.length = 0;
  await c.refresh();
  assert.deepEqual(asked, ["roster"], "a session that stopped keeps its row as saved");
  assert.equal(rowsOf(c).get("a")?.activeSessionId, undefined);
});

test("a refresh asked for during another one shares one run after it, so its caller sees what changed before it asked", async t => {
  const c = catalog(t);
  const asked: string[] = [];
  let release!: () => void;
  let hold = false;
  t.mock.method(c.client, "request", async (command: { type: string; all?: boolean }) => {
    if (command.type !== "list") return { success: true, data: { jobs: [] } };
    asked.push(command.all ? "all" : "roster");
    if (hold && !command.all) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
    return { success: true, data: { sessions: [row("a", true)] } };
  });
  await c.refresh();
  hold = true;
  const first = c.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const second = c.refresh();
  const third = c.refresh();
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(asked, ["all", "roster", "roster"]);
});

function rowsOf(c: Catalog): Map<string, SessionSummary> {
  return (c as unknown as { summaries: Map<string, SessionSummary> }).summaries;
}
