import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HostClient } from "@sieun-pi/pi-host/client";
import type { SessionSummary } from "@sieun-pi/pi-host/protocol";
import { kernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { startHost, type RunningHost } from "./host-rig.ts";
import { landed, openAgent, until, type Opened } from "./rig.ts";

/**
 * send_message idempotency across a host death. A proxy sits between the sender and pi-host, and when pi-host writes the answer to a marked
 * send, the proxy drops that answer and kills pi-host with SIGKILL. So the host accepted the message, and the sender never learned it.
 * After a restart, the sender's retry with the same client id and command id must not deliver the message again. Each target has one
 * finished turn first, because Pi writes no session file before that, and a host death would lose a session that has none.
 */

let root: string;
let host: RunningHost;
let proxy: Server;
let proxySocket: string;
let killOn: string | undefined;
let killed = 0;
const opened: Opened[] = [];

function hostSocket(): string {
  return join(root, "h", "host.sock");
}

before(async () => {
  root = mkdtempSync(join(process.env.BUS_LOAD_ROOT ?? tmpdir(), "agent-bus-idem-"));
  host = await startHost(root, "h");
  proxySocket = join(root, "proxy.sock");
  proxy = createServer((client: Socket) => {
    const upstream = createConnection(hostSocket());
    let buf = "";
    upstream.on("data", chunk => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line) as { type?: string; id?: string; command?: string };
        if (killOn && msg.type === "response" && (msg.id === killOn || (killOn === "any send" && msg.command === "send_message"))) {
          killOn = undefined;
          killed += 1;
          void host.stop("SIGKILL");
          client.destroy();
          upstream.destroy();
          return;
        }
        client.write(line);
      }
    });
    client.on("data", chunk => upstream.write(chunk));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(proxySocket, resolve));
});

after(async () => {
  delete process.env.PI_HOST_SOCKET;
  for (const s of opened) await s.runtime.dispose();
  proxy?.close();
  await host?.stop();
  if (process.env.BUS_LOAD_OUT) writeFileSync(`${process.env.BUS_LOAD_OUT}-idempotency-host.log`, host?.log() ?? "");
  if (!process.env.BUS_LOAD_KEEP) rmSync(root, { recursive: true, force: true });
});

/** Sends one v7 envelope line and resolves with the response, or with "closed" when the connection ends first. */
function envelope(socketPath: string, clientId: string, id: string, command: Record<string, unknown>): Promise<{ success?: boolean; data?: any; error?: string } | "closed"> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buf = "";
    let done = false;
    const finish = (value: { success?: boolean; data?: any } | "closed") => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.on("error", error => (done ? undefined : reject(error)));
    socket.on("close", () => finish("closed"));
    socket.on("data", chunk => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.type === "daemon_hello") socket.write(`${JSON.stringify({ type: "command", id, protocol: { name: "prime-agent.daemon", version: 7 }, clientId, command: { ...command, id } })}\n`);
        else if (msg.type === "response" && msg.id === id) finish(msg);
      }
    });
  });
}

async function session(name: string, busyMs?: number): Promise<SessionSummary> {
  const c = await HostClient.connect(hostSocket());
  try {
    const s = await c.call<SessionSummary>({ type: "create", name, lifecycle: "resident" } as never);
    await c.call({ type: "prompt", activeSessionId: s.activeSessionId, message: "hi" } as never);
    for (let i = 0; i < 200 && (await c.call<SessionSummary>({ type: "get_state", activeSessionId: s.activeSessionId } as never)).isStreaming; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (busyMs) {
      await c.call({ type: "prompt", activeSessionId: s.activeSessionId, message: `busy ${busyMs}` } as never);
      for (let i = 0; i < 200 && !(await c.call<SessionSummary>({ type: "get_state", activeSessionId: s.activeSessionId } as never)).isStreaming; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    return await c.call<SessionSummary>({ type: "get_state", activeSessionId: s.activeSessionId } as never);
  } finally {
    c.close();
  }
}

async function idleAfterRestart(id: string): Promise<void> {
  const c = await HostClient.connect(hostSocket());
  try {
    for (let i = 0; i < 600; i += 1) {
      if (!(await c.call<SessionSummary>({ type: "get_state", activeSessionId: id } as never)).isStreaming) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    c.close();
  }
}

const results: Record<string, unknown> = {};

test("a chat client's send whose answer is lost to a host death is not delivered twice by its retry", async () => {
  const target = await session("idle-target");
  killOn = "cmd-1";
  const lost = await envelope(proxySocket, "chat-a", "cmd-1", { type: "send_message", targetActiveSessionId: target.activeSessionId, message: "only once, idle" });
  assert.equal(lost, "closed", "the sender got no answer");
  assert.equal(killed, 1);
  host = await startHost(root, "h");
  const retry = await envelope(hostSocket(), "chat-a", "cmd-1", { type: "send_message", targetActiveSessionId: target.activeSessionId, message: "only once, idle" });
  assert.ok(retry !== "closed" && retry.success, JSON.stringify(retry));
  const receipt = (retry as { data: { id: string; duplicate?: boolean } }).data;
  assert.equal(receipt.duplicate, true);
  await idleAfterRestart(target.activeSessionId);
  const got = landed(target.sessionFile).filter(m => m.message === "only once, idle");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, receipt.id);
  const fresh = await envelope(hostSocket(), "chat-a", "cmd-2", { type: "send_message", targetActiveSessionId: target.activeSessionId, message: "only once, idle" });
  assert.ok(fresh !== "closed" && fresh.success && !fresh.data.duplicate, "a new command id is a new message");
  await idleAfterRestart(target.activeSessionId);
  assert.equal(landed(target.sessionFile).filter(m => m.message === "only once, idle").length, 2);
  results.chat = { lost, retry: receipt, landed: landed(target.sessionFile) };
});

test("a plain pi session's send to a busy root is retried by pi-agent-bus across the host death and lands once", async () => {
  const target = await session("busy-target", 3000);
  process.env.PI_HOST_SOCKET = proxySocket;
  const sender = await openAgent(root, "cli-sender");
  opened.push(sender);
  killOn = "any send";
  const originalKills = killed;
  const restarted = (async () => {
    await until(() => killed > originalKills, 30_000, "the proxy killed the host");
    host = await startHost(root, "h");
  })();
  const receipt = (await kernelHandler(sender.id, "agent_message.send")!({ message: "only once, busy", receiver_role: "sibling", receiver_name: "busy-target" })) as { id: string; duplicate?: boolean; deliveryStatus: string };
  await restarted;
  assert.equal(receipt.duplicate, true, "the answer after the restart is the dedupe of the first, accepted send");
  await idleAfterRestart(target.activeSessionId);
  const got = landed(target.sessionFile).filter(m => m.message === "only once, busy");
  assert.equal(got.length, 1);
  assert.equal(got[0].id, receipt.id);
  assert.equal(got[0].header, "[agent-message from sibling:cli-sender]");
  results.cli = { receipt, landed: got };
  if (process.env.BUS_LOAD_OUT) writeFileSync(`${process.env.BUS_LOAD_OUT}-idempotency.json`, `${JSON.stringify(results, null, 2)}\n`);
});
