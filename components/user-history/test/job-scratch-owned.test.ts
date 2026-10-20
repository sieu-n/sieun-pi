// 10-20 us-metal02: jobs left 33 GB of trees under ~/scratch/<job>/ between 10-19 21:30Z and 10-20 03:40Z, since a job's end deleted only what
// board.own had recorded and jobs rarely called it. The job line now names each job's own folder, ~/scratch/<its session id>/, and the job's
// end deletes that folder and the ones of the sessions under it once no process uses them, and never another session's folder or a shared one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a job's end deletes the scratch folders its job line named for its sessions, and keeps any other or busy one", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-scratch-owned-"));
  const pids: number[] = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const { jobReplyGuideline, jobScratch } = await import("../src/chat-brief.ts");
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const scratch = join(home, "scratch");
  const chat = join(home, ".prime", "agent", "session-artifacts", "01a14fdc-74a4-767c-966e-cbfad7382eff");
  const job = join(chat, "sub-5fff75c0");
  const jobId = "01a15769-0000-7000-8000-000000000000";
  const childId = "01a15769-0000-7000-8000-000000000001";
  const busyId = "01a15769-0000-7000-8000-000000000002";
  const otherId = "01a15769-0000-7000-8000-000000000003";
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  write(join(job, `${jobId}.jsonl`));
  write(join(job, "sub-1", `${childId}.jsonl`));
  write(join(job, "sub-2", `${busyId}.jsonl`));
  assert.ok(jobReplyGuideline({ chat: "Pinterest index", root: false }, jobId).includes(`under ~/scratch/${jobId}/, your own folder`));
  assert.equal(jobScratch(jobId, home), join(scratch, jobId));
  write(join(scratch, jobId, "tree", "package.json"));
  write(join(scratch, childId, "rig", "daemon.log"));
  const busy = write(join(scratch, busyId, "frozen", "release-chat.mjs"));
  const other = write(join(scratch, otherId, "tree", "package.json"));
  const shared = write(join(scratch, "release-applied", "frozen", "release-chat.mjs"));
  const named = write(join(scratch, "loc-cut-2", "rb-1", "package.json"));
  const tail = Number(execFileSync("setsid", ["sh", "-c", `exec tail -f ${busy} >/dev/null 2>&1 & echo $!`], { cwd: home, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" }).trim());
  pids.push(tail);
  await pause(50);
  const left = await endLeftovers(leftoverSource, [job]);
  assert.deepEqual([...left.owned].sort(), [join(scratch, jobId), join(scratch, childId)].sort());
  assert.ok(!existsSync(join(scratch, jobId)) && !existsSync(join(scratch, childId)));
  for (const kept of [busy, other, shared, named]) assert.ok(existsSync(kept), kept);
  process.kill(tail, "SIGKILL");
  await pause(50);
  const again = await endLeftovers(leftoverSource, [job]);
  assert.deepEqual(again.owned, [join(scratch, busyId)], "a later sweep deletes the folder once nothing holds it");
  for (const kept of [other, shared, named]) assert.ok(existsSync(kept), kept);
});
