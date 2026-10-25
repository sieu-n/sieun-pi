// Guards 10-25 21:53Z on us-metal02: the check-in restart of job "d11 after-fix noise checks" (01a174e7) failed with "Prime Agent daemon client
// closed before the operation completed", a dirty d7 minute, and the job got its message only from a job-steer at 22:03Z. The job wake pass
// had opened the job for its stall read (`view`), the restart's abort joined that open, and the read's deferred let-go disposed the thread and
// closed its client under the restart's abort request.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { ThreadHub } from "../src/chat-threads.ts";

type Call = { type: string; activeSessionId?: string; message?: string; streamingBehavior?: string };

async function liveJob(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "restart-view-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "check d11 after the fix", timestamp: 1 });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const row: SessionSummary = { id: "w1", sessionId: id, activeSessionId: "w1", sessionFile: file, cwd: dir, lifecycle: "live", workerState: "ready", activity: "idle",
    isSessionActive: true, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1, sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
  const calls: Call[] = [];
  const pending = new WeakMap<object, Set<(error: Error) => void>>();
  const closed: string[] = [];
  const catalog = new Catalog("/isolated-restart-view.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  // The real close rejects every request still in flight on that client ("client closed before the operation completed").
  t.mock.method(DaemonClient.prototype, "close", function (this: DaemonClient) {
    for (const reject of pending.get(this) ?? []) { closed.push("in flight"); reject(new Error("Prime Agent daemon client closed before the operation completed.")); }
    pending.delete(this);
  });
  t.mock.method(DaemonClient.prototype, "request", function (this: DaemonClient, command: Call) {
    calls.push(command);
    const answer = (): unknown => {
      switch (command.type) {
        case "list": return { success: true, data: { sessions: [row] } };
        case "attach": return { success: true, data: { activeSessionId: "w1", snapshot: { summary: row,
          state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null, isStreaming: false,
            isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1, sessionActions: { queuedCount: 0 }, contextUsage: null },
          messages: [{ role: "user", content: "check d11 after the fix", timestamp: 1 }], children: [] } } };
        case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
        case "get_heartbeat": return { success: true, data: null };
        default: return { success: true, data: null };
      }
    };
    // An abort is one round trip to the worker, long enough for a timer to run meanwhile.
    if (command.type !== "abort") return Promise.resolve(answer());
    return new Promise((resolve, reject) => {
      const set = pending.get(this) ?? new Set();
      pending.set(this, set);
      const drop = (error: Error) => { clearTimeout(timer); reject(error); };
      set.add(drop);
      const timer = setTimeout(() => { set.delete(drop); resolve(answer()); }, 20);
    });
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-restart-view.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); await catalog.close(); });
  return { id, hub, calls, closed };
}

test("a check-in restart that joins a stall read's open keeps the thread's client until its abort and steer land", async t => {
  const { id, hub, calls, closed } = await liveJob(t);
  const viewing = hub.view(id);
  const restarting = hub.restart(id, "d11 still reads 2 noise sends; check them", true);
  await viewing;
  await restarting;
  assert.deepEqual(closed, [], "no request was in flight when a client closed");
  assert.deepEqual(calls.filter(call => call.type === "prompt").map(call => [call.message, call.streamingBehavior]), [["d11 still reads 2 noise sends; check them", "steer"]]);
  assert.deepEqual(calls.filter(call => call.type === "resume_queue").map(call => call.activeSessionId), ["w1"]);
});
