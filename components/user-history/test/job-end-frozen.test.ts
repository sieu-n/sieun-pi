// 10-21 us-metal02: at 02:06:33Z the sweep of chat 01a14210's deleted jobs ran rm -r on ~/work/prime-agent-fix-p8/build-s2int1 and
// build-s2int2, which the deleted job p8-detached-on-mem41 had recorded with board.own. rm deleted release/, inst/, source-rev and
// feed.SHA256SUMS, then stopped at the read-only feed/ folders its maker had frozen for the jobs that still read them. A recorded tree with a
// folder our user cannot write is now kept whole, as is a recorded path born before the job's session began, and both leave the record.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a deleted job's end keeps a recorded tree with a read-only folder whole and a recorded path older than the job", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-end-frozen-"));
  const feed = join(home, "work", "prime-agent-fix-p8", "build-s2int1", "feed");
  t.after(() => { try { chmodSync(feed, 0o755); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  const work = join(home, "work", "prime-agent-fix-p8");
  const older = join(work, "evidence-s2int1");
  write(join(older, "REPORT.md"));
  await pause(20);
  const job = join(home, ".prime", "agent", "session-artifacts", "01a14210-4e7d-72c3-aa67-e3d476f4e728", "sub-740c5dc9", "sub-47ae7e89");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "01a150ef-c15c-77fc-a233-731209167614.jsonl"), JSON.stringify({ type: "message", text: "built build-s2int1" }) + "\n");
  await pause(20);
  const build = join(work, "build-s2int1");
  for (const file of ["release/latest.json", "inst/bin/prime", "source-rev", "feed.SHA256SUMS", "feed/linux-x64/prime.tar.gz"]) write(join(build, file));
  chmodSync(feed, 0o555);
  const script = join(work, "build-s2int1.script-as-run");
  write(join(script, "build.log"));
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: [build, script, older], units: [] }));
  const left = await endLeftovers(leftoverSource, [join(home, ".prime", "agent", "session-artifacts", "01a14210-4e7d-72c3-aa67-e3d476f4e728", "sub-740c5dc9", "sub-47ae7e89")]);
  assert.deepEqual(left.owned, [script]);
  assert.deepEqual(readdirSync(build).sort(), ["feed", "feed.SHA256SUMS", "inst", "release", "source-rev"]);
  assert.ok(existsSync(join(build, "release", "latest.json")) && existsSync(join(older, "REPORT.md")));
  assert.deepEqual([...left.kept ?? []].sort(), [
    `${build}: it holds the read-only folder ${feed}`,
    `${older}: it is older than the job whose record names it`,
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(job, "owned.json"), "utf8")), { paths: [], units: [] });
});
