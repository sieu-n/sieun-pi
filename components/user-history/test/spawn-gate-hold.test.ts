import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { messageCheckPrelude } from "../src/message-limit-check.ts";

// The spawn gate in the kernel wrapper: on 10-15 from 08:37Z to 09:37Z live sessions went from 66 to 133 and Prime's workers from 17 to
// 27 GiB while 21 of 53 minutes were unusable. A spawn pi-pool holds returns a queued handle at once and starts in the background on go.
const kernel = async (pool: "held" | "go" | "none") => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-gate-"));
  await writeFile(join(dir, "rlm.py"), [
    "import time",
    "sent, marks = [], []",
    "class repl:",
    "    @staticmethod",
    "    def emit(data): marks.append(list(data.values())[0]['active'])",
    "async def host_request(request_type, payload=None):",
    "    sent.append((request_type, round(time.time(), 1)))",
    "    return {'rlm_child_id': 'sub-1', 'name': payload['kwargs']['name'], 'session_dir': '/s/sub-1', 'model': 'm'}",
    "async def spawn(prompt, *, name):",
    "    return await host_request('rlm.run', {'prompt': prompt, 'kwargs': {'name': name}})",
  ].join("\n") + "\n");
  await writeFile(join(dir, "agent_message.py"), "from rlm import host_request\n");
  if (pool !== "none") {
    await mkdir(join(dir, ".local", "bin"), { recursive: true });
    const bin = join(dir, ".local", "bin", "pi-pool");
    await writeFile(bin, [
      "#!/usr/bin/env python3",
      "import json, sys, time",
      "if sys.argv[2] == 'enter':",
      `    print(json.dumps({"state": "held", "ticket": "t1", "position": 3, "total": 3, "gb": 24.5, "hold_on_gb": 20, "hold_off_gb": 16} if ${JSON.stringify(pool)} == 'held' else {"state": "go"}))`,
      "else:",
      "    time.sleep(0.5)",
      "    print(json.dumps({'state': 'go'}))",
    ].join("\n") + "\n");
    await chmod(bin, 0o755);
  }
  const script = messageCheckPrelude(dir) + [
    "import asyncio, json, rlm",
    "async def main():",
    "    handle = await rlm.spawn('do it', name='kid')",
    "    at_return = list(rlm.sent)",
    "    await asyncio.sleep(1.5)",
    "    held = getattr(rlm, 'held_spawns', {}).get('kid', {})",
    "    print(json.dumps({'handle': handle['rlm_child_id'], 'at_return': len(at_return), 'later': len(rlm.sent), 'held': held.get('state'), 'marks': rlm.marks}))",
    "asyncio.run(main())",
  ].join("\n");
  return spawnSync("python3", ["-c", script], { cwd: dir, env: { ...process.env, PYTHONPATH: dir, HOME: dir }, encoding: "utf8" });
};

test("a held spawn returns a queued handle at once and sends rlm.run when the gate says go", async () => {
  const run = await kernel("held");
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(out, { handle: "queued-t1", at_return: 0, later: 1, held: "started", marks: [true, false] });
  assert.match(run.stdout, /kid is queued, not started: the Prime daemon and its workers hold 24\.5 GiB/);
});

test("a spawn the gate lets go, or a missing pi-pool, sends rlm.run at once", async () => {
  for (const pool of ["go", "none"] as const) {
    const run = await kernel(pool);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").at(-1)!), { handle: "sub-1", at_return: 1, later: 1, held: null, marks: [] }, pool);
  }
});
