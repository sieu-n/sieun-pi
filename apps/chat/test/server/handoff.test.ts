/**
 * A release reload hands the port to a successor without a moment when it refuses or resets a call (server/handoff.ts). A small Python
 * stand-in for systemd's socket unit binds the port, passes it as fd 3 with LISTEN_FDS and execs the fixture server, and the test sends
 * SIGHUP three times while a loop of fresh connections reads the server. Each call must answer 200 within 2 s, and a WebSocket on
 * /api/live opened after each hand-over must open.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/handoff.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import WebSocket from "ws";

const APP = join(import.meta.dirname, "../..");
const SOCKET_UNIT = `
import os, socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(512)
if s.fileno() != 3:
    os.dup2(s.fileno(), 3)
os.set_inheritable(3, True)
os.environ["LISTEN_FDS"] = "1"
os.environ["LISTEN_PID"] = str(os.getpid())
os.execv(sys.argv[2], sys.argv[2:])
`;

const freePort = () => new Promise<number>(resolve => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});

/** One GET on a connection of its own, so a closed or reset port shows as an error and not as a reused socket's retry. */
const get = (port: number, path: string) => new Promise<{ status: number; body: string; ms: number }>((resolve, reject) => {
  const started = performance.now();
  const req = request({ host: "127.0.0.1", port, path, agent: false, timeout: 10_000 }, res => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", chunk => (body += chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body, ms: performance.now() - started }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("no answer in 10 s")));
  req.on("error", reject);
  req.end();
});

const pidOf = async (port: number) => (JSON.parse((await get(port, "/api/ready")).body) as { pid: number }).pid;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("three reloads in a row hand the port over with no refused, reset or slow call", { timeout: 120_000 }, async t => {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), "apps-chat-handoff-"));
  const server = spawn("python3", ["-c", SOCKET_UNIT, String(port), process.execPath, "--import", "tsx", "server/main.ts", "--fixture", "--data-dir", data, "--port", String(port)],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTIFY_SOCKET: "" } });
  let out = "";
  server.stdout.on("data", chunk => (out += chunk));
  server.stderr.on("data", chunk => (out += chunk));
  let pid = server.pid!;
  try {
    for (let at = Date.now(); ; await sleep(100)) {
      try { if ((await get(port, "/api/ready")).status === 200) break; } catch { /* not up yet */ }
      assert.ok(Date.now() - at < 60_000, `the server did not answer in 60 s:\n${out}`);
    }
    const failures: string[] = [];
    const slow: number[] = [];
    let calls = 0;
    let longest = 0;
    let loading = true;
    const loop = (async () => {
      while (loading) {
        await Promise.all(["/api/ready", "/api/sidebar"].map(async path => {
          try {
            const answer = await get(port, path);
            calls += 1;
            if (answer.status !== 200) failures.push(`${path} ${answer.status}`);
            if (answer.ms > 2000) slow.push(Math.round(answer.ms));
            longest = Math.max(longest, answer.ms);
          } catch (error) {
            failures.push(`${path} ${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : String(error)}`);
          }
        }));
        await sleep(10);
      }
    })();
    for (let round = 0; round < 3; round++) {
      const before = pid;
      process.kill(before, "SIGHUP");
      for (let at = Date.now(); pid === before; await sleep(50)) {
        pid = await pidOf(port);
        assert.ok(Date.now() - at < 60_000, `hand-over ${round + 1} did not end in 60 s:\n${out}`);
      }
      for (let at = Date.now(); alive(before); await sleep(50)) assert.ok(Date.now() - at < 10_000, `the old server ${before} did not exit`);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
      await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
      socket.close();
    }
    loading = false;
    await loop;
    assert.ok(calls > 50, `the loop made ${calls} calls`);
    assert.deepEqual(failures, [], `${failures.length} of ${calls} calls failed:\n${out}`);
    assert.deepEqual(slow, [], `calls over 2 s:\n${out}`);
    assert.equal((out.match(/took the port/g) ?? []).length, 3, out);
    for (const line of out.split("\n").filter(each => each.includes("handoff:") || each.includes("apps/chat on"))) t.diagnostic(line);
    t.diagnostic(`${calls} calls, the slowest ${Math.round(longest)} ms`);
  } finally {
    for (const each of new Set([pid, server.pid!])) { try { process.kill(each, "SIGTERM"); } catch { /* gone */ } }
    for (let at = Date.now(); alive(pid) && Date.now() - at < 10_000; ) await sleep(50);
    rmSync(data, { recursive: true, force: true });
  }
});

test("a second server on the same data dir finds the lock held and exits", { timeout: 120_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), "apps-chat-lock-"));
  const [first, second] = [await freePort(), await freePort()];
  const start = (port: number) => spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--fixture", "--data-dir", data, "--port", String(port)],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTIFY_SOCKET: "" } });
  const one = start(first);
  try {
    for (let at = Date.now(); ; await sleep(100)) {
      try { if ((await get(first, "/api/ready")).status === 200) break; } catch { /* not up yet */ }
      assert.ok(Date.now() - at < 60_000, "the first server did not answer in 60 s");
    }
    const two = start(second);
    let out = "";
    two.stdout.on("data", chunk => (out += chunk));
    const code = await new Promise<number | null>(resolve => two.once("exit", resolve));
    assert.equal(code, 1, out);
    assert.match(out, /does not serve it and exits/);
    assert.equal((await get(first, "/api/ready")).status, 200, "the first server still serves");
  } finally {
    one.kill("SIGTERM");
    await new Promise(resolve => one.once("exit", resolve));
    rmSync(data, { recursive: true, force: true });
  }
});
