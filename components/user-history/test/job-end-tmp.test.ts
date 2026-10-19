// 10-19 us-metal02 at 02:06Z: the end of job metal agent verification deleted the shared ~/scratch/release-applied while release processes of
// other jobs ran its helper under systemd-run. worker-footprint.py --inside finds every process that runs in, holds or names a folder, and a
// cleanup keeps a folder any such process uses.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InsideProcess } from "../src/job-leftovers.ts";

const HELPER = new URL("../src/worker-footprint.py", import.meta.url).pathname;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("worker-footprint.py --inside names a rig process by its cwd or home and a live session's process by the path its command names", { skip: !existsSync("/proc/self/cwd") }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "job-tmp-inside-"));
  const rig = spawn("sleep", ["30"], { cwd: dir, env: { PATH: process.env.PATH }, stdio: "ignore" });
  const home = spawn("sleep", ["31"], { env: { PATH: process.env.PATH, HOME: join(dir, "home") }, stdio: "ignore" });
  const state = "/home/x/.prime/agent/session-artifacts/01a14dd5-e9d3-705d-bd63-245c21b2eee2/session-artifacts/01a14ea0-0000-7000-8000-000000000001/harness";
  const live = spawn("sh", ["-c", `sleep 32 # ${dir}/log`], { env: { PATH: process.env.PATH, RLM_HARNESS_STATE_DIR: state }, stdio: "ignore" });
  t.after(() => { for (const child of [rig, home, live]) child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  await pause(200);
  const found = (JSON.parse(execFileSync("/usr/bin/python3", ["-B", HELPER, "--inside"], { encoding: "utf8", input: dir + "\n" })) as { inside: InsideProcess[] }).inside;
  const of = (pid: number | undefined) => found.find(entry => entry.pid === pid);
  assert.equal(of(rig.pid)?.session, null);
  assert.equal(of(rig.pid)?.prime, false);
  assert.equal(of(home.pid)?.dir, dir);
  assert.equal(of(live.pid)?.session, "01a14ea0-0000-7000-8000-000000000001");
});
