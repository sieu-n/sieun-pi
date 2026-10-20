// Guards the 10-20 05:59Z to 06:03Z refusals: the Mac's daemon held job 01a156cd as an inactive subagent of its chat's tree and as resident
// worker 0aceb76b0e2b, the catalog's row read saved, and every resume's create answered "Ambiguous resident session path".
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

for (const refusal of ["ambiguous", "already active"] as const) {
  test(`a resume whose create the daemon refuses as ${refusal} attaches to the worker that runs the session`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "resume-resident-"));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "ship the virev mcp db tools", timestamp: 1 });
    manager.flushNow();
    const id = manager.getSessionId(), file = manager.getSessionFile()!;
    const base = { sessionId: id, sessionFile: file, cwd: dir, activity: "idle", isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
      sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as const;
    const saved: SessionSummary = { ...base, id, lifecycle: "live", workerState: "ready", isSessionActive: false, runtimeKind: "subagent", rosterStatus: "inactive" } as SessionSummary;
    const running: SessionSummary = { ...base, id: "0aceb76b0e2b", activeSessionId: "0aceb76b0e2b", lifecycle: "live", workerState: "ready", isSessionActive: true } as SessionSummary;
    let refused = false;
    const calls: { type: string; all?: boolean; activeSessionId?: string }[] = [];
    const catalog = new Catalog("/isolated-resume-resident.sock", new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
      { ids: async () => new Set([id]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
      new ThreadOrigins({ ids: async () => [] }));
    t.mock.method(catalog, "connect", async () => {});
    t.mock.method(DaemonClient.prototype, "connect", async () => {});
    t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
    t.mock.method(DaemonClient.prototype, "request", async (command: typeof calls[number]) => {
      calls.push(command);
      switch (command.type) {
        case "list": return { success: true, data: { sessions: [refused && !command.all ? running : saved] } };
        case "create":
          refused = true;
          return { success: false, error: refusal === "ambiguous" ? `Ambiguous resident session path "${file}"` : `Session is already active in 0aceb76b0e2b: ${file}` };
        case "attach":
          return { success: true, data: { activeSessionId: command.activeSessionId, snapshot: { summary: { ...running, activeSessionId: command.activeSessionId },
            state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null, isStreaming: false,
              isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1, sessionActions: { queuedCount: 0 }, contextUsage: null },
            messages: [{ role: "user", content: "ship the virev mcp db tools", timestamp: 1 }], children: [] } } };
        case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
        case "get_heartbeat": return { success: true, data: null };
        default: return { success: true, data: null };
      }
    });
    await catalog.refresh();
    const hub = new ThreadHub("/isolated-resume-resident.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
    t.after(async () => { await hub.close(); await catalog.close(); });
    assert.equal((await hub.resume(id)).live?.activeSessionId, "0aceb76b0e2b");
    assert.equal(calls.filter(call => call.type === "create").length, 1);
    assert.deepEqual(calls.filter(call => call.type === "attach").map(call => call.activeSessionId), ["0aceb76b0e2b"]);
  });
}
