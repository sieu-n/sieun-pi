// us-metal02 to the Mac, 07:52 to 07:57Z on 10-18: agents' `hosts transcript mac` and `hosts read --from 0` read frontend bro's 130 MB file whole
// through the relay three times (299 MB), while the chat service already held a byte-range copy and the chat's 10 MB attach snapshot timed out.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { mirrorFile, pruneMirror } from "../src/host-mirror.ts";
import type { Host } from "../src/hosts.ts";

test("the service and a CLI read share one copy of a Mac file and fetch only the bytes it grew by", async t => {
  const dir = await mkdtemp(join(tmpdir(), "host-mirror-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "t".repeat(40);
  await writeFile(join(dir, "token"), token);
  const remote = join(dir, "sessions", "01a11ba8.jsonl");
  await mkdir(join(dir, "sessions"));
  await writeFile(remote, "a".repeat(5000) + "\n");
  const ranges: (string | undefined)[] = [];
  // GET /v1/file as components/prime-relay/relay.mjs serves it: a Range from an offset, 416 past the end, X-File-Size on each answer.
  const server = createServer(async (request, response) => {
    ranges.push(request.headers.range);
    const body = await readFile(new URL(request.url ?? "/", "http://relay").searchParams.get("path")!);
    const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
    if (start > body.length) { response.writeHead(416, { "X-File-Size": String(body.length), "Content-Range": `bytes */${body.length}` }); response.end(); return; }
    response.writeHead(request.headers.range ? 206 : 200, { "X-File-Size": String(body.length) });
    response.end(body.subarray(start));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (server.address() as AddressInfo).port, token: `file:${join(dir, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };
  const local = join(dir, "copy", "01a11ba8.jsonl");

  await Promise.all([mirrorFile(host, remote, local), mirrorFile(host, remote, local)]);
  assert.equal(await readFile(local, "utf8"), await readFile(remote, "utf8"));
  await appendFile(remote, "b".repeat(300) + "\n");
  ranges.length = 0;
  await Promise.all([mirrorFile(host, remote, local), mirrorFile(host, remote, local)]);
  assert.deepEqual(ranges, ["bytes=5001-", "bytes=5001-"]);
  assert.equal(await readFile(local, "utf8"), await readFile(remote, "utf8"));
  await writeFile(remote, "rewritten\n");
  await mirrorFile(host, remote, local);
  assert.equal(await readFile(local, "utf8"), "rewritten\n");
});

// us-metal02, 10-18: the Mac's copy folder kept 92 copies (0.81 GB) of chats that had moved from the Mac to the box, which no row named.
test("a prune deletes the copies no row names and keeps a whole copy being written", async t => {
  const root = await mkdtemp(join(tmpdir(), "host-mirror-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kept = join(root, "Users/x/.prime/agent/sessions/01a1-live.jsonl");
  const moved = join(root, "Users/x/.prime/agent/sessions/01a1-moved.jsonl");
  const writing = join(root, "Users/x/.prime/agent/sessions/01a1-new.jsonl.0f.tmp");
  await mkdir(join(root, "Users/x/.prime/agent/sessions"), { recursive: true });
  for (const file of [kept, moved, writing]) await writeFile(file, "{}\n");
  assert.deepEqual(await pruneMirror(root, new Set([kept])), [moved]);
  assert.deepEqual((await readdir(join(root, "Users/x/.prime/agent/sessions"))).sort(), ["01a1-live.jsonl", "01a1-new.jsonl.0f.tmp"]);
  assert.deepEqual(await pruneMirror(join(root, "missing"), new Set()), []);
});
