// Guards the d7 dirty minutes of 10-20's Prime updates: the daemons' prepares refused a resume of Mac chat 01a15503 at 15:46:05Z and 15:46:35Z
// and the create of "alert triage Crawler VP 01:13" on us-metal02 at 16:13:12Z ("Daemon is preparing an update restart"), and at 16:13:19Z an
// outbox send to vent met the daemon socket gone during that update's restart. Each start or send now waits for the prepare to end and goes again.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, SessionManager, type SessionSummary } from "prime-agent";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import { PREPARE_WAIT, workerStartThroughUpdates } from "../src/daemon-worker-start.ts";
import { processStartId } from "../src/orphan-services.ts";
import { type PrepareEnd, prepareEnd, updateRecords } from "../src/prime-update.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const SOCKET = "/isolated-update-prepare.sock";
const PREPARING = { success: false, error: "Daemon is preparing an update restart", errorInfo: { code: "update_restarting" } };

/** An update record of `phase` whose coordinator is this test process, so it counts as running (src/prime-update.ts). */
async function writeRecord(agentDir: string, phase: string): Promise<void> {
  await mkdir(join(agentDir, "update-restarts"), { recursive: true });
  await writeFile(join(agentDir, "update-restarts", "ctl-test.json"), JSON.stringify({ version: 1, requestId: "test-update", socketPath: SOCKET, phase,
    coordinator: { pid: process.pid, processStartId: await processStartId(process.pid) }, startedAt: new Date().toISOString() }));
}

const until = async (done: () => boolean) => { while (!done()) await new Promise(resolve => setTimeout(resolve, 5)); };

/** A hub over a fake daemon with one saved session, whose creates answer from `creates` in turn, and a temp agent dir for update records. */
async function rig(t: TestContext, creates: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "update-prepare-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "keep the board", timestamp: 1 });
  manager.flushNow();
  const id = manager.getSessionId(), file = manager.getSessionFile()!;
  const base = { sessionId: id, sessionFile: file, cwd: dir, activity: "idle", isStreaming: false, isCompacting: false, attachedClients: 0, messageCount: 1,
    sessionActions: { queuedCount: 0, steering: [], followUps: [] } } as const;
  const saved = { ...base, id, lifecycle: "live", workerState: "ready", isSessionActive: false } as unknown as SessionSummary;
  const listeners: ((message: unknown) => void)[] = [];
  const calls: { type: string; activeSessionId?: string }[] = [];
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  t.mock.method(DaemonClient.prototype, "onMessage", (listener: (message: unknown) => void) => { listeners.push(listener); return () => {}; });
  t.mock.method(DaemonClient.prototype, "request", async (command: typeof calls[number]) => {
    calls.push(command);
    switch (command.type) {
      case "list": return { success: true, data: { sessions: [saved] } };
      case "create": return creates.shift() ?? { success: true, data: { sessionId: id, activeSessionId: "worker-2" } };
      case "attach":
        return { success: true, data: { activeSessionId: command.activeSessionId, snapshot: { summary: { ...saved, activeSessionId: command.activeSessionId },
          state: { sessionId: id, sessionFile: file, cwd: dir, thinkingLevel: "high", availableThinkingLevels: ["high"], model: null, isStreaming: false,
            isCompacting: false, isBashRunning: false, retryAttempt: 0, messageCount: 1, sessionActions: { queuedCount: 0 }, contextUsage: null },
          messages: [{ role: "user", content: "keep the board", timestamp: 1 }], children: [] } } };
      case "get_queue": return { success: true, data: { steering: [], followUp: [] } };
      default: return { success: true, data: null };
    }
  });
  const catalog = new Catalog(SOCKET, new ChatReadState(join(dir, "reads.json")), new ChatLabels(join(dir, "labels.json")),
    { ids: async () => new Set([id]), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [] }));
  t.mock.method(catalog, "connect", async () => {});
  await catalog.refresh();
  const hub = new ThreadHub(SOCKET, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); await catalog.close(); });
  const agentDir = join(dir, "agent");
  hub.updates = updateRecords(agentDir, SOCKET);
  const creates_ = () => calls.filter(call => call.type === "create").length;
  return { id, hub, agentDir, calls, creates: creates_, hello: (generation: string) => { for (const listener of listeners) listener({ type: "daemon_hello", supervisorGeneration: generation }); } };
}

test("a resume the daemon refused while it prepared an update goes again once this box's update record ends, and a second ask joins it", async t => {
  const { id, hub, agentDir, creates } = await rig(t, [PREPARING]);
  await writeRecord(agentDir, "preparing");
  const first = hub.resume(id);
  await until(() => creates() === 1);
  const second = hub.resume(id, false, "open");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(creates(), 1, "nothing starts again while the prepare runs");
  await writeRecord(agentDir, "failed");
  assert.equal((await first).live?.activeSessionId, "worker-2");
  assert.equal(await second, await first);
  assert.equal(creates(), 2, "one more create after the prepare ended, for both asks");
});

test("a resume waiting out a prepare yields to the owner's Stop meanwhile and does not start again", async t => {
  const { id, hub, agentDir, creates } = await rig(t, [PREPARING]);
  await writeRecord(agentDir, "preparing");
  const resumed = hub.resume(id).then(() => "resumed", (error: Error) => error.message);
  await until(() => creates() === 1);
  hub.ownerStopped(id);
  assert.equal(await resumed, "Daemon is preparing an update restart", "the Stop cancels the wait while the prepare still runs");
  assert.equal(creates(), 1);
});

