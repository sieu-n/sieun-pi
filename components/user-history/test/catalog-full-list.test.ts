import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import type { SessionSummary } from "prime-agent";

const settle = () => new Promise(resolve => setImmediate(resolve));

// p349, measured 10-13 02:33 KST at load 40: the full list (`list` with `all`) was 8.9 MB and had no answer after 120 s, while the catalog
// waited 30 s per try. Each try sent a new list, so the daemon ran a disk scan per try and the chat parsed every late 8.9 MB answer and dropped it.
test("a full list that outlasts the caller's 30 s wait is not sent again, and its late answer fills the catalog", async t => {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const c = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }));
  Object.defineProperty(c.client, "isConnected", { get: () => true });
  t.mock.method(c.client, "reconnect", async () => {});
  t.mock.method(c.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.after(() => c.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const asked: string[] = [];
  const answers: Array<(sessions: SessionSummary[]) => void> = [];
  t.mock.method(c.client, "request", (command: { type: string; all?: boolean }, timeoutMs: number) => {
    if (command.type !== "list") return Promise.resolve({ success: true, data: { jobs: [] } });
    asked.push(command.all ? "all" : "roster");
    // The SDK's own rule: once its timer fires the request is dropped, and an answer that lands later is parsed and thrown away.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon response to "list".`)), timeoutMs);
      answers.push(sessions => { clearTimeout(timer); resolve({ success: true, data: { sessions } }); });
    });
  });
  const frames: number[] = [];
  c.subscribe(event => { if (event.daemon === "up") frames.push(event.sessions.length); });
  const first = c.refresh().then(() => "listed", (error: Error) => error.message);
  await settle();
  t.mock.timers.tick(30000);
  assert.match(await first, /Timed out after 30000ms waiting for the Prime Agent daemon response to "list"/, "the caller still stops waiting at 30 s");
  t.mock.timers.tick(2000);
  await settle();
  void c.refresh("roster").catch(() => {});
  await settle();
  assert.deepEqual(asked, ["all"], "the reconnect refresh and a roster_update join the scan already running in the daemon");
  const answer = answers[0];
  assert.ok(answer);
  answer([{ sessionId: "a", cwd: "/tmp", sessionFile: "/s/a.jsonl", messageCount: 3, activeSessionId: "x" } as SessionSummary]);
  await settle();
  await settle();
  assert.equal((await c.summary("a"))?.activeSessionId, "x", "the late answer is used");
  assert.deepEqual(asked, ["all"]);
  assert.ok(frames.length > 0, "the late answer reaches the sidebar");
});
