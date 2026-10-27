import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Server } from "node:net";
import * as registry from "../../pi-family/registry.ts";
import { hostApi } from "../src/api.ts";
import { HostClient } from "../src/client.ts";
import { PiHost } from "../src/host.ts";
import { lockPathOf } from "../src/lease.ts";
import type { SessionSummary } from "../src/protocol.ts";
import { listen } from "../src/server.ts";
import echo from "./fixtures/echo.ts";
import { fauxProvider } from "../../pi-testkit/faux.ts";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

let root: string;
let host: PiHost;
let server: Server;
let socket: string;
let client: HostClient;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-host-test-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  host = new PiHost({
    agentDir, sessionDir: join(root, "sessions"), defaultCwd: join(root, "ws"), extensionFactories: [echo], defaultModel: { provider: "echo", id: "m" },
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, chunkBytes: 200, log: () => {},
  });
  socket = join(root, "host.sock");
  server = await listen(host, socket);
  client = await HostClient.connect(socket);
});

after(async () => {
  client.close();
  await host.shutdown();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const create = async (extra: Record<string, unknown> = {}) => client.call<SessionSummary>({ type: "create", lifecycle: "resident", ...extra } as never);

const attachedIds = new Set<string>();
async function watch(id: string): Promise<void> {
  if (attachedIds.has(id) && host.sessions.get(id)?.sinks.size) return;
  await client.call({ type: "attach", activeSessionId: id, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] });
  attachedIds.add(id);
}

async function promptAndWait(id: string, message: string): Promise<void> {
  await watch(id);
  const seq = host.sessions.get(id)!.sequence;
  await client.call({ type: "prompt", activeSessionId: id, message });
  await client.waitForAgentEnd(id, seq);
}

test("hello names the v7 protocol and the capabilities the chat checks", () => {
  assert.equal(client.hello.protocol.version, 7);
  assert.ok(client.hello.serverCapabilities.includes("session_input_admission"));
  assert.ok(client.hello.serverCapabilities.includes("chunked_snapshot"));
});

test("create, attach with a chunked snapshot, prompt, and stream events with a cursor", async () => {
  const summary = await create({ name: "first" });
  assert.equal(summary.activeSessionId, summary.sessionId);
  assert.equal(summary.sessionName, "first");
  assert.equal(summary.model?.provider, "echo");
  await promptAndWait(summary.activeSessionId, "hello there");
  await promptAndWait(summary.activeSessionId, "second turn");
  const attacher = await HostClient.connect(socket);
  const attached = await attacher.call<{ snapshotStream: { id: string; messageCount: number }; lastEventCursor: { generation: string; sequence: number } }>({
    type: "attach", activeSessionId: summary.activeSessionId, capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
  });
  assert.equal(attached.snapshotStream.messageCount, 5, "Pi 1.4 keeps a system message first, then two user and two assistant messages");
  const end = await attacher.waitFor(line => line.type === "session_snapshot_end");
  const chunks = attacher.lines.filter(line => line.type === "session_snapshot_chunk");
  assert.ok(chunks.length >= 2, "200-byte chunks split five messages");
  assert.equal(end.type === "session_snapshot_end" && end.chunkCount, chunks.length);
  const seq = attached.lastEventCursor.sequence;
  await client.call({ type: "prompt", activeSessionId: summary.activeSessionId, message: "third" });
  const done = await attacher.waitForAgentEnd(summary.activeSessionId, seq);
  assert.equal(done.type === "session_event" && done.meta.cursor.generation, attached.lastEventCursor.generation);
  const text = await client.call<{ text: string }>({ type: "get_last_assistant_text", activeSessionId: summary.activeSessionId });
  assert.equal(text.text, "echo: third");
  attacher.close();
});

test("attach with a cursor in the buffer replays the missed events", async () => {
  const summary = await create();
  await promptAndWait(summary.activeSessionId, "one");
  const before = host.sessions.get(summary.activeSessionId)!.cursor();
  await promptAndWait(summary.activeSessionId, "two");
  const late = await HostClient.connect(socket);
  const attached = await late.call<{ replay: { status: string } }>({ type: "attach", activeSessionId: summary.activeSessionId, capabilities: ["attach_snapshot", "event_sequence"], resumeCursor: before });
  assert.equal(attached.replay.status, "complete");
  const replayed = late.lines.filter(line => line.type === "session_event" && line.meta.replayed);
  assert.ok(replayed.length > 3);
  assert.ok(replayed.some(line => line.type === "session_event" && line.event.type === "agent_end"));
  const stale = await late.call<{ replay: { status: string } }>({ type: "attach", activeSessionId: summary.activeSessionId, capabilities: ["attach_snapshot"], resumeCursor: { generation: "old", sequence: 1 } });
  assert.equal(stale.replay.status, "unavailable");
  late.close();
});

test("prompt lanes: a busy session takes steer and follow-up, queueIfBusy and queue edits", async () => {
  const summary = await create();
  const id = summary.activeSessionId;
  await watch(id);
  const seq = host.sessions.get(id)!.sequence;
  await client.call({ type: "prompt", activeSessionId: id, message: "slow start" });
  const busy = await client.request({ type: "prompt", activeSessionId: id, message: "no lane" });
  assert.equal(busy.success, false);
  await client.call({ type: "prompt", activeSessionId: id, message: "queued by flag", queueIfBusy: true });
  await client.call({ type: "follow_up", activeSessionId: id, message: "follow one" });
  await client.call({ type: "steer", activeSessionId: id, message: "steer one" });
  const queue = await client.call<{ steering: string[]; followUp: string[] }>({ type: "get_queue", activeSessionId: id });
  assert.deepEqual(queue.steering, ["steer one"]);
  assert.deepEqual(queue.followUp, ["queued by flag", "follow one"]);
  const edit = await client.call<{ status: string }>({ type: "mutate_queued_message", activeSessionId: id, lane: "followUp", index: 1, expectedText: "follow one", mutation: { type: "replace", text: "follow edited" } });
  assert.equal(edit.status, "applied");
  const wrong = await client.call<{ status: string }>({ type: "mutate_queued_message", activeSessionId: id, lane: "followUp", index: 0, expectedText: "nope", mutation: { type: "delete" } });
  assert.equal(wrong.status, "rejected");
  await client.waitFor(line => line.type === "session_event" && line.activeSessionId === id && line.event.type === "agent_end" && line.meta.sequence > seq
    && host.sessions.get(id)!.session.getLastAssistantText() === "echo: follow edited", 20_000);
  const texts = host.sessions.get(id)!.session.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.map(p => ("text" in p ? p.text : "")).join(""));
  assert.deepEqual(texts, ["slow start", "steer one", "queued by flag", "follow edited"]);
});

