// 10-19: runs of Portal matches crawler that died before their last cancel left 4 prod user_feed jobs open for 4 to 19 h, holding 4 of the prod org's 5 job slots, so job-mode calls got 429.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobLedger, leftoverJobs } from "../scripts/duties/portal-parity.ts";

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