test("a create the daemon refused while it prepared goes again when the daemon's next hello names a new supervisor", async t => {
  const { hub, agentDir, creates, hello, calls } = await rig(t, [PREPARING]);
  await writeRecord(agentDir, "stopping");
  const created = hub.create({ cwd: agentDir, name: "alert triage Crawler VP 01:13" });
  await until(() => creates() === 1);
  hello("generation-2");
  assert.ok((await created).id);
  assert.equal(creates(), 2);
  assert.equal(calls.filter(call => call.type === "create").length, 2);
});

test("a send that found this box's daemon down while its update ran waits for the update and names the restart", async t => {
  const { hub, agentDir } = await rig(t, []);
  await writeRecord(agentDir, "starting_daemon");
  const window = await hub.updateWindow(null, new Error("The Prime Agent daemon on us-metal02 is not reachable. Failed to connect to the Prime Agent daemon: connect ENOENT /tmp/prime-agent-1001/daemon.sock."));
  assert.equal(window?.kind, "restart");
  await writeRecord(agentDir, "complete");
  assert.equal(await window!.ended, "update ended");
  assert.equal(await hub.updateWindow(null, new Error("The Prime Agent daemon on us-metal02 is not reachable.")), null, "no update runs, so a down daemon is no update window");
  await writeRecord(agentDir, "starting_daemon");
  assert.equal(await hub.updateWindow(null, new Error("Connection to the Prime Agent daemon closed")), null, "a link closed after the write may have delivered the send");
  assert.equal(await hub.updateWindow(null, new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "send_message".')), null);
});

test("a down daemon's window whose update record ends before the wait reads it again ends at once, not by the 100 s deadline", async t => {
  const { hub } = await rig(t, []);
  const update = { requestId: "test-update", phase: "starting_daemon", startedAt: "", file: "ctl-test.json" };
  let reads = 0;
  hub.updates = { running: async () => (++reads === 1 ? update : null), watch: () => () => {} };
  const window = await hub.updateWindow(null, new Error("The Prime Agent daemon on us-metal02 is not reachable."));
  assert.equal(window?.kind, "restart");
  const late = new Promise<string>(done => { const timer = setTimeout(() => done("still waiting"), 2000); t.after(() => clearTimeout(timer)); });
  assert.equal(await Promise.race([window!.ended, late]), "update ended");
});

test("an agent outbox send refused by the prepare waits for it, goes again with no backoff, and writes no failed try", async t => {
  const dir = await mkdtemp(join(tmpdir(), "update-prepare-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  let sends = 0, backoffs = 0;
  let end!: (how: PrepareEnd) => void;
  const ended = new Promise<PrepareEnd>(resolve => { end = resolve; });
  const outbox = new AgentOutbox(dir, {
    log: line => { lines.push(line); },
    send: async () => { if (++sends === 1) throw new Error("Daemon is preparing an update restart"); return "sent"; },
    target: async () => ({ queued: [], busy: false }),
    fileOf: async () => null,
    updateWindow: async (_host, error) => /preparing an update/.test(String(error)) ? { kind: "prepare", ended } : null,
    sleep: () => { backoffs++; return new Promise(done => setImmediate(done)); },
  });
  t.after(() => outbox.close());
  await outbox.deliver("01a156ef-0000-7000-8000-000000000001", "[wake] vent typesafe light root cause");
  await until(() => lines.some(line => line.includes("met the daemon's update prepare")));
  end("restarted");
  await outbox.outbox.idle();
  assert.equal(sends, 2);
  assert.equal(backoffs, 0);
  assert.ok(!lines.some(line => / try \d/.test(line)), lines.join("\n"));
  assert.deepEqual(readServiceFaults(lines.map(line => `2026-10-20T16:13:13.000Z ${line}`), "us-metal02"), []);
});

test("d7 counts no fault for a start that waits out a prepare, and books a resume of another box's session on that box", () => {
  const faults = readServiceFaults([
    `2026-10-20T16:13:12.943Z daemon create alert triage Crawler VP 01:13: refused in 0.0 s: Daemon is preparing an update restart; ${PREPARE_WAIT}`,
    "2026-10-20T16:14:20.000Z daemon create alert triage Crawler VP 01:13: the update prepare ended (restarted) after 67.1 s; it starts again",
    "2026-10-20T16:14:20.100Z daemon create alert triage Crawler VP 01:13: answered in 2.2 s",
    "2026-10-20T15:46:05.371Z daemon resume 01a15503 on mac: refused in 0.2 s: Session worker is failed",
  ], "us-metal02");
  assert.deepEqual(faults.map(fault => [fault.host, fault.session ?? fault.title]), [["mac", "01a15503"]]);
});

test("another box's prepare, whose records this box cannot read, ends by the daemon's own deadline when no new hello comes", async () => {
  const client = { hello: { supervisorGeneration: "generation-1" }, onMessage: () => () => {} } as unknown as Pick<DaemonClient, "hello" | "onMessage">;
  assert.equal(await prepareEnd(client, null, { deadlineMs: 20 }), "deadline passed");
  assert.equal(await prepareEnd(client, null, { deadlineMs: 50, waitMs: 20 }), "gave up", "a wait past UPDATE_WAIT_MS ends with no prepare end");
});

test("a start whose wait passes UPDATE_WAIT_MS fails as before, and d7 counts that refusal", async () => {
  const lines: string[] = [];
  let tries = 0;
  const answer = await workerStartThroughUpdates("create check-in vent 01:13", async () => { tries++; return PREPARING; }, async () => "gave up", undefined, undefined,
    line => { lines.push(line); });
  assert.equal(answer, PREPARING);
  assert.equal(tries, 1);
  assert.equal(readServiceFaults(lines, "us-metal02").length, 1, lines.join("\n"));
});
