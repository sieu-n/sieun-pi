// Guards the 10-19 owner ask to watch the d7 clean minutes: at load 150 to 520 on us-metal02 a scratch serve's two longest main-thread tasks
// were single os.cpus() calls in machineView, 1.0 and 1.6 s, since os.cpus() reads each core's cpufreq file beside /proc/stat.
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { cpuSample, machineView } from "../../prime-relay/host-stats.ts";

test("machineView on Linux reads the cores from /proc/stat and never calls os.cpus()", { skip: process.platform !== "linux" }, async t => {
  const real = os.cpus;
  const cores = real().length;
  let calls = 0;
  os.cpus = () => { calls++; return real(); };
  syncBuiltinESMExports();
  t.after(() => { os.cpus = real; syncBuiltinESMExports(); });
  const view = await machineView();
  assert.equal(calls, 0, "os.cpus() ran on the main thread");
  assert.equal(view.cpu.cores, cores);
  assert.ok(view.cpu.percent >= 0 && view.cpu.percent <= 100);
});

test("a /proc/stat sample sums user, nice, system, idle and irq as os.cpus() does, and counts the cpuN lines", () => {
  const stat = "cpu  100 10 50 800 7 3 9 0 0 0\ncpu0 60 5 25 400 3 1 4 0 0 0\ncpu1 40 5 25 400 4 2 5 0 0 0\nintr 1 2 3\n";
  assert.deepEqual(cpuSample(stat), { busy: 163, total: 963, cores: 2 });
});
