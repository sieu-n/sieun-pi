// 10-22 us-metal02: the ClickHouse rigs of two jobs, 87 GB and up to 110 GB under ~/scratch, took the 30-day forecast of / from 61 to 23 days.
// The job line now gives each job a rig folder on /drive2, and the job's end deletes it like the scratch folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a job's end deletes its rig folder on /drive2, and the job line names it", { skip: process.platform !== "linux" || !existsSync(join("/drive2", userInfo().username)) }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-rig-owned-"));
  const jobId = "01a15769-0000-7000-8000-0000000000a1";
  const otherId = "01a15769-0000-7000-8000-0000000000a2";
  const rigs = join("/drive2", userInfo().username, "scratch");
  t.after(() => { for (const id of [jobId, otherId]) rmSync(join(rigs, id), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const { jobFolders, jobReplyGuideline } = await import("../src/chat-brief.ts");
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const job = join(home, ".prime", "agent", "session-artifacts", "01a14fdc-74a4-767c-966e-cbfad7382eff", "sub-5fff75c1");
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  write(join(job, `${jobId}.jsonl`));
  assert.ok(jobReplyGuideline({ chat: "ops guy", root: false }, jobId).includes(`under ${join(rigs, jobId)}/ instead`));
  assert.ok(jobReplyGuideline({ chat: "ops guy", root: false }, jobId).includes("Share one export per commit"), "10-23: 365 job folders held 169 GB of us-metal02's /");
  assert.deepEqual(jobFolders(jobId, home), [join(home, "scratch", jobId), join(rigs, jobId)]);
  write(join(rigs, jobId, "q-cut", "data", "store", "part.bin"));
  const other = write(join(rigs, otherId, "q-cut", "data", "store", "part.bin"));
  const left = await endLeftovers(leftoverSource, [job]);
  assert.deepEqual([...left.owned], [join(rigs, jobId)]);
  assert.ok(!existsSync(join(rigs, jobId)) && existsSync(other));
});