test("abort stops a run and the next prompt runs with no resume_queue", async () => {
  const summary = await create();
  const id = summary.activeSessionId;
  await client.call({ type: "prompt", activeSessionId: id, message: "slow to abort" });
  await client.call({ type: "abort", activeSessionId: id });
  await client.call({ type: "resume_queue", activeSessionId: id });
  await promptAndWait(id, "after abort");
  assert.equal(host.sessions.get(id)!.session.getLastAssistantText(), "echo: after abort");
});

test("kill keeps the session restorable, and a prompt or send_message reopens it", async () => {
  const summary = await create({ name: "sleeper" });
  const id = summary.activeSessionId;
  await promptAndWait(id, "remember me");
  const events: string[] = [];
  const stop = hostApi()!.onEvent(event => { if (event.type !== "session_event" && event.sessionId === id) events.push(`${event.type}:${"reason" in event ? event.reason : ""}`); });
  await client.call({ type: "kill", activeSessionId: id });
  assert.equal(host.sessions.has(id), false);
  stop();
  assert.deepEqual(events, ["closing:killed", "closed:killed"]);
  assert.equal(existsSync(lockPathOf(summary.sessionFile!)), false, "kill releases the lockfile");
  const listed = await client.call<{ sessions: SessionSummary[] }>({ type: "list", all: true });
  assert.equal(listed.sessions.find(row => row.sessionId === id)?.rosterStatus, "inactive");
  const sent = await client.call<{ delivery: string }>({ type: "send_message", targetActiveSessionId: id, message: "wake up" });
  assert.equal(sent.delivery, "started");
  assert.equal(host.sessions.has(id), true);
  await host.sessions.get(id)!.session.waitForIdle();
  const users = host.sessions.get(id)!.session.messages.filter(m => m.role === "user").length;
  assert.equal(users, 2, "the reopened session kept its first turn");
  assert.equal(host.sessions.get(id)!.session.sessionName, "sleeper");
});

test("send_message to a busy session queues a steer, and a registry entry's own deliver wins", async () => {
  const summary = await create();
  const id = summary.activeSessionId;
  await client.call({ type: "prompt", activeSessionId: id, message: "slow busy" });
  const sent = await client.call<{ delivery: string }>({ type: "send_message", targetActiveSessionId: id, message: "while busy", deliveryMode: "steer" });
  assert.equal(sent.delivery, "queued");
  const got: string[] = [];
  registry.register({ id: "bus-target", name: "bus", role: "root", depth: 0, cwd: root, activity: () => "idle", preview: () => [], deliver: async message => { got.push(message.text); return "started"; } });
  const api = hostApi()!;
  assert.equal(await api.deliver("bus-target", { id: "m1", from: { id: "x", name: "x", role: "owner" }, text: "via registry", mode: "auto", sentAt: Date.now() }), "started");
  assert.deepEqual(got, ["via registry"]);
  registry.unregister("bus-target");
});

