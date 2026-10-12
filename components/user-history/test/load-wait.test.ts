import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { LOAD_WAIT_REASON, loadWaitGuard, loadWaitLoop } from "../src/load-wait.ts";

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

test("loadWaitGuard: kernel code that writes or runs a load gate is refused with the reason; other code and tools pass", async () => {
  const script = await fixture("gate-wait.py");
  const write = `open('/tmp/gate-wait.py','w').write(${JSON.stringify(script)})\nh = bash('python3 -u /tmp/gate-wait.py')`;
  assert.deepEqual(loadWaitGuard("ipython", { code: write }), { block: true, reason: LOAD_WAIT_REASON });
  assert.deepEqual(loadWaitGuard("bash", { command: "while [ $(uptime | awk '{print int($10)}') -gt 30 ]; do sleep 60; done" }), { block: true, reason: LOAD_WAIT_REASON });
  assert.equal(loadWaitGuard("ipython", { code: "r = await bash('npx svelte-check')" }), undefined);
  assert.equal(loadWaitGuard("edit", { code: script }), undefined);
  assert.match(LOAD_WAIT_REASON, /c47, c43/);
});
