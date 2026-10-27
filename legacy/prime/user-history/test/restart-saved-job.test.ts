// Guards 10-19: a check-in or job-steer restart of a job the idle sweep had saved answered 409 "Reply to resume this thread first", because the
// restart's abort required a live worker. On us-metal02 that refused the restarts of 7 jobs of chat 01a115e2 and the steers to the metal box owner.
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
import { writesThroughClient } from "./keyed-writes.ts";
import { ThreadHub } from "../src/chat-threads.ts";

type Call = { type: string; activeSessionId?: string; sessionPath?: string; message?: string; streamingBehavior?: string };

async function savedJob(t: TestContext, listed: "none" | "dropped") {
  const dir = await mkdtemp(join(tmpdir(), "restart-saved-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "watch the metal box", timestamp: 1 });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const saved: SessionSummary = { id, sessionId: id, sessionFile: file, cwd: dir, lifecycle: "archived", activity: "idle",
    isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
  // "dropped": the idle unload stopped the worker, and the row still names it ("listed active but the daemon has no live 8283f55e7090").
  const row: SessionSummary = listed === "none" ? saved : { ...saved, id: "dropped-worker", activeSessionId: "dropped-worker", lifecycle: "live", workerState: "ready" };
  const calls: Call[] = [];
  const catalog = new Catalog("/isolated-restart-saved.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  writesThroughClient(t);
  t.mock.method(DaemonClient.prototype, "request", async (command: Call) => {
    calls.push(command);
    switch (command.type) {
      case "list": return { success: true, data: { sessions: [row] } };
      case "create": return { success: true, data: { ...saved, id: "new-worker", activeSessionId: "new-worker", lifecycle: "live" } };
      case "attach":
        if (command.activeSessionId !== "new-worker") return { success: false, error: `Unknown active session: ${command.activeSessionId}` };
        return { success: true, data: { activeSessionId: "new-worker", snapshot: { summary: { ...saved, activeSessionId: "new-worker", lifecycle: "live" },
          state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null, isStreaming: false,
            isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1, sessionActions: { queuedCount: 0 }, contextUsage: null },
          messages: [{ role: "user", content: "watch the metal box", timestamp: 1 }], children: [] } } };
      case "prompt":
        if (command.activeSessionId !== "new-worker") return { success: false, error: `Unknown active session: ${command.activeSessionId}` };
        return { success: true };
      case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
      case "get_heartbeat": return { success: true, data: null };
      default: return { success: true, data: null };
    }
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-restart-saved.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); await catalog.close(); });
  return { id, file, hub, calls };
}

for (const listed of ["none", "dropped"] as const) {
  test(`a restart of a saved job (${listed === "none" ? "no worker listed" : "its listed worker dropped"}) wakes it with the message instead of a 409`, async t => {
    const { id, file, hub, calls } = await savedJob(t, listed);
    await hub.restart(id, "us-metal01 has 4 firing risks", true);
    assert.deepEqual(calls.filter(call => call.type === "create").map(call => call.sessionPath), [file], "the restart starts the saved job from its file");
    assert.deepEqual(calls.filter(call => call.type === "prompt" && call.activeSessionId === "new-worker").map(call => [call.message, call.streamingBehavior]),
      [["us-metal01 has 4 firing risks", "steer"]]);
    assert.deepEqual(calls.filter(call => call.type === "resume_queue").map(call => call.activeSessionId), ["new-worker"]);
    assert.equal(calls.some(call => call.type === "abort"), false, "a saved job runs no turn to stop");
  });
}
