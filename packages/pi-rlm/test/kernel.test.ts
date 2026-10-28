import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { existsSync } from "node:fs";
import { Kernel, KernelBusyError, type HostRequest } from "../src/core/kernel.ts";
import { RUNTIME_SRC } from "../src/core/python.ts";
import { bootstrapCode } from "../src/core/bootstrap.ts";
import { testPython } from "./helpers.ts";

let python = "";
before(async () => {
  python = await testPython();
});

function open(onHostRequest: (r: HostRequest) => Promise<unknown> = async () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rlm-kernel-"));
  const kernel = Kernel.spawn({
    python,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: RUNTIME_SRC, RLM_SESSION_DIR: dir },
    onHostRequest,
  });
  return { kernel, dir };
}

test("a kernel keeps state across cells, streams output and answers host requests", async () => {
  const seen: HostRequest[] = [];
  const { kernel, dir } = open(async r => {
    seen.push(r);
    return { echo: r.n };
  });
  try {
    const ready = await kernel.ready;
    assert.equal(ready.protocol, 3);
    assert.equal((await kernel.execute(bootstrapCode([]))).status, "ok");
    await kernel.execute("x = 41");
    assert.equal((await kernel.execute("x + 1")).result, "42");
    const chunks: string[] = [];
    const streamed = await kernel.execute("import asyncio\nfor i in range(3):\n    print('tick', i, flush=True)\n    await asyncio.sleep(0.05)", { onStream: t => chunks.push(t) });
    assert.equal(streamed.stdout, "tick 0\ntick 1\ntick 2\n");
    assert.ok(chunks.length >= 3);
    const reply = await kernel.execute("from rlm import host_request\nr = await host_request('demo.echo', {'n': 7})\nr");
    assert.equal(reply.result, "{'echo': 7}");
    assert.deepEqual(seen.map(r => r.type), ["demo.echo"]);
    const failed = await kernel.execute("1/0");
    assert.equal(failed.status, "error");
    assert.equal(failed.error?.ename, "ZeroDivisionError");
  } finally {
    await kernel.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted cell gets KeyboardInterrupt and the kernel keeps serving", async () => {
  const { kernel, dir } = open();
  try {
    await kernel.execute(bootstrapCode([]));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await kernel.execute("import time\nwhile True:\n    time.sleep(0.05)", { signal: ac.signal });
    assert.equal(r.status, "aborted");
    assert.equal(r.error?.ename, "KeyboardInterrupt");
    assert.equal((await kernel.execute("2 + 2")).result, "4");
  } finally {
    await kernel.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a snapshot revives names in a fresh kernel process", async () => {
  const a = open();
  const b = open();
  const path = join(a.dir, "kernel-state.dill");
  try {
    await a.kernel.execute(bootstrapCode([]));
    await a.kernel.execute("data = {'k': [1, 2, 3]}\ndef twice(v):\n    return v * 2");
    const snap = await a.kernel.snapshot(path, join(a.dir, "kernel-state.json"));
    assert.equal(snap.status, "ok");
    assert.deepEqual([...snap.saved].sort(), ["data", "twice"]);
    await a.kernel.shutdown();
    const restored = await b.kernel.restore(path);
    assert.deepEqual([...restored.restored].sort(), ["data", "twice"]);
    await b.kernel.execute(bootstrapCode([]));
    assert.equal((await b.kernel.execute("twice(len(data['k']))")).result, "6");
  } finally {
    await a.kernel.shutdown();
    await b.kernel.shutdown();
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("an interrupted cell that keeps running makes the kernel busy until it ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rlm-busy-"));
  const kernel = Kernel.spawn({
    python,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: RUNTIME_SRC },
    onHostRequest: async () => ({}),
    interruptGraceMs: 300,
  });
  try {
    await kernel.execute(bootstrapCode([]));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await kernel.execute("import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ny = 5\ntime.sleep(2)", { signal: ac.signal });
    assert.equal(r.status, "aborted");
    assert.equal(r.stillRunning, true);
    assert.equal(kernel.busy, true);
    await assert.rejects(kernel.execute("y"), KernelBusyError);
    const t0 = Date.now();
    await kernel.idle();
    assert.ok(Date.now() - t0 > 800, "idle() waited for the cell");
    assert.equal((await kernel.execute("y")).result, "5");
  } finally {
    await kernel.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relayed kernel outlives its client, buffers a finished bash() notice and reattaches with its namespace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rlm-relay-"));
  const socket = join(dir, "k.sock");
  const seen: HostRequest[] = [];
  const options = {
    python,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: RUNTIME_SRC, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "" },
    onHostRequest: async (r: HostRequest) => {
      seen.push(r);
      return {};
    },
  };
  const relay = { socket, logPath: join(dir, "relay.log"), wakeSession: "s1", unit: `pi-rlm-test-${process.pid}-${Date.now()}` };
  const a = (await Kernel.relay(options, relay, true))!;
  try {
    assert.equal((await a.ready).reattached, false);
    await a.execute(bootstrapCode([]));
    const started = await a.execute("x = 41\nh = bash('sleep 1.5; echo relayed')\nh.pid");
    const pid = Number(started.result);
    a.detach("on_event");
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(seen.length, 0, "nothing reached the detached client");
    const b = (await Kernel.relay(options, relay, false))!;
    assert.equal((await b.ready).reattached, true);
    assert.equal((await b.execute("x + 1")).result, "42");
    assert.match((await b.execute("h.poll().output")).result ?? "", /relayed/);
    assert.ok(seen.some(r => r.type === "bash.completed" && r.pid === pid), "the buffered bash.completed reached the new client");
    await b.shutdown();
    for (let i = 0; i < 50 && existsSync(socket); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(existsSync(socket), false, "the relay removed its socket after the kernel shut down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a relayed kernel that has run no cell reads as fresh to the next client, which then runs the bootstrap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rlm-relay-"));
  const options = {
    python,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONPATH: RUNTIME_SRC, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "" },
    onHostRequest: async () => ({}),
  };
  const relay = { socket: join(dir, "k.sock"), logPath: join(dir, "relay.log"), wakeSession: "s1", unit: `pi-rlm-test-${process.pid}-${Date.now()}-fresh` };
  const first = (await Kernel.relay(options, relay, true))!;
  try {
    assert.equal((await first.ready).reattached, false);
    first.detach("on_event");
    const second = (await Kernel.relay(options, relay, false))!;
    assert.equal((await second.ready).reattached, false, "a client that saw ready and left before any cell does not make the kernel reattached");
    await second.execute(bootstrapCode([]));
    second.detach("on_event");
    const third = (await Kernel.relay(options, relay, false))!;
    assert.equal((await third.ready).reattached, true);
    assert.equal((await third.execute("callable(bash) and rlm is not None")).result, "True");
    await third.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
