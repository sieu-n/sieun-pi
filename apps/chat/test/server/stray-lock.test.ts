/**
 * A start of the unit that finds the data dir's lock held by a server systemd lost track of ends that server and serves (server/handoff.ts
 * takeFromStray). The first fixture server runs as a hand run and holds the lock. The second starts the way systemd starts the unit: a
 * Python stand-in for the socket unit passes the port as fd 3 with LISTEN_FDS, and NOTIFY_SOCKET names a datagram socket this test reads.
 * Before the change the second exited on "holds server.lock" on each start, as the unit's 27 restarts did at 21:24Z on 11-23.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/stray-lock.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { keepUnitEnv, systemdEnv } from "../../server/handoff.ts";

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
/** A stand-in for systemd's notify socket: prints each datagram it gets on a line of its own. */
const NOTIFY_SINK = `
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.bind(sys.argv[1])
print("bound", flush=True)
while True:
    print(s.recv(4096).decode().replace("\\n", " "), flush=True)
`;

const freePort = () => new Promise<number>(resolve => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => resolve(port));
  });
});

const get = (port: number, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, agent: false, timeout: 10_000 }, res => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", chunk => (body += chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("no answer in 10 s")));
  req.on("error", reject);
  req.end();
});

const ready = async (port: number, out: () => string) => {
  for (let at = Date.now(); ; await sleep(100)) {
    try { if ((await get(port, "/api/ready")).status === 200) return; } catch { /* not up yet */ }
    assert.ok(Date.now() - at < 60_000, `the server on ${port} did not answer in 60 s:\n${out()}`);
  }
};

const collect = (child: ChildProcess) => {
  let out = "";
  child.stdout?.on("data", chunk => (out += chunk));
  child.stderr?.on("data", chunk => (out += chunk));
  return () => out;
};

const ended = (child: ChildProcess) => new Promise<number | null>(resolve => child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve));

test("a start of the unit ends a server that holds the data dir's lock outside it, takes the lock and serves", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "apps-chat-stray-"));
  const data = join(root, "data");
  const notifyPath = join(root, "notify.sock");
  const [first, second] = [await freePort(), await freePort()];
  const sink = spawn("python3", ["-u", "-c", NOTIFY_SINK, notifyPath], { stdio: ["ignore", "pipe", "pipe"] });
  const notes = collect(sink);
  const children: ChildProcess[] = [sink];
  try {
    for (let at = Date.now(); !notes().includes("bound"); await sleep(50)) assert.ok(Date.now() - at < 10_000, "the notify stand-in did not bind");
    const stray = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--fixture", "--data-dir", data, "--port", String(first)],
      { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTIFY_SOCKET: "" } });
    children.push(stray);
    const strayOut = collect(stray);
    await ready(first, strayOut);
    assert.equal(Number(readFileSync(join(data, "server.lock.pid"), "utf8")), stray.pid);

    const unit = spawn("python3", ["-c", SOCKET_UNIT, String(second), process.execPath, "--import", "tsx", "server/main.ts", "--fixture", "--data-dir", data, "--port", String(second)],
      { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTIFY_SOCKET: notifyPath, APPS_CHAT_UNIT: "apps-chat-stray-test.service" } });
    children.push(unit);
    const unitOut = collect(unit);
    await ready(second, unitOut);

    assert.equal(await ended(stray), 0, `the stray server did not end on SIGTERM:\n${strayOut()}`);
    assert.match(unitOut(), new RegExp(`data dir: pid ${stray.pid} held .* this start ended it with SIGTERM in \\d+ ms and serves the data dir`), unitOut());
    assert.equal(Number(readFileSync(join(data, "server.lock.pid"), "utf8")), unit.pid);
    assert.equal((JSON.parse((await get(second, "/api/ready")).body) as { pid: number }).pid, unit.pid);
    for (let at = Date.now(); !notes().includes(`MAINPID=${unit.pid}`); await sleep(50)) assert.ok(Date.now() - at < 10_000, `no READY=1 from the start:\n${notes()}`);
    assert.match(notes(), /READY=1/);
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await ended(child);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("the unit's notify and watchdog variables leave the environment the server's commands get, and stay for its own notify", () => {
  const env: NodeJS.ProcessEnv = { NOTIFY_SOCKET: "/run/user/1/systemd/notify", WATCHDOG_USEC: "15000000", WATCHDOG_PID: "7", PATH: "/bin" };
  keepUnitEnv(env);
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(systemdEnv().NOTIFY_SOCKET, "/run/user/1/systemd/notify");
  assert.equal(systemdEnv().WATCHDOG_USEC, "15000000");
});

test("a start of the unit leaves a lock holder that is no server of this data dir alone and exits", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "apps-chat-stray-"));
  const data = join(root, "data");
  const notifyPath = join(root, "notify.sock");
  const port = await freePort();
  // A Python process holds the lock the way DataLock does and writes its pid beside it.
  const holder = spawn("python3", ["-u", "-c", `
import os, sqlite3, sys, time
os.makedirs(sys.argv[1], exist_ok=True)
db = sqlite3.connect(os.path.join(sys.argv[1], "server.lock"), isolation_level=None)
db.execute("PRAGMA journal_mode = DELETE")
db.execute("BEGIN EXCLUSIVE")
open(os.path.join(sys.argv[1], "server.lock.pid"), "w").write(f"{os.getpid()}\\n")
print("held", flush=True)
time.sleep(120)
`, data], { stdio: ["ignore", "pipe", "pipe"] });
  const held = collect(holder);
  try {
    for (let at = Date.now(); !held().includes("held"); await sleep(50)) assert.ok(Date.now() - at < 10_000, `the holder did not take the lock:\n${held()}`);
    const unit = spawn("python3", ["-c", SOCKET_UNIT, String(port), process.execPath, "--import", "tsx", "server/main.ts", "--fixture", "--data-dir", data, "--port", String(port)],
      { cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NOTIFY_SOCKET: notifyPath } });
    const out = collect(unit);
    assert.equal(await ended(unit), 1, out());
    assert.match(out(), /does not serve it and exits/);
    assert.equal(holder.exitCode, null, "the holder was ended");
  } finally {
    holder.kill("SIGTERM");
    await ended(holder);
    rmSync(root, { recursive: true, force: true });
  }
});
