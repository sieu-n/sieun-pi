// 10-20: staging runs of Portal matches crawler started POST /v1/jobs/{job_id}/cancel together with the reads of the same job, and when the cancel won, GET /v1/jobs/{job_id}/results read a cancelled job and answered 502 upstream_error, so staging_working_pct read 99.4%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BATCH_DEADLINE_MS, BATCH_POLL_MS, QUERY_CHAINS, firstItemId, readsThenWrites, untilBatchEnds } from "../scripts/duties/portal-parity.ts";

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

// 10-28: note_detail's fixed docs example had no current Xiaohongshu xsec_token, so it answered 502; a note from an explore answer opens.
test("note_detail takes its note_id from the first note of this run's explore answer", () => {
  assert.deepEqual(QUERY_CHAINS["GET /v1/xiaohongshu/note_detail"], { from: "GET /v1/xiaohongshu/explore", param: "note_id" });
  assert.equal(firstItemId({ data: [{ id: "6a8f9ae4000000001803c2f0" }, { id: "other" }] }), "6a8f9ae4000000001803c2f0");
  assert.equal(firstItemId({ data: { items: [{ id: "6ab90fef000000000b0074a1" }] } }), "6ab90fef000000000b0074a1");
  assert.equal(firstItemId({ data: [] }), undefined);
  assert.equal(firstItemId(null), undefined);
});

// 10-29: the run read GET /v1/batch/snapshot/{snapshot_id} 0.8 s after the trigger and got 409 snapshot_not_ready while the job still ran.
test("the snapshot read waits for a progress answer that leaves starting and running", async () => {
  const statuses = ["starting", "running", "running", "ready"];
  const slept: number[] = [];
  const reads = await untilBatchEnds(async () => ({ status: 200, body: { data: { status: statuses.shift() } } }), () => 0, async ms => { slept.push(ms); });
  assert.equal(reads, 4);
  assert.deepEqual(slept, [BATCH_POLL_MS, BATCH_POLL_MS, BATCH_POLL_MS]);
});

test("the progress poll stops on a failed progress answer and at the deadline", async () => {
  assert.equal(await untilBatchEnds(async () => ({ status: 404, body: null }), () => 0, async () => {}), 1);
  let clock = 0;
  const reads = await untilBatchEnds(async () => ({ status: 200, body: { data: { status: "running" } } }), () => clock, async ms => { clock += ms; });
  assert.equal(reads, BATCH_DEADLINE_MS / BATCH_POLL_MS + 1);
});
