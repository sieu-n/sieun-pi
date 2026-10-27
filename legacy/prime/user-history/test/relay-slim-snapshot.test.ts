// Guards the 10-18 07:38Z to 08:01Z incident: frontend bro's attach snapshot from the Mac was 8.7 MB, 7.75 MB of it base64 screenshots the box already had in its copy of the file, over a link that gave 0.26 to 1.4 MB/s, and 17 attaches timed out.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSnapshotTranscriptChunks } from "../node_modules/prime-agent/dist/modes/daemon/snapshot-transcript-cache.js";
import type { Server } from "node:http";
import { type Host, openDaemonTunnel } from "../src/hosts.ts";

const RELAY = "../../../../components/prime-relay/relay.mjs";
const { createRelay } = await import(RELAY) as { createRelay: (config: { listen: string; port: number; daemonSocket: string; roots: string[]; token: string }) => Server };
const IMAGE = "iVBORw0KGgo".repeat(40_000);
const messages = Array.from({ length: 6 }, (_, index) => ({ role: "user", timestamp: index, content: [{ type: "text", text: `screenshot ${index}` }, { type: "image", mimeType: "image/png", data: IMAGE }] }));
const chunks = [...createSnapshotTranscriptChunks({ activeSessionId: "5f62f184170b", snapshotId: "snap-1", messages: messages as never[], targetChunkBytes: 512 * 1024 })];
const lines = [Buffer.from('{"type":"daemon_hello"}\n'), ...chunks, Buffer.from('{"type":"session_snapshot_end","activeSessionId":"5f62f184170b","snapshotId":"snap-1","chunkCount":' + chunks.length + "}\n"), Buffer.from('{"type":"session_event","event":{"type":"agent_start"}}\n')];
const sent = Buffer.concat(lines);

async function read(socket: Socket): Promise<Buffer> {
  const parts: Buffer[] = [];
  socket.on("data", (part: Buffer) => parts.push(part));
  await once(socket, "end");
  return Buffer.concat(parts);
}

test("the relay sends attach snapshots without the image data of all chunks but the last when the box asks, and every byte as it came when it does not", async t => {
  const dir = await mkdtemp(join(tmpdir(), "slim-snapshot-"));
  const daemonSocket = join(dir, "daemon.sock");
  const daemon = createServer(client => { for (let at = 0; at < sent.length; at += 65_536) client.write(sent.subarray(at, at + 65_536)); client.end(); });
  daemon.listen(daemonSocket);
  await once(daemon, "listening");
  const token = "t".repeat(40);
  await writeFile(join(dir, "token"), token + "\n");
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket, roots: [], token });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => { relay.close(); daemon.close(); });
  const port = (relay.address() as { port: number }).port;
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: port, token: `file:${join(dir, "token")}`, daemonSocket, ssh: null, roles: {} };

  const slim = await read(await openDaemonTunnel(host));
  const plain = await read(await new Promise<Socket>((resolve, reject) => {
    const asked = request({ host: "127.0.0.1", port, path: "/v1/daemon", headers: { connection: "Upgrade", upgrade: "prime-daemon", authorization: `Bearer ${token}` } });
    asked.on("upgrade", (_response, socket, head) => { if (head.length) socket.unshift(head); resolve(socket); });
    asked.on("error", reject);
    asked.end();
  }));

  assert.ok(chunks.length >= 3, `the snapshot is ${chunks.length} chunks`);
  assert.ok(plain.equals(sent), "without the header every byte passes unchanged");
  type Line = { type: string; messages?: { content: { data?: string }[] }[] };
  const out = slim.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Line);
  assert.deepEqual(out.map(line => line.type), ["daemon_hello", ...chunks.map(() => "session_snapshot_chunk"), "session_snapshot_end", "session_event"]);
  const images = out.filter(line => line.type === "session_snapshot_chunk").map(line => (line.messages ?? []).map(message => message.content[1]?.data?.length ?? -1));
  assert.ok(images.slice(0, -1).flat().every(length => length === 0), "older chunks carry no image data");
  assert.ok(images.at(-1)!.every(length => length === IMAGE.length), "the last chunk keeps its images whole");
  assert.equal(out.filter(line => line.type === "session_snapshot_chunk").flatMap(line => line.messages ?? []).length, messages.length);
  assert.ok(slim.length < sent.length / 2, `slim ${slim.length} bytes against ${sent.length}`);
});
