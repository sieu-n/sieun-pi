// 10-19: runs of Portal matches crawler that died before their last cancel left 4 prod user_feed jobs open for 4 to 19 h, holding 4 of the prod org's 5 job slots, so job-mode calls got 429.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JOB_POLL_MS, jobLedger, jobVerdict, leftoverJobs, routeVerdict, untilJobEnds, type ProbeResult, type Route } from "../scripts/duties/portal-parity.ts";

test("a run's ledger holds each job it opened until the cancel lands, then deletes its file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-jobs-"));
  const ledger = jobLedger(dir, 4242);
  await ledger.add("job_a");
  await ledger.add("job_b");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "4242.json"), "utf8")), ["job_a", "job_b"]);
  await ledger.drop("job_a");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "4242.json"), "utf8")), ["job_b"]);
  await ledger.drop("job_b");
  assert.equal(existsSync(join(dir, "4242.json")), false);
});

test("the next run reads the open jobs of runs whose process is gone and leaves a live run's jobs alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-jobs-"));
  writeFileSync(join(dir, "111.json"), JSON.stringify(["job_dead"]));
  writeFileSync(join(dir, "222.json"), JSON.stringify(["job_live"]));
  writeFileSync(join(dir, "notes.txt"), "x");
  assert.deepEqual(await leftoverJobs(dir, pid => pid === 222), [{ file: join(dir, "111.json"), ids: ["job_dead"] }]);
  assert.deepEqual(await leftoverJobs(join(dir, "none")), []);
});

const read = (status: string, error?: string) => ({ status: 200, body: { data: { batch_id: "job_a", status, ...(error ? { error } : {}) } } });

test("a job-mode probe works only once its job ends ready, never on a held, cancelled or unfinished job", () => {
  // 11-24: d2 cancelled each job 0.15 s after its 202 receipt and scored the receipt, so a held submit would have read as working.
  assert.equal(jobVerdict(read("ready"), 12_000, null).verdict, "ok");
  assert.deepEqual(jobVerdict(read("queued"), 100_000, null), { verdict: "crawler", code: "job_not_started", note: "job still queued 100 s after its submit: the crawler never took its submit", ended: false });
  assert.equal(jobVerdict(read("queued"), 100_000, "geonode lapsed").verdict, "held");
  assert.equal(jobVerdict(read("running"), 100_000, null).verdict, "crawler");
  assert.deepEqual(jobVerdict(read("failed", "cancelled"), 3_000, null).verdict, "unprobed");
  assert.deepEqual(jobVerdict(read("failed", "vent_crawl_paused"), 3_000, null).verdict, "held");
  assert.deepEqual(jobVerdict(read("failed", "temporarily_unavailable"), 3_000, null), { verdict: "crawler", code: "temporarily_unavailable", note: "job failed temporarily_unavailable 3 s after its submit", ended: true });
  assert.equal(jobVerdict({ status: 402, body: { error: { code: "insufficient_balance" } } }, 1_000, null).verdict, "unprobed");
});

test("the job watch reads until the job ends or the deadline passes", async () => {
  let clock = 0;
  const sleep = async (ms: number) => { clock += ms; };
  const answers = [read("queued"), read("running"), read("ready")];
  const ended = await untilJobEnds(async () => answers.shift()!, 100_000, () => clock, sleep);
  assert.deepEqual([ended.reads, ended.last], [3, read("ready")]);
  clock = 0;
  const late = await untilJobEnds(async () => read("queued"), 3 * JOB_POLL_MS, () => clock, sleep);
  assert.deepEqual([late.reads, late.last], [4, read("queued")]);
});

test("a route whose job-mode call got no job does not work on its page-mode call alone", () => {
  // 11-24 06:11Z: four prod job calls answered 429 while another run held the org's job slots, and their routes scored working.
  const route: Route = { crawler: "GET /api/live/youtube/channel_videos", group: "youtube", portal: ["GET /v1/youtube/channel_videos", "GET /v1/youtube/channel_videos job"] };
  const ops = new Map([["GET /v1/youtube/channel_videos", {}]]);
  const page: ProbeResult = { op: route.portal[0]!, verdict: "ok", status: 200, ms: 1, note: "" };
  const job = (verdict: ProbeResult["verdict"], status: number): ProbeResult => ({ op: route.portal[1]!, verdict, status, ms: 1, note: "" });
  assert.equal(routeVerdict(route, ops, new Map([[page.op, page], [route.portal[1]!, job("unprobed", 429)]])), "unprobed");
  assert.equal(routeVerdict(route, ops, new Map([[page.op, page], [route.portal[1]!, job("ok", 202)]])), "works");
});
