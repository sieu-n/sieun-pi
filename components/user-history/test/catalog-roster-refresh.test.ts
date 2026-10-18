import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Catalog, rosterOverlay } from "../src/chat-catalog.ts";
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

test("a roster_update refresh lists the roster only and lays it over the last full list; a session that starts or stops brings a full list back (daemon list latency)", async t => {
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
  for (let i = 0; i < 5; i++) await c.refresh("roster");
  assert.deepEqual(asked, ["all", "roster", "roster", "roster", "roster", "roster"], "116 roster_updates a minute no longer mean 116 disk scans");
  assert.deepEqual([...rowsOf(c).keys()].sort(), ["a", "b", "c"], "the saved sessions from the full list stay listed");
  assert.equal(rowsOf(c).get("a")?.sessionName, "renamed", "the live row is the roster's");
  daemon.live = [row("a", true), row("d", true)];
  daemon.saved = [...daemon.saved, row("d", false)];
  asked.length = 0;
  await c.refresh("roster");
  assert.deepEqual(asked, ["roster", "all"], "a session the full list lacks needs a full list");
  daemon.live = [row("d", true)];
  daemon.saved = [row("a", false), row("b", false), row("c", false), row("d", false)];
  asked.length = 0;
  await c.refresh("roster");
  assert.deepEqual(asked, ["roster", "all"], "a session that stopped needs a full list for its saved row");
  assert.equal(rowsOf(c).get("a")?.activeSessionId, undefined);
});

test("a full refresh asked for during a roster refresh runs after it instead of joining it", async t => {
  const c = catalog(t);
  const asked: string[] = [];
  let release!: () => void;
  let hold = false;
  t.mock.method(c.client, "request", async (command: { type: string; all?: boolean }) => {
    if (command.type !== "list") return { success: true, data: { jobs: [] } };
    asked.push(command.all ? "all" : "roster");
    if (hold && !command.all) await new Promise<void>(resolve => { release = resolve; });
    return { success: true, data: { sessions: [row("a", true)] } };
  });
  await c.refresh();
  hold = true;
  const roster = c.refresh("roster");
  await new Promise(resolve => setImmediate(resolve));
  const full = c.refresh();
  release();
  await Promise.all([roster, full]);
  assert.deepEqual(asked, ["all", "roster", "all"]);
});

test("rosterOverlay matches rows by session file and refuses a changed set of live sessions", () => {
  const scanned = [row("a", true), row("b", false)];
  assert.deepEqual(rosterOverlay(scanned, [row("a", true, { sessionName: "x" })])?.map(r => r.sessionName), ["x", undefined]);
  assert.equal(rosterOverlay(scanned, []), undefined, "a stopped session");
  assert.equal(rosterOverlay(scanned, [row("a", true), row("z", true)]), undefined, "a new session");
  assert.deepEqual(rosterOverlay(scanned, [row("a", true), row("b", true)])?.map(r => r.activeSessionId), ["a-a", "a-b"], "a saved session that came back live");
});

function rowsOf(c: Catalog): Map<string, SessionSummary> {
  return (c as unknown as { summaries: Map<string, SessionSummary> }).summaries;
}
