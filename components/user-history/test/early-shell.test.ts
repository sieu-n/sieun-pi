// Guards the 10-18 12:42Z restart: a page shell sent during a chat service restart waited 12.1 s for the new process's catalog and bundle.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asset, bundleCacheDir, clientSourceHash, packedBundle, readBuiltBundle, writePacked } from "../src/client-bundle.ts";
import { startEarlyShell } from "../src/early-shell.ts";
import { FirstPages } from "../src/first-page.ts";
import type { ThreadEvent } from "../src/shared/types.ts";

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body })); });
    req.on("error", reject); req.end();
  });
}

test("a starting service answers the page shell from disk at once, holds other requests, and hands them to the real server", async t => {
  const dir = await mkdtemp(join(tmpdir(), "early-shell-"));
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["t1"] }));
  const session = join(dir, "t1.jsonl");
  await writeFile(session, "{}\n");
  const pages = new FirstPages(join(dir, "first-pages"));
  pages.put("t1", [{ type: "snapshot", snapshot: { messages: [{ role: "user", content: "hi", timestamp: 1 }] } }] as unknown as ThreadEvent[], session);
  await pages.flush();
  const bundle = packedBundle(asset(Buffer.from("js"), "text/javascript"), asset(Buffer.from("css"), "text/css"));
  const early = await startEarlyShell({ listenFd: null, port: 0, capability: "cap", csrfToken: "tok", dataDir: dir, bundle: async () => bundle });
  t.after(() => early.server.close());
  const address = early.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/cap/`;
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const shell = await get(base + "?t=t1", nav);
  assert.equal(shell.status, 200);
  assert.match(shell.body, /data-chat-token="tok"/);
  assert.match(shell.body, /data-chats="t1"/);
  assert.match(shell.body, /<script type="application\/json" id="boot-thread" data-id="t1">\[\{"type":"snapshot"/);
  let answered = false;
  const held = get(base + "api/identity").then(result => { answered = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(answered, false, "an API request waits for the real server");
  early.take((_req, res) => { res.writeHead(200); res.end("real"); }, socket => { socket.destroy(); });
  assert.deepEqual(await held, { status: 200, body: "real" });
  assert.equal((await get(base + "?t=t1", nav)).body, "real", "after the hand-over the real server answers shells too");
});

test("a restart with no prebuilt bundle reads the one a former start cached for the same client sources, and a changed client file misses it", async () => {
  const app = await mkdtemp(join(tmpdir(), "bundle-cache-"));
  const home = await mkdtemp(join(tmpdir(), "bundle-home-"));
  await mkdir(join(app, "src/client"), { recursive: true });
  await mkdir(join(app, "src/shared"), { recursive: true });
  await writeFile(join(app, "src/client/main.ts"), "one");
  await writeFile(join(app, "package-lock.json"), "{}");
  const hash = await clientSourceHash(app);
  const js = { ...asset(Buffer.from("js"), "text/javascript; charset=utf-8"), br: Buffer.from("b"), gzip: Buffer.from("g") };
  const css = { ...asset(Buffer.from("css"), "text/css; charset=utf-8"), br: Buffer.from("b"), gzip: Buffer.from("g") };
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await writePacked(bundleCacheDir(hash), js, css);
    const found = await readBuiltBundle(join(app, "no-prebuilt"), app);
    assert.equal(found.bundle?.js.body.toString(), "js");
    await writeFile(join(app, "src/client/main.ts"), "two");
    assert.notEqual(await clientSourceHash(app), hash);
    assert.equal((await readBuiltBundle(join(app, "no-prebuilt"), app)).bundle, null);
  } finally { process.env.HOME = previousHome; }
});
