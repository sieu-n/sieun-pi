import { test } from "node:test";
import assert from "node:assert/strict";
import { machineView, parseSysctl, parseVmStat } from "../src/chat-machine.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4972.
Pages wired down:                             353615.
Pages purgeable:                                  26.
Anonymous pages:                              455047.
Pages occupied by compressor:                1001179.
`;

test("vm_stat counts app, wired and compressed pages as used memory", () => {
  assert.equal(parseVmStat(VM_STAT), (455047 - 26 + 353615 + 1001179) * 16384);
  assert.equal(parseVmStat("no numbers here"), null);
});

test("sysctl gives the pressure level and swap in use", () => {
  assert.deepEqual(parseSysctl("2\ntotal = 39936.00M  used = 39051.81M  free = 884.19M  (encrypted)\n"), { pressure: "warn", swapUsedBytes: Math.round(39051.81 * 1024 * 1024), swapTotalBytes: 39936 * 1024 * 1024 });
  assert.deepEqual(parseSysctl("1\ntotal = 0.00M  used = 0.00M  free = 0.00M\n"), { pressure: "normal", swapUsedBytes: 0, swapTotalBytes: 0 });
  assert.deepEqual(parseSysctl(""), { pressure: null, swapUsedBytes: null, swapTotalBytes: null });
});

test("machineView reads this machine", async () => {
  const view = await machineView();
  assert.ok(view.cpu.cores > 0);
  assert.ok(view.cpu.percent >= 0 && view.cpu.percent <= 100);
  assert.ok(view.memory.usedBytes > 0 && view.memory.usedBytes <= view.memory.totalBytes);
});
