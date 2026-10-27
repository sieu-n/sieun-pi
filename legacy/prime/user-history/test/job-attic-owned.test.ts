// 10-24 us-metal02: the p500 and box root disk jobs moved 98 finished trees to /drive2/scratch-attic/<same path> with a link at the old
// place, and a job's end kept each one for good, since it deletes no symlink. It now deletes the attic copy and the link.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a job's end deletes its scratch folder's attic copy and the link to it, and keeps another link", { skip: process.platform !== "linux" || !existsSync("/drive2/scratch-attic") }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-attic-"));
  t.after(() => { rmSync(join("/drive2/scratch-attic", home), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const { endLeftovers, leftoverSource, ATTIC } = await import("../src/job-leftovers.ts");
  const jobId = "01a15769-0000-7000-8000-0000000000b1";
  const otherId = "01a15769-0000-7000-8000-0000000000b2";
  const job = join(home, ".prime", "agent", "session-artifacts", "01a14fdc-74a4-767c-966e-cbfad7382eff", "sub-5fff75c2");
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  write(join(job, `${jobId}.jsonl`));
  const scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  for (const id of [jobId, otherId]) {
    write(join(ATTIC + join(scratch, id), "repo", "package.json"));
    symlinkSync(ATTIC + join(scratch, id), join(scratch, id));
  }
  const left = await endLeftovers(leftoverSource, [job]);
  assert.ok(left.owned.includes(join(scratch, jobId)));
  assert.ok(!existsSync(ATTIC + join(scratch, jobId)) && !lstatSync(join(scratch, jobId), { throwIfNoEntry: false }));
  assert.ok(existsSync(join(scratch, otherId, "repo", "package.json")), "another job's link and copy stay");
});
