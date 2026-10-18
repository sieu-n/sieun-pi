// 10-18 07:39Z on us-metal02: a token-hook-resume kill-hooks run read every /proc entry each 20 ms and held 0.5 of a core for its 40-minute window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { descendants, linuxHookRuns } from "../scripts/clean-room/token-hook-resume.ts";

const SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
const waitFor = async (check: () => boolean): Promise<void> => {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 10))) if (Date.now() - started > 5000) throw new Error("timed out");
};

test("kill-hooks finds a hook run under the tree's worker by reading only that worker's descendants", { skip: process.platform !== "linux" }, async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "hook-scan-")), "pi-pool", "bin");
  mkdirSync(bin, { recursive: true });
  const hook = join(bin, "pi-pool-token");
  writeFileSync(hook, "sleep 5\n");
  chmodSync(hook, 0o755);
  const worker = spawn("sh", ["-c", `sh ${hook}; true`], { env: { ...process.env, [SESSION_ENV]: "abc123def456" }, stdio: "ignore" });
  try {
    await waitFor(() => linuxHookRuns(new Set([process.pid])).length > 0);
    const runs = linuxHookRuns(new Set([process.pid]));
    assert.deepEqual(runs.map(run => run.session), ["abc123def456"]);
    assert.ok(descendants(new Set([process.pid])).includes(worker.pid!), "the worker is a child of this process");
    assert.deepEqual(linuxHookRuns(new Set([worker.pid!])).map(run => run.session), ["abc123def456"], "the hook is a child of the worker");
    assert.deepEqual(linuxHookRuns(new Set([1 << 30])), [], "a parent that is gone has no hook runs");
  } finally {
    for (const pid of descendants(new Set([worker.pid!]))) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    worker.kill("SIGKILL");
  }
});
