import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
// The test may itself run from an armed cell, whose prefix and shim path the runner must not inherit.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "PRIME_AGENT_BASH_COMMAND_PREFIX" && key !== "PYTHONPATH"));
const cells = (codes: string[]) => {
  const run = spawnSync("python3", ["-c", RUNNER], { input: JSON.stringify(codes), encoding: "utf8", timeout: 60_000, env });
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

test("endLoadWait: a kernel wait loop ends after its first check, in the cell and in the Python and shell commands it starts; library sleeps and a quoting cell run", () => {
  const loop = "import os, time\nwhile os.getloadavg()[0] >= 0:\n    print('check', flush=True)\n    time.sleep(60)";
  const asyncLoop = "import asyncio, os\nwhile os.getloadavg()[0] >= 0:\n    print('check', flush=True)\n    await asyncio.sleep(60)";
  const child = "import os, subprocess, sys, threading, time\nt = threading.Thread(target=time.sleep, args=(0.01,)); t.start(); t.join()\n" +
    "py = subprocess.run([sys.executable, '-c', 'import os, time\\nos.getloadavg()\\nprint(1, flush=True)\\ntime.sleep(60)'], capture_output=True, text=True)\n" +
    "sh = subprocess.run(['bash', '-c', os.environ['PRIME_AGENT_BASH_COMMAND_PREFIX'] + '\\nwhile true; do uptime > /dev/null; echo check; sleep 60; done'], capture_output=True, text=True)\n" +
    "print(py.returncode, py.stdout.strip(), sh.returncode, sh.stdout.strip(), flush=True)\nwhile os.getloadavg()[0] >= 0: time.sleep(60)";
  const library = "import asyncio, os, time\nscope = {}\nexec(compile('import asyncio, time\\nasync def settle():\\n    await asyncio.sleep(0.01)\\n    time.sleep(0.01)\\n', '<global-rules rlm-delete>', 'exec'), scope)\n" +
    "await scope['settle']()\nprint('library sleeps ran', flush=True)\nwhile os.getloadavg()[0] >= 0: time.sleep(60)";
  // A cell that only quotes a wait: its own sleeps, its Python children's and its shell commands' run, since none follows a load read.
  const quoted = "import os, subprocess, sys, time\nquoted = 'while os.getloadavg()[0] > 20:\\n    time.sleep(60)'\ntime.sleep(0.01)\n" +
    "py = subprocess.run([sys.executable, '-c', 'import time\\ntime.sleep(0.2)\\nprint(1)'], capture_output=True, text=True)\n" +
    "sh = subprocess.run(['bash', '-c', os.environ['PRIME_AGENT_BASH_COMMAND_PREFIX'] + '\\nsleep 0.1; echo ok'], capture_output=True, text=True)\n" +
    "print(py.returncode, py.stdout.strip(), py.stderr.strip(), sh.returncode, sh.stdout.strip(), flush=True)";
  const after = "import os, time\ntime.sleep(0.01)\nassert 'PRIME_AGENT_BASH_COMMAND_PREFIX' not in os.environ and 'load-wait-shim' not in os.environ.get('PYTHONPATH', '')";
  const out = cells([armed(loop), armed(asyncLoop), armed(child), armed(library), armed(quoted), after]);
  assert.deepEqual(out, [
    "check", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    "check", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    "75 1 75 check", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    "library sleeps ran", `{"ended": "LoadWaitEnded", "text": "the load wait ended after its first check (c47); run the check now"}`,
    "0 1  0 ok", `{"ok": true}`,
    `{"ok": true}`,
  ]);
});

test("endLoadWait: a bash command's shell loop and its Python gate script end after their first check with exit 75", async () => {
  const dir = await mkdtemp(join(tmpdir(), "load-wait-"));
  try {
    await writeFile(join(dir, "gate-wait.py"), await fixture("gate-wait.py"));
    const shell = spawnSync("bash", ["-c", SHELL_END + "while [ $(uptime | wc -c) -gt 0 ]; do echo check; sleep 60; done"], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(shell.status, 75);
    assert.equal(shell.stdout, "check\n");
    const gate = spawnSync("bash", ["-c", `${SHELL_END}python3 -u ${join(dir, "gate-wait.py")}`], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(gate.status, 75);
    assert.match(gate.stdout, /^\d\d:\d\d:\d\d load [\d.]+ free \d+\n$/);
    assert.match(gate.stderr, /load wait ended after its first check/);
    // A release's shim and the checkout's both on the path: each skips the other instead of loading it in a loop.
    const copy = join(dir, "load-wait-shim");
    await mkdir(copy);
    await writeFile(join(copy, "sitecustomize.py"), await readFile(join(import.meta.dirname, "..", "src", "load-wait-shim", "sitecustomize.py")));
    const both = spawnSync("bash", ["-c", `${SHELL_END}PYTHONPATH=${copy}:$PYTHONPATH python3 -u ${join(dir, "gate-wait.py")}`], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(both.status, 75);
    assert.doesNotMatch(both.stderr, /RecursionError|Error in sitecustomize/);
    // The global-rules sitecustomize runs the next one on the path, which is the shim again (load wait probe 2, 10-18 02:20Z).
    const rules = join(import.meta.dirname, "..", "..", "global-rules", "python-child");
    const chained = spawnSync("bash", ["-c", `${SHELL_END}PYTHONPATH=$PYTHONPATH:${rules} python3 -c 'import time; time.sleep(0.01); print(1)'`], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(chained.status, 0, chained.stderr);
    assert.equal(chained.stdout, "1\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
