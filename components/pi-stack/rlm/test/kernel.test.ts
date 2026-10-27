import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { Kernel, type HostRequest } from "../src/kernel.ts";
import { RUNTIME_SRC } from "../src/python.ts";
import { bootstrapCode } from "../src/bootstrap.ts";
import { testPython } from "./helpers.ts";

let python = "";
before(async () => {
  python = await testPython();
});

function open(onHostRequest: (r: HostRequest) => Promise<unknown> = async () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), "pi-rlm-kernel-"));
  const kernel = new Kernel({
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
