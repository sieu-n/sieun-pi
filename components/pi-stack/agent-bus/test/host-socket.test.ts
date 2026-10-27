import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { hostRoots, hostSend } from "../src/host-socket.ts";
import { sendFromClient } from "../src/route.ts";
import { landed, openAgent, until, type Opened } from "./rig.ts";

let root: string;
let server: Server;
let socketPath: string;
let target: Opened;
const lines: Record<string, unknown>[] = [];

/** A stand-in for pi-host's socket that speaks the same v7 lines and answers send_message with sendFromClient. */
before(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-bus-sock-"));
  target = await openAgent(root, "host-root");
  socketPath = join(root, "host.sock");
  server = createServer(conn => {
    conn.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } })}\n`);
    let buf = "";
    conn.on("data", async chunk => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const cmd = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        lines.push(cmd);
        const reply = (data: unknown, error?: string) =>
          conn.write(`${JSON.stringify(error ? { type: "response", id: cmd.id, command: cmd.type, success: false, error } : { type: "response", id: cmd.id, command: cmd.type, success: true, data })}\n`);
        if (cmd.type === "list") reply({ sessions: [{ sessionId: target.id, sessionName: "host-root", cwd: root, runtimeKind: "top-level", rosterStatus: "idle" }] });
        else if (cmd.type === "send_message") {
          try {
            reply(await sendFromClient({ target: cmd.targetActiveSessionId, message: cmd.message, mode: cmd.deliveryMode, from: { id: cmd.fromActiveSessionId, name: cmd.fromName } }));
          } catch (error) {
            reply(undefined, (error as Error).message);
          }
        } else reply(undefined, `pi-host does not serve ${cmd.type}`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
});

after(async () => {
  server.close();
  await target.runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

test("without PI_HOST_SOCKET the socket client fails with a message that says it needs pi-host", async () => {
  await assert.rejects(hostRoots(), /list needs pi-host/);
});

test("hostSend reaches a root over the socket and the receiver labels it as a sibling", async () => {
  process.env.PI_HOST_SOCKET = socketPath;
  try {
    const roots = await hostRoots();
    assert.deepEqual(roots.map(r => r.sessionName), ["host-root"]);
    const receipt = await hostSend({ target: target.id, message: "over the socket", mode: "auto", from: { id: "cli-root-1", name: "cli" } });
    assert.equal(receipt.deliveryStatus, "delivered");
    assert.equal(receipt.from.sessionName, "cli");
    await until(() => landed(target.file()).some(m => m.message === "over the socket" && m.header === "[agent-message from sibling:cli]"));
    const sent = lines.find(l => l.type === "send_message")!;
    assert.equal(sent.fromActiveSessionId, "cli-root-1");
    assert.equal(sent.deliveryMode, "auto");
    await assert.rejects(hostSend({ target: "nope", message: "x", mode: "auto", from: { id: "cli-root-1", name: "cli" } }), /needs pi-host|No|unknown/);
  } finally {
    delete process.env.PI_HOST_SOCKET;
  }
  await until(() => !target.runtime.session.isStreaming);
});
