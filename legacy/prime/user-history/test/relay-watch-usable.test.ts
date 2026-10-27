// Guards 10-18 10:45Z on: at load 440 on the Mac the relay's footprint helper passed its 30 s kill in every read, the relay answered 500 or the
// watch's 35 s abort fired first, and each such minute lost the Mac's reading, so d7 read the Mac unknown in 15 to 19 of 30 minutes. The reading
// now comes from its own read (GET /v1/usable) and the watch answer keeps it when the helper fails, so only the worker numbers go unknown.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Host, relayWatch } from "../src/hosts.ts";
import { type Footprints, hostWatchLine } from "../src/mac-usable-watch.ts";

const NOW = Date.parse("2026-10-18T11:08:30.000Z");
const feed = { v: 1, ts: new Date(NOW - 5_000).toISOString(), pressure_level: 1, swapouts_per_s: 0, kernel_task_cpu_pct: 20 };
const footprints: Footprints = { workers: { 31: { pids: 2, bytes: 1024 ** 3 } }, kernels: [], swap_used_bytes: 0, pressure_level: 1, cpu_s: 0 };
const rows = [{ sessionId: "s", activeSessionId: "s", lifecycle: "live", activity: "idle", workerPid: 31, sessionName: "s", lastActivityAt: new Date(NOW).toISOString() }];
const TOKEN = "t".repeat(40);

async function fakeRelay(handle: (path: string, response: ServerResponse, request: IncomingMessage) => void): Promise<{ host: Host; close: () => void }> {
  const server = createServer((request, response) => handle(new URL(request.url!, "http://relay").pathname, response, request));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const dir = await mkdtemp(join(tmpdir(), "relay-watch-"));
  await writeFile(join(dir, "token"), TOKEN + "\n");
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (server.address() as { port: number }).port, token: `file:${join(dir, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };
  return { host, close: () => { server.closeAllConnections(); server.close(); } };
}
const json = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
const line = (host: Host) => hostWatchLine({ name: "mac", rows, read: pids => relayWatch(host, pids) }, { now: NOW, chats: new Set(), title: () => null });

test("a footprint helper that fails on the Mac leaves the Mac's reading in its watch line", async () => {
  const relay = await fakeRelay((path, response) => path === "/v1/usable" ? json(response, 200, { platform: "darwin", feed })
    : json(response, 500, { error: "footprint helper exited 129" }));
  try {
    const read = await line(relay.host);
    assert.deepEqual(read.usable, { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 });
    assert.match(read.error ?? "", /500 to \/v1\/watch/);
    assert.equal(read.swapGb, null);
  } finally { relay.close(); }
});

test("a watch answer without footprints keeps its reading, and a relay from before /v1/usable still reads", async () => {
  const relay = await fakeRelay((path, response) => path === "/v1/usable" ? json(response, 404, { error: "unknown route" })
    : json(response, 200, { usable: { platform: "darwin", feed }, footprints: null, footprintsError: "footprint helper was killed by SIGKILL" }));
  try {
    const read = await line(relay.host);
    assert.deepEqual(read.usable, { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 });
    assert.match(read.error ?? "", /footprints: footprint helper was killed by SIGKILL/);
  } finally { relay.close(); }
  const old = await fakeRelay((path, response) => path === "/v1/usable" ? json(response, 404, { error: "unknown route" })
    : json(response, 200, { usable: { platform: "darwin", feed }, footprints }));
  try {
    const read = await line(old.host);
    assert.equal(read.error, undefined);
    assert.equal(read.workers, 1);
    assert.deepEqual(read.usable, { pressureLevel: 1, swapoutsPerS: 0, kernelTaskPct: 20 });
  } finally { old.close(); }
  const down = await fakeRelay((_, response) => json(response, 503, { error: "busy" }));
  try {
    const read = await line(down.host);
    assert.equal(read.usable, null);
    assert.match(read.error ?? "", /503 to \/v1\/watch/);
  } finally { down.close(); }
});

test("the relay answers its reading on /v1/usable and keeps it on /v1/watch when the helper fails", async () => {
  // In the repo the helper is not installed beside relay.mjs, so python exits 2 on the missing file, as a failed helper does on a box.
  const dir = await mkdtemp(join(tmpdir(), "relay-watch-"));
  await writeFile(join(dir, "token"), TOKEN);
  const relayModule = "../../../../components/prime-relay/relay.mjs";
  const { createRelay } = await import(relayModule) as { createRelay: (config: object) => Server };
  const server = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(dir, "none.sock"), roots: [], token: TOKEN });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${TOKEN}` };
  try {
    const usable = await fetch(`${base}/v1/usable`, { headers });
    assert.equal(usable.status, 200);
    assert.equal((await usable.json() as { platform: string }).platform, process.platform);
    const watch = await fetch(`${base}/v1/watch`, { method: "POST", body: "31\n", headers });
    assert.equal(watch.status, 200);
    const body = await watch.json() as { usable: { platform: string }; footprints: unknown; footprintsError: string };
    assert.equal(body.usable.platform, process.platform);
    assert.equal(body.footprints, null);
    assert.match(body.footprintsError, /footprint helper exited \d+/);
  } finally { server.closeAllConnections(); server.close(); }
});
