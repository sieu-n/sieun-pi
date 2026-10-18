import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endLoadWait, LOAD_WAIT_NOTE, LOAD_WAIT_PRELUDE, loadWaitLoop, loadWaitNote, SHELL_END } from "../src/load-wait.ts";

// The 5 scripts behind the 8 load-wait loops killed 10-13 00:32 KST, pinned verbatim, and the proxy census watcher that loops and sleeps
// without reading load.
const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "load-wait", name), "utf8");

test("loadWaitLoop: every 10-12 load gate script is a load wait; a load read, a load logger and a monitor loop are not", async () => {
  for (const name of ["gate-waiter.py", "load_gate.py", "gate.py", "gate-wait.py", "part-5-waiter.py"]) assert.equal(loadWaitLoop(await fixture(name)), true, name);
  assert.equal(loadWaitLoop(await fixture("watch_proxy_census_monitor_v9.py")), false, "a monitor loop that reads no load");
  assert.equal(loadWaitLoop("import os\nprint(os.getloadavg())"), false, "one reading is fine");
  assert.equal(loadWaitLoop("import os, time\nwhile True:\n    print(os.getloadavg())\n    time.sleep(60)"), false, "a logger that never waits on a number");
  assert.equal(loadWaitLoop("import os, time\nwhile os.getloadavg()[0] > 20:\n    time.sleep(60)"), true, "a wait in the while test");
  assert.equal(loadWaitLoop("until [ $(sysctl -n vm.loadavg | awk '{print int($2)}') -lt 20 ]; do sleep 60; done; npm run build"), true, "the shell form");
});

test("loadWaitNote: kernel code that writes or runs a load gate runs and gets the c47 note; other code and tools get none", async () => {
  const script = await fixture("gate-wait.py");
  const write = `open('/tmp/gate-wait.py','w').write(${JSON.stringify(script)})\nh = bash('python3 -u /tmp/gate-wait.py')`;
  assert.equal(loadWaitNote("ipython", { code: write }), LOAD_WAIT_NOTE);
  assert.equal(loadWaitNote("bash", { command: "while [ $(uptime | awk '{print int($10)}') -gt 30 ]; do sleep 60; done" }), LOAD_WAIT_NOTE);
  assert.equal(loadWaitNote("ipython", { code: "r = await bash('npx svelte-check')" }), undefined);
  assert.equal(loadWaitNote("edit", { code: script }), undefined);
  assert.match(LOAD_WAIT_NOTE, /c47, c43/);
  assert.doesNotMatch(LOAD_WAIT_NOTE, /Refused/);
});

// The cell runner the Python kernel uses for a cell: one asyncio task per cell, top-level await allowed.
const RUNNER = `
import ast, asyncio, json, sys
async def run(code, scope):
    value = eval(compile(code, "<cell>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), scope)
    if asyncio.iscoroutine(value):
        await value
async def main():
    scope = {}
    for code in json.loads(sys.stdin.read()):
        try:
            await asyncio.create_task(run(code, scope))
            print(json.dumps({"ok": True}), flush=True)
        except BaseException as error:
            print(json.dumps({"ended": type(error).__name__, "text": str(error)}), flush=True)
asyncio.run(main())
`;
const cells = (codes: string[]) => {
  const run = spawnSync("python3", ["-c", RUNNER], { input: JSON.stringify(codes), encoding: "utf8", timeout: 60_000 });
  return run.stdout.split("\n").filter(Boolean);
};
const armed = (code: string) => (endLoadWait("ipython", { code }) as { code: string }).code;

test("endLoadWait: a load-wait call gets the prelude or the shell lines in front; other calls are left as they are", () => {
  const wait = "import os, time\nwhile os.getloadavg()[0] > 20:\n    time.sleep(60)";
  assert.deepEqual(endLoadWait("ipython", { code: wait }), { code: LOAD_WAIT_PRELUDE + wait });
  assert.deepEqual(endLoadWait("bash", { command: "until [ $(sysctl -n vm.loadavg | awk '{print int($2)}') -lt 20 ]; do sleep 60; done" }),
    { command: `${SHELL_END}until [ $(sysctl -n vm.loadavg | awk '{print int($2)}') -lt 20 ]; do sleep 60; done` });
  assert.equal(endLoadWait("ipython", { code: "r = await bash('npx svelte-check')" }), undefined);
  assert.equal(endLoadWait("edit", { code: wait }), undefined);
});

test("endLoadWait: a kernel wait loop ends after its first check, in the cell and in the Python and shell commands it starts", () => {
  const loop = "import os, time\nwhile os.getloadavg()[0] >= 0:\n    print('check', flush=True)\n    time.sleep(60)";
  const asyncLoop = "import asyncio, os\nwhile os.getloadavg()[0] >= 0:\n    print('check', flush=True)\n    await asyncio.sleep(60)";
  const child = "import os, subprocess, sys, threading, time\nt = threading.Thread(target=time.sleep, args=(0.01,)); t.start(); t.join()\n" +
    "py = subprocess.run([sys.executable, '-c', 'import time\\nprint(1, flush=True)\\ntime.sleep(60)'], capture_output=True, text=True)\n" +
    "sh = subprocess.run(['bash', '-c', os.environ['PRIME_AGENT_BASH_COMMAND_PREFIX'] + '\\nwhile true; do echo check; sleep 60; done'], capture_output=True, text=True)\n" +
    "print(py.returncode, py.stdout.strip(), sh.returncode, sh.stdout.strip(), flush=True)\nwhile os.getloadavg()[0] >= 0: time.sleep(60)";
  const after = "import os, time\ntime.sleep(0.01)\nassert 'PRIME_AGENT_BASH_COMMAND_PREFIX' not in os.environ and 'load-wait-shim' not in os.environ.get('PYTHONPATH', '')";
  const out = cells([armed(loop), armed(asyncLoop), armed(child), after]);
  assert.deepEqual(out, [
    "check", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    "check", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    "75 1 75 check", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    `{"ok": true}`,
  ]);
});

test("endLoadWait: a bash command's shell loop and its Python gate script end after their first check with exit 75", async () => {
  const dir = await mkdtemp(join(tmpdir(), "load-wait-"));
  try {
    await writeFile(join(dir, "gate-wait.py"), await fixture("gate-wait.py"));
    const shell = spawnSync("bash", ["-c", SHELL_END + "while true; do echo check; sleep 60; done"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(shell.status, 75);
    assert.equal(shell.stdout, "check\n");
    const gate = spawnSync("bash", ["-c", `${SHELL_END}python3 -u ${join(dir, "gate-wait.py")}`], { encoding: "utf8", timeout: 60_000 });
    assert.equal(gate.status, 75);
    assert.match(gate.stdout, /^\d\d:\d\d:\d\d load [\d.]+ free \d+\n$/);
    assert.match(gate.stderr, /load wait ended after its first check/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
