// Guards the 10-18 12:42Z restart: a page shell sent during a chat service restart waited 12.1 s for the new process's catalog and bundle.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asset, bundleCacheDir, clientSourceHash, packedBundle, readBuiltBundle, writePacked } from "../src/client-bundle.ts";
import { startEarlyShell } from "../src/early-shell.ts";
import { FirstPages } from "../src/first-page.ts";
import type { ThreadEvent } from "../src/shared/types.ts";

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, agent: false }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body })); });
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

// The socket systemd holds, made the way systemd-socket-activate does: a process binds and listens, then execs the service with it at fd 3.
const holder = `import os, socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(128)
print(s.getsockname()[1], flush=True)
os.dup2(s.fileno(), 3); os.set_inheritable(3, True)
os.environ["LISTEN_FDS"] = "1"; os.environ["LISTEN_PID"] = str(os.getpid())
os.execv(sys.argv[1], sys.argv[1:])`;

test("on systemd's socket the early shell's own process answers shells while the service thread imports, and hands held requests and upgrades to the real server", { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "early-child-"));
  const home = await mkdtemp(join(tmpdir(), "early-home-"));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ capability: "cap", csrfToken: "tok" }));
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: ["t1"] }));
  const js = { ...asset(Buffer.from("js"), "text/javascript; charset=utf-8"), br: Buffer.from("b"), gzip: Buffer.from("g") };
  const css = { ...asset(Buffer.from("css"), "text/css; charset=utf-8"), br: Buffer.from("b"), gzip: Buffer.from("g") };
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try { await writePacked(bundleCacheDir(await clientSourceHash()), js, css); } finally { process.env.HOME = previousHome; }
  const fixture = new URL("./fixtures/early-start.mjs", import.meta.url).pathname;
  const main = spawn("python3", ["-c", holder, process.execPath, fixture, dir, "1500"], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"], detached: true, timeout: 30_000, killSignal: "SIGKILL" });
  t.after(() => { try { process.kill(-main.pid!, "SIGKILL"); } catch { /* gone */ } });
  const lines = createInterface({ input: main.stdout! });
  const seen: string[] = [];
  const waiters: [string, () => void][] = [];
  lines.on("line", line => { seen.push(line); for (const [want, done] of waiters) if (line === want) done(); });
  const saw = (want: string) => seen.includes(want) ? Promise.resolve() : new Promise<void>(resolve => waiters.push([want, resolve]));
  const port = Number(await new Promise<string>(resolve => lines.once("line", resolve)));
  const base = `http://127.0.0.1:${port}/cap/`;
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  // The service thread stands still for 1.5 s; the shell comes from the other process meanwhile.
  const shell = await get(base + "?t=t1", nav);
  assert.match(shell.body, /data-chat-token="tok"/);
  assert.equal(seen.includes("imported"), false, "the shell came while the service thread was still importing");
  let answered = false;
  const held = get(base + "api/identity").then(result => { answered = true; return result; });
  const upgraded = new Promise<string>((resolve, reject) => {
    const raw = connect(port, "127.0.0.1", () => raw.write("GET /cap/api/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello"));
    let text = ""; raw.on("data", chunk => { text += chunk; if (text.includes("echo:hello")) { raw.destroy(); resolve(text); } }); raw.on("error", reject);
  });
  await saw("imported");
  assert.equal(answered, false, "an API request waits for the real server");
  main.stdin!.write("take\n");
  await saw("taken");
  assert.deepEqual(await held, { status: 200, body: "real /cap/api/identity" });
  assert.match(await upgraded, /101 Switching Protocols[\s\S]*echo:hello/);
  assert.equal((await get(base + "?t=t1", nav)).body, "real /cap/?t=t1", "after the hand-over the real server answers shells too");
  main.stdin!.end();
});

test("the early shell's process keeps answering shells until the service thread is free after it is ready", { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "early-busy-"));
  const home = await mkdtemp(join(tmpdir(), "early-home-"));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ capability: "cap", csrfToken: "tok" }));
  const js = { ...asset(Buffer.from("js"), "text/javascript; charset=utf-8"), br: Buffer.from("b"), gzip: Buffer.from("g") };
  const css = { ...asset(Buffer.from("css"), "text/css; charset=utf-8"), br: Buffer.from("b"), gzip: Buffer.from("g") };
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try { await writePacked(bundleCacheDir(await clientSourceHash()), js, css); } finally { process.env.HOME = previousHome; }
  const fixture = new URL("./fixtures/early-start.mjs", import.meta.url).pathname;
  const main = spawn("python3", ["-c", holder, process.execPath, fixture, dir, "0"], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"], detached: true, timeout: 30_000, killSignal: "SIGKILL" });
  t.after(() => { try { process.kill(-main.pid!, "SIGKILL"); } catch { /* gone */ } });
  const lines = createInterface({ input: main.stdout! });
  const seen: string[] = [];
  const waiters: [string, () => void][] = [];
  lines.on("line", line => { seen.push(line); for (const [want, done] of waiters) if (line === want) done(); });
  const saw = (want: string) => seen.includes(want) ? Promise.resolve() : new Promise<void>(resolve => waiters.push([want, resolve]));
  const port = Number(await new Promise<string>(resolve => lines.once("line", resolve)));
  const base = `http://127.0.0.1:${port}/cap/`;
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  await saw("imported");
  assert.match((await get(base, nav)).body, /data-chat-token="tok"/, "the child is up");
  main.stdin!.write("take-busy\n");
  await saw("busy");
  const at = Date.now();
  const shell = await get(base, nav);
  assert.match(shell.body, /data-chat-token="tok"/, "the early shell answered, not the real server");
  assert.ok(Date.now() - at < 1000, `the shell waited ${Date.now() - at} ms on the busy thread`);
  await saw("taken");
  assert.equal((await get(base, nav)).body, "real /cap/", "once the thread is free the real server answers");
  main.stdin!.end();
});
