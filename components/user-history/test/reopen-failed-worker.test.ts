// Guards the 10-18 clean-room cut run-1 failure: after a SIGKILL of chat 01a14ec0's worker at 11:29:49Z the hub kept its binding "connected"
// and the catalog row read "ready" on the dead pid, so the interrupted-job pass's resume of the chat returned at once with no daemon create,
// and the chat's cut job got "continue: skipped: worker_failed".
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { ThreadHub } from "../src/chat-threads.ts";

test("reopenFailed drops the binding to a dead worker and opens the chat from its file with one daemon create", async t => {
  const dir = await mkdtemp(join(tmpdir(), "reopen-failed-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "start the duty failure page job", timestamp: 1 });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const row: SessionSummary = { id: "dead-worker", sessionId: id, activeSessionId: "dead-worker", sessionFile: file, cwd: dir, lifecycle: "live", activity: "idle",
    workerState: "ready", isSessionActive: true, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
  let dead = false;
  const calls: { type: string; activeSessionId?: string; sessionPath?: string }[] = [];
  const catalog = new Catalog("/isolated-reopen-failed.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set([id]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  t.mock.method(DaemonClient.prototype, "request", async (command: typeof calls[number]) => {
    calls.push(command);
    switch (command.type) {
      case "list": return { success: true, data: { sessions: [row] } };
      case "create": return { success: true, data: { ...row, id: "new-worker", activeSessionId: "new-worker" } };
      case "attach":
        if (dead && command.activeSessionId === "dead-worker") return { success: false, error: "Session worker is failed" };
        return { success: true, data: { activeSessionId: command.activeSessionId, snapshot: { summary: { ...row, activeSessionId: command.activeSessionId },
          state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null, isStreaming: false,
            isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1, sessionActions: { queuedCount: 0 }, contextUsage: null },
          messages: [{ role: "user", content: "start the duty failure page job", timestamp: 1 }], children: [] } } };
      case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
      case "detach": return { success: true };
      case "get_heartbeat": return { success: true, data: null };
      default: return { success: true, data: null };
    }
  });
  await catalog.refresh();
  const hub = new ThreadHub("/isolated-reopen-failed.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); await catalog.close(); });
  await hub.open(id);
  assert.equal((await hub.resume(id)).live?.activeSessionId, "dead-worker");
  dead = true;
  await hub.resume(id);
  assert.equal(calls.filter(call => call.type === "create").length, 0, "a plain resume trusts the stale binding");
  await hub.reopenFailed(id);
  assert.deepEqual(calls.filter(call => call.type === "create").map(call => call.sessionPath), [file]);
  assert.equal((await hub.resume(id)).live?.activeSessionId, "new-worker");
});
