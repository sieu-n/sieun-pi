/**
 * A release reload hands the port to a successor without a moment when it refuses or resets a call (server/handoff.ts). A small Python
 * stand-in for systemd's socket unit binds the port, passes it as fd 3 with LISTEN_FDS and execs the fixture server, and the test sends
 * SIGHUP three times while a loop of fresh connections reads the server. Each call must answer 200 within 2 s beside the time this test and
 * the server that held the call waited for a CPU, each running server must answer calls after it started its successor, and a WebSocket
 * on /api/live opened after each hand-over must open.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/handoff.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { Predecessor } from "../../server/handoff.ts";

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

/** How long a process's main thread waited for a CPU so far, in ms: the second field of /proc/<pid>/schedstat (ns). null once it ended. */
const runQueueMs = (pid: number): number | null => {
  try { return Number(readFileSync(`/proc/${pid}/schedstat`, "utf8").split(" ")[1]) / 1e6; } catch { return null; }
};

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
    const answered: { path: string; at: number; end: number; ms: number; pid?: number }[] = [];
    let loading = true;
    // A call waits on this test's main thread and on the server that holds it: the running one until the stop it logs, then its successor.
    // On a busy box both also wait for a CPU, which is the box's time and not the hand-over's: in the full parallel suite at load 400 on
    // 11-23, a call took 2577 ms while this test's main thread waited 2553 ms of them for a CPU and the server 1611 ms. Each call's time
    // leaves out the wait of this test and of the server that held the call.
    const successors = () => [...out.matchAll(/started the successor (\d+)/g)].map(match => Number(match[1]));
    const waits = new Map<number, [number, number][]>();
    const sample = () => {
      const now = Date.now();
      for (const each of [process.pid, server.pid!, ...successors()]) {
        const ms = runQueueMs(each);
        if (ms === null) continue;
        if (!waits.has(each)) waits.set(each, []);
        waits.get(each)!.push([now, ms]);
      }
    };
    const sampler = setInterval(sample, 50);
    const loop = (async () => {
      while (loading) {
        await Promise.all(["/api/ready", "/api/sidebar"].map(async path => {
          sample();
          const at = Date.now();
          try {
            const answer = await get(port, path);
            sample();
            answered.push({ path, at, end: Date.now(), ms: answer.ms, ...(path === "/api/ready" && answer.status === 200 ? { pid: (JSON.parse(answer.body) as { pid: number }).pid } : {}) });
            if (answer.status !== 200) failures.push(`${path} ${answer.status}`);
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
    clearInterval(sampler);
    assert.deepEqual(failures, [], `${failures.length} of ${answered.length} calls failed:\n${out}`);
    // The running server serves while its successor loads its modules, so a hand-over's calls wait in the socket's queue only for the stop
    // and the successor's start. This holds at any load, where the 2 s bound below cannot tell a slow module load from a busy box.
    const started = [...out.matchAll(/(\S+Z) handoff: started the successor (\d+)/g)].map(match => ({ at: Date.parse(match[1]!), successor: Number(match[2]) }));
    for (const [i, { at, successor }] of started.entries()) {
      const running = i === 0 ? server.pid! : started[i - 1]!.successor;
      assert.ok(answered.some(call => call.pid === running && call.at > at), `${running} answered no call that came after it started ${successor}:\n${out}`);
    }
    const waitAt = (pid: number, at: number) => {
      const seen = waits.get(pid) ?? [];
      return seen.findLast(([when]) => when <= at)?.[1] ?? seen[0]?.[1] ?? 0;
    };
    const stops = [...out.matchAll(/(\S+Z) handoff: (\d+) loaded in/g)].map(match => ({ at: Date.parse(match[1]!), successor: Number(match[2]) }));
    const cpuWait = ({ at, end }: { at: number; end: number }) => {
      const cuts = [at, ...stops.map(stop => stop.at).filter(when => when > at && when < end), end];
      let ms = waitAt(process.pid, end) - waitAt(process.pid, at);
      for (let i = 1; i < cuts.length; i++) {
        const holder = stops.findLast(stop => stop.at <= cuts[i - 1]!)?.successor ?? server.pid!;
        ms += waitAt(holder, cuts[i]!) - waitAt(holder, cuts[i - 1]!);
      }
      return ms;
    };
    const timed = answered.map(call => ({ ...call, cpu: cpuWait(call) })).sort((a, b) => b.ms - b.cpu - (a.ms - a.cpu));
    const show = (call: (typeof timed)[number]) => `${call.path} at ${new Date(call.at).toISOString()} took ${Math.round(call.ms)} ms, ${Math.round(call.cpu)} ms of it waiting for a CPU`;
    assert.deepEqual(timed.filter(call => call.ms - call.cpu > 2000).map(show), [], `calls over 2 s beside their wait for a CPU:\n${out}`);
    assert.ok(answered.length > 50, `the loop made ${answered.length} calls`);
    assert.equal((out.match(/took the port/g) ?? []).length, 3, out);
    for (const line of out.split("\n").filter(each => each.includes("handoff:") || each.includes("apps/chat on"))) t.diagnostic(line);
    const slowest = timed.reduce((a, b) => (b.ms > a.ms ? b : a));
    t.diagnostic(`${answered.length} calls; the slowest ${show(slowest)}; the most beside the CPU wait ${show(timed[0]!)}`);
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

test("a successor's wait for the stop ends when the running server's channel closes first", async () => {
  const channel = (connected: boolean) => Object.assign(new EventEmitter(), { connected, send: () => true }) as unknown as ConstructorParameters<typeof Predecessor>[0] & EventEmitter;
  assert.equal(await new Predecessor(channel(false)).stopped(), "gone");
  const closing = channel(true);
  const waiting = new Predecessor(closing).stopped();
  closing.emit("disconnect");
  assert.equal(await waiting, "gone");
  const stopping = channel(true);
  const stopped = new Predecessor(stopping).stopped();
  stopping.emit("message", { kind: "stopped" });
  assert.equal(await stopped, "stopped");
});
