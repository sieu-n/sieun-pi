// Guards the keyed write of src/daemon-write.ts against a fake daemon that keeps Prime's command journal (docs/daemon.md, "Idempotency and
// Crash Recovery"): a resend of a finished command answers its stored result, one still running answers command_result_uncertain.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonWriter, WRITE_CLIENT_ID, WriteUncertain, type WriteSlot } from "../src/daemon-write.ts";

type Entry = { response?: Record<string, unknown> };

/** A daemon whose send_message runs after `holdMs` and is counted in `ran`; `supervisor` names its hello's owner token. */
async function fakeDaemon(holdMs: number, supervisor = "supervisor-1") {
  const dir = await mkdtemp(join(tmpdir(), "keyed-write-"));
  const socketPath = join(dir, "d.sock");
  const ran: string[] = [];
  const acks: string[] = [];
  const clientIds = new Set<string>();
  const entries = new Map<string, Entry>();
  const state = { supervisor, holdMs };
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, supervisorOwnerToken: state.supervisor }) + "\n");
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const envelope = JSON.parse(buffer.slice(0, end)) as { clientId: string; command: { id: string; type: string; commandId?: string; message?: string } };
        buffer = buffer.slice(end + 1);
        const { clientId, command } = envelope;
        clientIds.add(clientId);
        if (command.type === "ack_result") { acks.push(command.commandId!); entries.delete(`${clientId} ${command.commandId}`); continue; }
        const key = `${clientId} ${command.id}`;
        const held = entries.get(key);
        if (held?.response) { socket.write(JSON.stringify(held.response) + "\n"); continue; }
        if (held) {
          socket.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "The previous command result is uncertain and was not replayed",
            errorInfo: { code: "command_result_uncertain", clientId, commandId: command.id } }) + "\n");
          continue;
        }
        const entry: Entry = {};
        entries.set(key, entry);
        setTimeout(() => {
          ran.push(command.message!);
          entry.response = { type: "response", id: command.id, command: command.type, success: true, data: { deliveryStatus: "delivered" } };
          if (!socket.destroyed) socket.write(JSON.stringify(entry.response) + "\n");
        }, state.holdMs);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { socketPath, ran, acks, clientIds, entries, state, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

const send = (message: string) => ({ type: "send_message", targetActiveSessionId: "w1", message });

test("a send that timed out runs once: its retry under the same slot reads uncertain while it runs, then its stored answer", async t => {
  const daemon = await fakeDaemon(150);
  t.after(daemon.close);
  const writer = new DaemonWriter(daemon.socketPath);
  t.after(() => writer.close());
  const slot: WriteSlot = {};
  await assert.rejects(writer.request(send("report 1"), slot, 20), /Timed out after 20ms waiting for the Prime Agent daemon response to "send_message"/);
  const id = slot.id;
  assert.ok(id);
  await assert.rejects(writer.request(send("report 1"), slot, 1000), WriteUncertain);
  assert.equal(slot.id, id, "the uncertain answer keeps the id for the next retry");
  await new Promise(done => setTimeout(done, 200));
  // A retry from a new writer, as after a service restart, still matches: the client id is the box's.
  const again = new DaemonWriter(daemon.socketPath);
  t.after(() => again.close());
  assert.deepEqual(await again.request(send("report 1"), slot, 1000), { success: true, data: { deliveryStatus: "delivered" } });
  assert.deepEqual(daemon.ran, ["report 1"]);
  assert.equal(slot.id, undefined, "an answer clears the slot, so the next write gets a new id");
  await new Promise(done => setTimeout(done, 50));
  assert.deepEqual(daemon.acks, [id], "only the answer that came is acknowledged, never the uncertain one");
  assert.deepEqual([...daemon.clientIds], [WRITE_CLIENT_ID]);
});

test("a send another supervisor took and never finished goes once more under a new id", async t => {
  const daemon = await fakeDaemon(60_000, "supervisor-1");
  t.after(daemon.close);
  const writer = new DaemonWriter(daemon.socketPath);
  t.after(() => writer.close());
  const slot: WriteSlot = {};
  await assert.rejects(writer.request(send("report 2"), slot, 20), /Timed out/);
  const lost = slot.id;
  // A new supervisor loads the journal with the command received and no result, and the old process that ran it is gone.
  writer.close();
  daemon.state.supervisor = "supervisor-2";
  daemon.state.holdMs = 5;
  const answer = await writer.request(send("report 2"), slot, 1000);
  assert.equal(answer.success, true);
  assert.notEqual(slot.id, lost);
  assert.deepEqual(daemon.ran, ["report 2"]);
});

test("an answered write clears the slot, so the write that follows it in the same delivery goes under a new id", async t => {
  const daemon = await fakeDaemon(0);
  t.after(daemon.close);
  const writer = new DaemonWriter(daemon.socketPath);
  t.after(() => writer.close());
  const slot: WriteSlot = {};
  await writer.request(send("first"), slot, 1000);
  await writer.request(send("second"), slot, 1000);
  assert.deepEqual(daemon.ran, ["first", "second"]);
});
