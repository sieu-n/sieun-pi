// 10-20: staging runs of Portal matches crawler started POST /v1/jobs/{job_id}/cancel together with the reads of the same job, and when the cancel won, GET /v1/jobs/{job_id}/results read a cancelled job and answered 502 upstream_error, so staging_working_pct read 99.4%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readsThenWrites } from "../scripts/duties/portal-parity.ts";

test("no chained write starts before every chained read of the run has answered", async () => {
  const log: string[] = [];
  const entries = [["POST /v1/jobs/{job_id}/cancel"], ["GET /v1/jobs/{job_id}/results"], ["DELETE /v1/batch/snapshot/{snapshot_id}"], ["GET /v1/jobs/{job_id}"]] as const;
  const results = await readsThenWrites(entries, async ([op]) => {
    log.push(`start ${op}`);
    await new Promise(resolve => setTimeout(resolve, op.startsWith("GET ") ? 20 : 0));
    log.push(`end ${op}`);
    return op;
  });
  const firstWrite = log.findIndex(line => line.startsWith("start ") && !line.startsWith("start GET "));
  const lastRead = log.findLastIndex(line => line.startsWith("end GET "));
  assert.ok(lastRead < firstWrite, log.join("\n"));
  assert.deepEqual(results, ["GET /v1/jobs/{job_id}/results", "GET /v1/jobs/{job_id}", "POST /v1/jobs/{job_id}/cancel", "DELETE /v1/batch/snapshot/{snapshot_id}"]);
});
