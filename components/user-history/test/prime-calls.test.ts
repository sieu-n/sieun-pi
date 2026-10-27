// Guards option C of the prime-under-load page (10-27): the chat service logged no line for a Prime call, so the board had no p50, p99 or
// error rate per method. Every DaemonClient call now adds one line to prime-calls.jsonl.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "prime-agent";
import { CallLog, hostOf, logPrimeCalls, outcomeOfError, type PrimeCall } from "../src/prime-calls.ts";

const HELLO = `${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, appVersion: "fixture", serverCapabilities: ["agent_roster"] })}\n`;

/** A daemon that answers get_state with success, kill with a refusal, and send_message never. */
async function fakeDaemon(t: TestContext, socketPath: string): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.write(HELLO);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { type: string; id: string; command?: { type: string } };
        buffer = buffer.slice(end + 1);
        const type = line.command?.type ?? line.type;
        if (type === "ack_result" || type === "send_message") continue;
        const answer = type === "kill" ? { success: false, error: "Unknown active session: gone12345678" } : { success: true, data: {} };
        socket.write(`${JSON.stringify({ type: "response", id: line.id, command: type, ...answer })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
}

test("each daemon call and hello wait adds one line with its method, target, box, time and outcome", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "prime-calls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "hosts"));
  const socketPath = join(dir, "hosts", "mac.sock");
  await fakeDaemon(t, socketPath);
  const log = new CallLog(join(dir, "prime-calls.jsonl"));
  const undo = logPrimeCalls(log, () => new Date("2026-10-27T01:00:00.000Z"));
  t.after(undo);

  const client = new DaemonClient(socketPath);
  t.after(() => client.close());
  await client.connect(1000);
  await client.waitForHello(1000);
  await client.request({ type: "get_state", activeSessionId: "abc123def456" } as Parameters<DaemonClient["request"]>[0], 1000);
  const refused = await client.request({ type: "kill", activeSessionId: "gone12345678" } as Parameters<DaemonClient["request"]>[0], 1000);
  assert.equal(refused.success, false);
  await assert.rejects(client.request({ type: "send_message", targetActiveSessionId: "busy00000000", message: "hi" } as Parameters<DaemonClient["request"]>[0], 50, { recoverable: false }), /Timed out after 50ms/);
  await log.flushed();

  const calls = (await readFile(join(dir, "prime-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as PrimeCall);
  const shape = calls.map(({ method, target, host, outcome, ts, src }) => ({ method, target, host, outcome, ts, src }));
  const at = "2026-10-27T01:00:00.000Z";
  assert.deepEqual(shape, [
    { method: "hello", target: undefined, host: "mac", outcome: "ok", ts: at, src: "chat" },
    { method: "get_state", target: "abc123def456", host: "mac", outcome: "ok", ts: at, src: "chat" },
    { method: "kill", target: "gone12345678", host: "mac", outcome: "refused", ts: at, src: "chat" },
    { method: "send_message", target: "busy00000000", host: "mac", outcome: "timeout", ts: at, src: "chat" },
  ]);
  assert.match(calls[2]!.error!, /Unknown active session/);
  assert.ok(calls[3]!.ms >= 50, `${calls[3]!.ms} ms`);
  assert.equal(calls[1]!.error, undefined);
});

test("a call to a client that is not connected is logged as closed, and the undo stops the lines", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "prime-calls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "prime-calls.jsonl");
  const log = new CallLog(file);
  const undo = logPrimeCalls(log);
  const client = new DaemonClient(join(dir, "daemon.sock"));
  await assert.rejects(client.request({ type: "list" } as Parameters<DaemonClient["request"]>[0], 100), /not connected/);
  undo();
  await assert.rejects(client.request({ type: "list" } as Parameters<DaemonClient["request"]>[0], 100), /not connected/);
  await log.flushed();
  const calls = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as PrimeCall);
  assert.deepEqual(calls.map(call => [call.method, call.outcome, call.host]), [["list", "closed", undefined]]);
});

test("only a bridge socket names a box", () => {
  assert.equal(hostOf("/tmp/x/hosts/us-metal02.sock"), "us-metal02");
  assert.equal(hostOf("/tmp/prime-agent-1000/daemon.sock"), undefined);
});

// Prime load-e (10-27): a session no worker can serve fails as DaemonSessionUnavailableError, code session_unavailable, with its state. Prime's
// own call log counts it refused, so the chat's line does too.
test("a thrown DaemonSessionUnavailableError is a refused call, whatever its state", () => {
  class DaemonSessionUnavailableError extends Error {
    readonly code = "session_unavailable";
    constructor(readonly activeSessionId: string, readonly state: string) {
      super(state === "unknown" ? `Unknown active session: ${activeSessionId}` : `Session worker is ${state}`);
      this.name = "DaemonSessionUnavailableError";
    }
  }
  assert.deepEqual(outcomeOfError(new DaemonSessionUnavailableError("01a154c3", "unknown")), { outcome: "refused", error: "Unknown active session: 01a154c3" });
  assert.deepEqual(outcomeOfError(new DaemonSessionUnavailableError("01a154c3", "recovering")), { outcome: "refused", error: "Session worker is recovering" });
  assert.deepEqual(outcomeOfError(Object.assign(new Error("Session worker is failed"), { code: "session_unavailable" })), { outcome: "refused", error: "Session worker is failed" });
  assert.equal(outcomeOfError(new Error("boom")).outcome, "error");
});
