// 10-21 us-metal02: at 02:06:33Z the sweep of chat 01a14210's deleted jobs ran rm -r on ~/work/prime-agent-fix-p8/build-s2int1 and
// build-s2int2 and deleted their .script-as-run copies, all of which the deleted job p8-detached-on-mem41 had recorded with board.own. rm
// deleted release/, inst/, source-rev and feed.SHA256SUMS and the frozen build script, build.log and sha256.txt, and stopped only at the
// read-only feed/ folders other jobs still installed from. A job's end now keeps a recorded tree that publishes a feed, a release, a build log
// or evidence, that another record names, that holds a read-only folder, or that holds anything older than the job, and a private build the
// job made still goes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("a deleted job's end keeps the shared and published trees its record wrongly names and deletes the private build it made", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-end-frozen-"));
  const work = join(home, "work", "prime-agent-fix-p8");
  const feed = join(work, "build-s2int1", "feed");
  t.after(() => { try { chmodSync(feed, 0o755); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const { ARTIFACTS, endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  const older = join(work, "evidence-s2int1");
  write(join(older, "notes.txt"));
  const moved = write(join(home, "work", "other-job", "frozen-script.sh"));
  await pause(20);
  const chat = join(ARTIFACTS, "01a14210-4e7d-72c3-aa67-e3d476f4e728", "sub-740c5dc9");
  const job = join(chat, "sub-47ae7e89");
  const reader = join(chat, "sub-39111b17");
  mkdirSync(job, { recursive: true });
  mkdirSync(reader, { recursive: true });
  writeFileSync(join(job, "01a150ef-c15c-77fc-a233-731209167614.jsonl"), JSON.stringify({ type: "message", text: "built build-s2int1" }) + "\n");
  await pause(20);
  const build1 = join(work, "build-s2int1");
  for (const file of ["release/latest.json", "inst/bin/prime", "source-rev", "feed.SHA256SUMS", "feed/linux-x64/prime.tar.gz"]) write(join(build1, file));
  chmodSync(feed, 0o555);
  const build2 = join(work, "build-s2int2");
  for (const file of ["release/latest.json", "release/prime-linux-x64.tar.gz", "source-rev"]) write(join(build2, file));
  const script = join(work, "build-s2int1.script-as-run");
  for (const file of ["build-test-release.sh", "command.txt", "build.log", "sha256.txt"]) write(join(script, file));
  const shared = join(work, "build-rr1");
  write(join(shared, "out", "prime"));
  writeFileSync(join(reader, "owned.json"), JSON.stringify({ paths: [join(shared, "out")], units: [] }));
  const adopted = join(work, "wt-adopted");
  write(join(adopted, "src", "index.ts"));
  renameSync(moved, join(adopted, "frozen-script.sh"));
  const scratch = join(home, "scratch", "p8-private-build");
  for (const file of ["out/prime", "out/node_modules/x/package.json", "npm-ci.out"]) write(join(scratch, file));
  const own = [build1, build2, script, shared, older, adopted, scratch];
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: own, units: [] }));

  const left = await endLeftovers(leftoverSource, [job]);

  assert.deepEqual(left.owned, [scratch], "only the private build the job made goes");
  assert.deepEqual(readdirSync(build1).sort(), ["feed", "feed.SHA256SUMS", "inst", "release", "source-rev"]);
  for (const kept of [join(build2, "release", "latest.json"), join(script, "build.log"), join(shared, "out", "prime"), join(older, "notes.txt"), join(adopted, "frozen-script.sh")])
    assert.ok(existsSync(kept), kept);
  assert.deepEqual([...left.kept ?? []].sort(), [
    `${adopted}: it holds ${join(adopted, "frozen-script.sh")}, which is older than the job`,
    `${build1}: it holds the published artifact or evidence ${join(build1, "feed")}`,
    `${build2}: it holds the published artifact or evidence ${join(build2, "release")}`,
    `${script}: it holds the published artifact or evidence ${join(script, "build.log")}`,
    `${older}: it is older than the job whose record names it`,
    `${shared}: the record of 01a14210-4e7d-72c3-aa67-e3d476f4e728/sub-740c5dc9/sub-39111b17 names ${join(shared, "out")}`,
  ].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(job, "owned.json"), "utf8")), { paths: [], units: [] }, "the kept paths leave the record, so no later sweep tries them");
});
