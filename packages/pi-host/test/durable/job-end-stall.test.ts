/**
 * A job end that holds pi-host's loop is named in the stall line, also when it runs outside rlm.delete_subagent, as an archive's does
 * (`DurableRlm.endThread`). On 11-23 the stall lines named no tracked work, and an untimed "ended: deleted" line printed after one read as
 * its cause (~/work/pi-host-stalls/k-job-end/report.md).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { leftoverSource } from "../../../../legacy/prime/user-history/src/job-leftovers.ts";
import { DurableRlm } from "../../src/durable/rlm.ts";
import { LoopStalls } from "../../src/loop-stall.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-job-end-stall-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Holds the loop for `ms`, as a job end that reads thousands of records in one turn does. */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* the loop is held */ }
}

test("a job end that holds the loop over 500 ms writes a stall line naming the job end and its session", async () => {
  const lines: string[] = [];
  const stalls = new LoopStalls({ log: line => lines.push(line) });
  const id = "12ebf3bd-55f3-496b-a9d5-c8a27cee783b";
  const leftovers = { ...leftoverSource, stopServices: async () => [], strays: async () => { block(700); return []; }, closeTabs: async () => 0 };
  const rlm = await DurableRlm.load({ agentDir: join(dir, "agent"), chatUrl: "http://127.0.0.1:9", leftovers });
  try {
    await rlm.endJob(id, join(dir, "threads", `${id}.sqlite`), 74);
    await new Promise(resolve => setTimeout(resolve, 150));
    const line = lines.find(text => text.startsWith("loop stall "));
    assert.ok(line, `no loop stall line in ${JSON.stringify(lines)}`);
    assert.match(line, /\| ran: job end in 12ebf3bd-74, (\d+ rows, )?\d+ ms of it in the stall/);
  } finally {
    stalls.stop();
    await rlm.shutdown();
  }
});
