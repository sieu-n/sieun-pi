// 10-19 us-metal02: at 02:06Z the end of job metal agent verification deleted the shared ~/scratch/release-applied and SIGTERMed four release
// processes of other jobs that ran the helper from it, since the job end read what a job made from mentions. A job now records what it throws
// away (board.own, owned.json in its session folder), and its end deletes only those paths that no process uses and stops only those
// transient units.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts `command` detached under the user's init, as systemd-run or a nohup'd job would leave it, and returns its pid. */
function detached(command: string, cwd: string): number {
  return Number(execFileSync("setsid", ["sh", "-c", `${command} >/dev/null 2>&1 & echo $!`], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" }).trim());
}

test("a deleted job's end deletes only the free paths and stops only the transient units its own record names", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-end-owned-"));
  const pids: number[] = [];
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "systemctl-calls");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> ${calls}\ncase "$*" in\n` +
    `  *show*own-rig.service*) printf 'ActiveState=active\\nTransient=yes\\n' ;;\n` +
    `  *show*sieun-pi-chat.service*) printf 'ActiveState=active\\nTransient=no\\n' ;;\n` +
    `  *show*) printf 'ActiveState=inactive\\nTransient=yes\\n' ;;\nesac\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const scratch = join(home, "scratch");
  const chat = join(home, ".prime", "agent", "session-artifacts", "01a14210-4e7d-72c3-aa67-e3d476f4e728");
  const job = join(chat, "sub-7e8789ef");
  mkdirSync(job, { recursive: true });
  const write = (file: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x"); return file; };
  write(join(scratch, "own-job", "tree", "package.json"));
  write(join(scratch, "own-job", "rig", "daemon.log"));
  write(join(scratch, "own-job", "busy", "frozen", "release-chat.mjs"));
  const shared = write(join(scratch, "release-applied", "frozen", "release-chat.mjs"));
  const report = write(join(home, "work", "own-job", "REPORT.md"));
  symlinkSync(join(home, "work", "own-job"), join(scratch, "own-job", "link"));
  const busy = detached(`exec tail -f ${join(scratch, "own-job", "busy", "frozen", "release-chat.mjs")}`, home);
  const release = detached(`exec tail -f ${shared}`, join(scratch, "release-applied"));
  pids.push(busy, release);
  await pause(50);
  writeFileSync(join(job, "01a150f1-c33c-753f-9526-0cdb90358874.jsonl"), JSON.stringify({ type: "message", text: `ran ${shared}; wrote ${report}` }) + "\n");
  writeFileSync(join(job, "owned.json"), JSON.stringify({
    paths: [join(scratch, "own-job", "tree"), join(scratch, "own-job", "rig") + "/", join(scratch, "own-job", "busy"), join(scratch, "own-job", "link"),
      join(home, "work", "own-job"), scratch, job, join(chat, "sub-other"), "relative/tree", 7],
    units: ["own-rig.service", "sieun-pi-chat.service", "gone-unit.service", "bad unit; rm -rf ~", 3],
  }));
  const left = await endLeftovers(leftoverSource, [job]);
  assert.deepEqual([...left.owned].sort(), [join(scratch, "own-job", "rig"), join(scratch, "own-job", "tree")]);
  assert.deepEqual(left.units, ["own-rig.service"]);
  assert.ok(!existsSync(join(scratch, "own-job", "tree")) && !existsSync(join(scratch, "own-job", "rig")));
  for (const kept of [shared, report, join(scratch, "own-job", "busy", "frozen", "release-chat.mjs"), join(scratch, "own-job", "link"), job]) assert.ok(existsSync(kept), kept);
  assert.ok(alive(busy) && alive(release), "a cleanup signals no process that uses a path");
  const stops = readFileSync(calls, "utf8").split("\n").filter(line => line.startsWith("--user stop"));
  assert.deepEqual(stops, ["--user stop -- own-rig.service"]);
  assert.deepEqual(JSON.parse(readFileSync(join(job, "owned.json"), "utf8")), { paths: [join(scratch, "own-job", "busy")], units: [] });
});
