// Guards caller bugs from the 10-21 S3 Prime update (restore-message-latency-report.md, "Causes and smallest fixes"). From 11:20:18Z to
// 11:27:46Z the check-in lines and job end notes to chats 01a115e2 and 01a11af8 went 8 times as prompts to their pre-update active ids
// ef0b3805c965 and f222d4f77262, because the hub kept its binding to the worker the update replaced, and a prompt by a held id never reopened.
// At 14:06:43Z and 14:10:15Z a resume_queue for Mac chats 01a11b0b and 01a11ba8 went to this box's daemon, because the hub picked the box by
// the new active id, which the Mac's catalog names only after its next list.
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

type Call = { type: string; activeSessionId?: string; message?: string; via?: string };

async function liveChat(t: TestContext, prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "watch the crawler", timestamp: 1 });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const state = { worker: "old-worker" };
  const row = (): SessionSummary => ({ id: state.worker, sessionId: id, sessionFile: file, cwd: dir, activeSessionId: state.worker, lifecycle: "live", workerState: "ready",
    activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] } });
  const calls: Call[] = [];
  const answer = (command: Call) => {
    switch (command.type) {
      case "list": return { success: true, data: { sessions: [row()] } };
      case "attach":
        if (command.activeSessionId !== state.worker) return { success: false, error: `Unknown active session: ${command.activeSessionId}` };
        return { success: true, data: { activeSessionId: state.worker, snapshot: { summary: row(),
          state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null, isStreaming: false,
            isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1, sessionActions: { queuedCount: 0 }, contextUsage: null },
          messages: [{ role: "user", content: "watch the crawler", timestamp: 1 }], children: [] } } };
      case "prompt": case "resume_queue": case "get_state":
        if (command.activeSessionId !== state.worker) return { success: false, error: `Unknown active session: ${command.activeSessionId}` };
        return { success: true, data: command.type === "get_state" ? { isSessionActive: false } : undefined };
      case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
      case "get_heartbeat": return { success: true, data: null };
      default: return { success: true, data: null };
    }
  };
  const catalog = new Catalog(`/isolated-${prefix}.sock`, new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  writesThroughClient(t);
  t.mock.method(DaemonClient.prototype, "request", async (command: Call) => { calls.push({ ...command, via: "box" }); return answer(command); });
  await catalog.refresh();
  const hub = new ThreadHub(`/isolated-${prefix}.sock`, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); await catalog.close(); });
  return { id, hub, catalog, calls, state, answer };
}

test("a prompt to a chat whose bound worker an update restart replaced goes to its new worker", async t => {
  const { id, hub, catalog, calls, state } = await liveChat(t, "stale-active-");
  await hub.resume(id);
  state.worker = "new-worker";
  await catalog.refresh();
  await hub.prompt(id, { message: "[check-in] job line", images: [], mode: "steer" }, "restart");
  assert.deepEqual(calls.filter(call => call.type === "prompt").map(call => call.activeSessionId), ["old-worker", "new-worker"],
    "the refused prompt to the replaced worker goes once more to the worker the restore started");
});

test("a resume_queue for a Mac chat goes to the Mac while the Mac's catalog does not name its new active id yet", async t => {
  const { id, hub, catalog, calls, answer } = await liveChat(t, "resume-host-");
  const mac = { request: async (command: Call) => { calls.push({ ...command, via: "mac" }); return answer(command); } };
  t.mock.method(catalog, "hostOf", (asked: string) => asked === id ? "mac" : null);
  t.mock.method(catalog, "hostClient", async (name?: string | null) => name === "mac" ? mac : catalog.client);
  t.mock.method(catalog, "socketPathFor", () => "/isolated-resume-host-mac.sock");
  await hub.resume(id);
  await hub.resumeQueue(id);
  assert.deepEqual(calls.filter(call => call.type === "resume_queue").map(call => call.via), ["mac"]);
});
