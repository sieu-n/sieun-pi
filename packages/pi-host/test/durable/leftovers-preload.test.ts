/**
 * Prime's job-leftovers module loads with DurableRlm, before pi-host listens, so the first rlm.delete_subagent or archive after a restart does
 * not load it on the loop. On us-metal02 on 11-23 its first import held the loop 250 to 270 ms in one turn
 * (~/work/pi-host-stalls/h-restart-resume/report.md).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DurableRlm } from "../../src/durable/rlm.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-leftovers-preload-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("after DurableRlm.load, endJob's import of job-leftovers takes no loop turn of its own", async () => {
  const rlm = await DurableRlm.load({ agentDir: dir });
  try {
    const start = performance.now();
    await import("../../../../legacy/prime/user-history/src/job-leftovers.ts");
    const ms = performance.now() - start;
    assert.ok(ms < 50, `the import took ${Math.round(ms)} ms after load`);
  } finally {
    await rlm.shutdown();
  }
});