test("leases: a second create of an open file returns the same session, and a lockfile from another live process refuses it", async () => {
  const summary = await create();
  await promptAndWait(summary.activeSessionId, "write the file");
  const again = await create({ sessionPath: summary.sessionFile });
  assert.equal(again.activeSessionId, summary.activeSessionId);
  await client.call({ type: "kill", activeSessionId: summary.activeSessionId });
  writeFileSync(lockPathOf(summary.sessionFile!), JSON.stringify({ pid: 1, owner: "pi-cli", sessionId: summary.sessionId, at: "" }));
  const refused = await client.request({ type: "create", sessionPath: summary.sessionFile } as never);
  assert.equal(refused.success, false);
  assert.equal(!refused.success && refused.errorInfo?.code, "session_locked");
  rmSync(lockPathOf(summary.sessionFile!));
  const reopened = await create({ sessionPath: summary.sessionFile });
  assert.equal(reopened.sessionId, summary.sessionId);
});

test("roster_subscribe gets a resync and live updates, and get_* reads answer", async () => {
  const watcher = await HostClient.connect(socket);
  await watcher.call({ type: "roster_subscribe" });
  await watcher.waitFor(line => line.type === "roster_update" && line.resync === true);
  const summary = await create({ name: "rostered" });
  await watcher.waitFor(line => line.type === "roster_update" && line.changed.some(entry => entry.agentId === summary.sessionId));
  const id = summary.activeSessionId;
  for (const type of ["get_state", "get_connection_state", "get_messages", "get_session_stats", "get_commands", "get_model_catalog", "get_session_context", "get_system_prompt", "get_rlm_children", "cron_list", "heartbeats_list", "heartbeat_get"] as const) {
    const response = await client.request({ type, activeSessionId: id } as never);
    assert.equal(response.success, true, `${type}: ${!response.success ? response.error : ""}`);
  }
  await client.call({ type: "set_thinking_level", activeSessionId: id, level: "low" });
  await client.call({ type: "rename", activeSessionId: id, name: "renamed" });
  await client.call({ type: "append_custom_message", activeSessionId: id, message: { customType: "note", content: "a notice", display: true } });
  await client.call({ type: "reload", activeSessionId: id });
  const state = await client.call<SessionSummary>({ type: "get_state", activeSessionId: id });
  assert.equal(state.sessionName, "renamed");
  const unknown = await client.request({ type: "fork", activeSessionId: id } as never);
  assert.match(!unknown.success ? unknown.error : "", /Unknown daemon command: fork/);
  const saved = await client.call<{ sessions: unknown[] }>({ type: "list_saved_sessions", scope: "all", sessionDir: join(root, "sessions") } as never);
  assert.ok(saved.sessions.length >= 3);
  watcher.close();
});

test("idle unload disposes an idle session with no client and a prompt restores it", async () => {
  const idle = new PiHost({
    agentDir: join(root, "agent"), sessionDir: join(root, "sessions-idle"), defaultCwd: join(root, "ws"), extensionFactories: [echo], defaultModel: { provider: "echo", id: "m" },
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, idleUnloadMs: 300, log: () => {},
  });
  try {
    const session = await idle.openSession({});
    await idle.startPrompt(session, "before unload");
    await session.session.waitForIdle();
    const id = session.id;
    await new Promise(resolve => setTimeout(resolve, 1800));
    assert.equal(idle.sessions.has(id), false);
    assert.ok(registry.dormantOf(id));
    const entryless = await idle.deliver(id, { id: "m2", from: { id: "o", name: "owner", role: "owner" }, text: "after unload", mode: "auto", sentAt: Date.now() });
    assert.equal(entryless, "started");
    await idle.sessions.get(id)!.session.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(idle.sessions.get(id)!.session.getLastAssistantText(), "echo: after unload");
  } finally {
    await idle.shutdown();
  }
});

test("a new session with no model asked gets the host default over the agent dir's default, and a reopened one keeps its own", async () => {
  const agentDir = join(root, "agent-default");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "other", defaultModel: "m" }));
  const other = fauxProvider("other", "m");
  const make = (defaultModel: { provider: string; id: string }) => new PiHost({
    agentDir, sessionDir: join(root, "sessions-default"), defaultCwd: join(root, "ws"), extensionFactories: [echo, other.factory], defaultModel,
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, log: () => {},
  });
  const first = make({ provider: "echo", id: "m" });
  let file: string | undefined;
  try {
    const session = await first.openSession({});
    assert.equal(session.session.model?.provider, "echo");
    await first.startPrompt(session, "pin the model");
    await session.session.waitForIdle();
    file = session.session.sessionFile;
  } finally {
    await first.shutdown();
  }
  const second = make({ provider: "other", id: "m" });
  try {
    const reopened = await second.openSession({ sessionPath: file });
    assert.equal(reopened.session.model?.provider, "echo");
  } finally {
    await second.shutdown();
  }
});
