// Guards the agent outbox against a send whose worker socket closed after Prime dispatched it. In the load.3.9.8 native proof
// (~/work/prime-load-fixes/integration/load3.9.8-native/idle-unload-send, case 3) the supervisor answered "Daemon worker socket closed", and the
// relaunched worker then ran the message once from its accepted input. The outbox read that answer as a refusal and sent again under a new
// command id, which Prime cannot dedupe, so a resend that came before the recovery landed the message twice. This scripted peer keeps Prime's
// command journal and its worker's admission of one action per operation id [clientId, commandId] (docs/daemon.md, "Idempotency and Crash
// Recovery", prime-agent 4ec5183).
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { DaemonWriter } from "../src/daemon-write.ts";

const SESSION = "01a10810-0000-7000-8000-000000000001";
const CLOSED = "Daemon worker socket closed";
const STOPPING = "Session worker is stopping";

type Command = { id: string; type: string; commandId?: string; message?: string };

/**
 * A daemon socket with one worker. `next` scripts how the worker meets each new dispatch: "closed" admits the input to its accepted-input
 * file and then loses its socket, so the supervisor answers CLOSED and leaves the journal entry open; "refused" answers STOPPING before any
 * dispatch; "ok" runs it. `recover()` stands for the relaunched worker, which delivers each accepted input that is not in the file yet.
 */
async function primePeer(t: TestContext, file: string, next: ("closed" | "refused" | "ok")[]) {
  const dir = await mkdtemp(join(tmpdir(), "closed-after-dispatch-"));
  const socketPath = join(dir, "d.sock");
  const journal = new Map<string, { response?: Record<string, unknown> }>();
  const operations = new Set<string>();
  const accepted: { operation: string; message: string }[] = [];
  const sends: { commandId: string; operation: string }[] = [];
  const acks: string[] = [];
  const sockets = new Set<Socket>();
  const land = (message: string) => appendFile(file, JSON.stringify({ type: "custom", customType: "agent_message", details: { message }, timestamp: new Date().toISOString() }) + "\n");
  const answer = (socket: Socket, command: Command, fields: Record<string, unknown>) =>
    socket.write(JSON.stringify({ type: "response", id: command.id, command: command.type, ...fields }) + "\n");
  const dispatch = async (socket: Socket, clientId: string, command: Command) => {
    const key = JSON.stringify([clientId, command.id]);
    const entry = journal.get(key);
    if (entry?.response) return void socket.write(JSON.stringify(entry.response) + "\n");
    sends.push({ commandId: command.id, operation: key });
    const way = next.shift() ?? "ok";
    if (way === "refused") {
      const response = { type: "response", id: command.id, command: command.type, success: false, error: STOPPING };
      journal.set(key, { response });
      return void socket.write(JSON.stringify(response) + "\n");
    }
    journal.set(key, entry ?? {});
    if (operations.has(key)) {
      const response = { type: "response", id: command.id, command: command.type, success: true, data: { deliveryStatus: "queued" } };
      journal.set(key, { response });
      return void socket.write(JSON.stringify(response) + "\n");
    }
    operations.add(key);
    if (way === "closed") {
      accepted.push({ operation: key, message: command.message! });
      return void answer(socket, command, { success: false, error: CLOSED });
    }
    await land(command.message!);
    const response = { type: "response", id: command.id, command: command.type, success: true, data: { deliveryStatus: "delivered" } };
    journal.set(key, { response });
    socket.write(JSON.stringify(response) + "\n");
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, supervisorOwnerToken: "supervisor-1" }) + "\n");
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const { clientId, command } = JSON.parse(buffer.slice(0, end)) as { clientId: string; command: Command };
        buffer = buffer.slice(end + 1);
        if (command.type === "ack_result") { acks.push(command.commandId!); journal.delete(JSON.stringify([clientId, command.commandId])); continue; }
        if (command.type === "send_message") void dispatch(socket, clientId, command);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const recover = async () => { for (const input of accepted.splice(0)) await land(input.message); };
  return { socketPath, sends, acks, recover };
}

async function setup(t: TestContext, next: ("closed" | "refused" | "ok")[], waited: (peer: Awaited<ReturnType<typeof primePeer>>) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "closed-outbox-"));
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, "");
  const peer = await primePeer(t, file, next);
  const writer = new DaemonWriter(peer.socketPath);
  const lines: string[] = [];
  const outbox = new AgentOutbox(join(dir, "agent-outbox"), {
    log: line => { lines.push(line); }, sleep: () => new Promise(resolve => setTimeout(resolve, 2)).then(() => waited(peer)),
    send: async (session, text, _host, write = {}) => {
      const response = await writer.request({ type: "send_message", targetActiveSessionId: session, message: text }, write, 5_000);
      if (!response.success) throw new Error(response.error);
      return "sent";
    },
    // A worker that is still relaunching has no copy queued and no turn running, so only Prime's own record tells the send was admitted.
    target: async () => ({ queued: [], busy: false }),
    fileOf: async () => file,
  });
  t.after(async () => { await outbox.close(); await outbox.outbox.idle(); writer.close(); await rm(dir, { recursive: true, force: true }); });
  const copies = async (text: string) => (await readFile(file, "utf8")).split("\n").filter(line => line.includes(JSON.stringify(text).slice(1, -1))).length;
  const state = async () => (await outbox.outbox.pending(() => true))?.state ?? "done";
  return { peer, outbox, lines, copies, state };
}

const until = async (done: () => boolean) => { for (let i = 0; i < 2_000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

test("a resend after a worker socket closed past dispatch keeps the command id, so Prime answers it and the recovery lands it once", async t => {
  const box = await setup(t, ["closed"]);
  const text = "[wake] It is 14:19Z, the time you set with board.wake (2026-10-28T14:19:00Z)";
  await box.outbox.deliver(SESSION, text);
  await until(() => box.peer.sends.length >= 2);
  assert.equal(box.peer.sends.length, 2, "the outbox tried a second time before the recovery");
  await box.peer.recover();
  await box.outbox.outbox.idle();
  assert.equal(await box.copies(text), 1, "the message lands once");
  assert.equal(box.peer.sends[1]!.commandId, box.peer.sends[0]!.commandId, "the resend carries the first try's command id, so Prime's operation id matches");
  assert.equal(await box.state(), "done");
});

test("a recovery that lands the message before the next try ends the entry as delivered, with no second send", async t => {
  const box = await setup(t, ["closed"], peer => peer.recover());
  const text = "report: the idle unload send waited and delivered once";
  await box.outbox.deliver(SESSION, text);
  await box.outbox.outbox.idle();
  assert.equal(box.peer.sends.length, 1);
  assert.equal(await box.copies(text), 1);
  assert.ok(box.lines.some(line => / is landed from the send at /.test(line)), `the entry ends as delivered from the first send: ${JSON.stringify(box.lines)}`);
  assert.ok(!box.lines.some(line => /obsolete/.test(line)), "a landed send is not counted as a needless one");
});

test("a refusal Prime gives before dispatch still goes again under a new command id, as before", async t => {
  const box = await setup(t, ["refused"]);
  const text = "report: the worker was stopping";
  await box.outbox.deliver(SESSION, text);
  await box.outbox.outbox.idle();
  assert.equal(box.peer.sends.length, 2);
  assert.notEqual(box.peer.sends[1]!.commandId, box.peer.sends[0]!.commandId);
  assert.equal(await box.copies(text), 1);
  assert.ok(!box.lines.some(line => line.includes("may have gone")), JSON.stringify(box.lines));
});
