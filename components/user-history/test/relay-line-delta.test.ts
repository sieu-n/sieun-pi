// Guards the 10-18 incident where a Mac chat's reply crawled to the box: the Mac daemon sends one message_update per token with the whole partial message, so a 6 KB reply was 448 updates and 1.73 MB over the relay, and a 20 KB file write 1,970 updates and 25.8 MB.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { decodeLineDeltas, encodeLineDeltas } from "../../prime-relay/line-delta.ts";
import { HostBridge, type Host, openDaemonTunnel } from "../src/hosts.ts";

const RELAY = "../../prime-relay/relay.mjs";
const { createRelay } = await import(RELAY) as { createRelay: (config: { listen: string; port: number; daemonSocket: string; roots: string[]; token: string }) => Server };
/** The assistant message_start, message_update and message_end lines of a 5,960-character reply on a box thread, recorded at the daemon socket on 10-18. */
const recorded = gunzipSync(readFileSync(new URL("./fixtures/message-updates-1018-1050.jsonl.gz", import.meta.url)));
const other = '{"type":"session_event","activeSessionId":"0123456789ab","event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"é"}]}}}\n';
const sent = Buffer.concat([Buffer.from('{"type":"daemon_hello"}\n'), Buffer.from(other), recorded, Buffer.from(other.replace("é", "é and more")), Buffer.from('{"type":"session_status"}\n')]);

async function read(socket: Socket): Promise<Buffer> {
  const parts: Buffer[] = [];
  socket.on("data", (part: Buffer) => parts.push(part));
  await once(socket, "end");
  return Buffer.concat(parts);
}

test("the relay sends each message update as a delta when the box asks, the bridge rebuilds the same bytes, and without the header every byte passes unchanged", async t => {
  const dir = await mkdtemp(join(tmpdir(), "line-delta-"));
  const daemonSocket = join(dir, "daemon.sock");
  const daemon = createServer(client => { for (let at = 0; at < sent.length; at += 65_536) client.write(sent.subarray(at, at + 65_536)); client.end(); });
  daemon.listen(daemonSocket);
  await once(daemon, "listening");
  const token = "t".repeat(40);
  await writeFile(join(dir, "token"), token + "\n");
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket, roots: [], token });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const port = (relay.address() as { port: number }).port;
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: port, token: `file:${join(dir, "token")}`, daemonSocket, ssh: null, roles: {} };
  const bridge = new HostBridge({ version: 1, hosts: [host] }, { dir: join(dir, "bridge"), self: null });
  await bridge.start();
  t.after(async () => { await bridge.close(); relay.close(); daemon.close(); });

  const wire = await read(await openDaemonTunnel(host));
  const rebuilt = await read(createConnection(bridge.socketPath("mac")));
  const plain = await read(await new Promise<Socket>((resolve, reject) => {
    const asked = request({ host: "127.0.0.1", port, path: "/v1/daemon", headers: { connection: "Upgrade", upgrade: "prime-daemon", authorization: `Bearer ${token}` } });
    asked.on("upgrade", (_response, socket, head) => { if (head.length) socket.unshift(head); resolve(socket); });
    asked.on("error", reject);
    asked.end();
  }));

  assert.ok(plain.equals(sent), "without the header every byte passes unchanged");
  assert.ok(rebuilt.equals(sent), "the bridge hands the daemon client the exact bytes the daemon sent");
  const lines = wire.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, sent.toString("utf8").trimEnd().split("\n").length);
  assert.equal(lines[1], other.trimEnd(), "a session's first update goes whole");
  assert.ok(lines.filter(line => line.startsWith('{"type":"prime_relay_line_delta"')).length >= 440, "the recorded updates after the first go as deltas");
  assert.ok(wire.length * 10 < sent.length, `the wire carries ${wire.length} bytes for ${sent.length}`);
});

test("a delta whose session has no earlier update stops the stream, and an update after message_end goes whole", async () => {
  const encoder = encodeLineDeltas();
  const out: Buffer[] = [];
  encoder.on("data", (part: Buffer) => out.push(part));
  const update = (text: string) => `{"type":"session_event","activeSessionId":"0123456789ab","event":{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"usage":{"input":1,"output":2}},"assistantMessageEvent":{"type":"text_delta","delta":"x"}}}\n`;
  const end = '{"type":"session_event","activeSessionId":"0123456789ab","event":{"type":"message_end","message":{"role":"assistant"}}}\n';
  const long = "word ".repeat(200);
  encoder.end([update(long), update(long + "next"), end, update(long + "next two")].join(""));
  await once(encoder, "end");
  const lines = Buffer.concat(out).toString("utf8").trimEnd().split("\n");
  assert.deepEqual(lines.map(line => (JSON.parse(line) as { type: string }).type), ["session_event", "prime_relay_line_delta", "session_event", "session_event"]);

  const decoder = decodeLineDeltas();
  const failed = once(decoder, "error");
  const input = new PassThrough();
  input.pipe(decoder);
  decoder.resume();
  input.end(lines[1] + "\n");
  const [error] = await failed as [Error];
  assert.match(error.message, /no earlier update/);
});
