// 10-18 us-metal02 at 12:5xZ: swap read 16.0 of 16.0 GiB and /tmp, a tmpfs, held 32.6 GB, most of it 14 p8iso Prime rigs and repo clones that gone
// jobs left. A rig started through systemd-run carries no RLM_HARNESS_STATE_DIR, so the stray stop never saw its processes. A job's end now
// stops the processes in the /tmp trees it made and deletes them, and keeps a tree a live session or a shared service still uses.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endLeftovers, type InsideProcess, type LeftoverSource, madeTmpTrees } from "../src/job-leftovers.ts";

const HELPER = new URL("../src/worker-footprint.py", import.meta.url).pathname;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const header = (at: number) => JSON.stringify({ type: "session", version: 3, id: "x", timestamp: new Date(at).toISOString() }) + "\n";

function transcript(folder: string, id: string, at: number, text: string): string {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${id}.jsonl`);
  writeFileSync(file, header(at) + JSON.stringify({ type: "message", text }) + "\n");
  return file;
}

test("the /tmp trees a gone job made are the ones it names outside tool results that were born while it ran, minus what a live sibling still names", { skip: process.platform === "win32" }, async t => {
  const base = mkdtempSync(join(tmpdir(), "job-tmp-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "tmp");
  const artifacts = join(base, "session-artifacts");
  mkdirSync(join(root, "before"), { recursive: true });
  await pause(30);
  const start = Date.now();
  await pause(30);
  for (const name of ["rig-a", "rig-b", "rig-shared", "tsx-1001", "listed"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "run.json"), "{}");
  const chat = join(artifacts, "01a14dd5-e9d3-705d-bd63-245c21b2eee2");
  const job = join(chat, "sub-aaaa1111");
  transcript(chat, "01a14dd5-e9d3-705d-bd63-245c21b2eee2", start - 60_000, `the job reported ${root}/rig-a and ${root}/rig-b`);
  const ended = transcript(job, "01a14e9c-5b57-7280-b497-b75dc6c20a74", start,
    `mkdir -p ${root}/rig-a ${root}/rig-b; iso-run.py --root ${root}/rig-shared; ls ${root}/before ${root}/tsx-1001 ${root}/missing; cat ${root}/run.json`);
  transcript(join(chat, "sub-bbbb2222"), "01a14ea0-0000-7000-8000-000000000001", start, `took over the rig at ${root}/rig-shared/home`);
  const listing = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: `${root}/rig-a\n${root}/listed` }] } });
  writeFileSync(join(chat, "sub-bbbb2222", "01a14ea0-0000-7000-8000-000000000001.jsonl"), listing + "\n", { flag: "a" });
  writeFileSync(ended, listing + "\n", { flag: "a" });
  transcript(join(chat, "sub-cccc3333"), "01a14ea0-0000-7000-8000-000000000002", start, `read ${root}/rig-b`);
  writeFileSync(join(chat, "sub-cccc3333", "rlm-subagent.json"), JSON.stringify({ status: "deleted" }));
  const made = await madeTmpTrees([ended], [job], root, artifacts);
  assert.deepEqual(made.sort(), [join(root, "rig-a"), join(root, "rig-b"), join(root, "run.json")]);
});

test("a job's end stops the rig processes in its /tmp trees and deletes them, and keeps a tree a live session, Prime or a shared service uses", async () => {
  const [a, b, c, d] = ["/tmp/rig-a", "/tmp/rig-b", "/tmp/rig-c", "/tmp/rig-d"];
  const proc = (pid: number, dir: string, extra: Partial<InsideProcess> = {}): InsideProcess =>
    ({ pid, bytes: 1, started: pid, command: "x", dir, session: null, prime: false, shared: false, ...extra });
  const killed: [number, string][] = [];
  let removed: readonly string[] = [];
  const source: LeftoverSource = {
    strays: async () => [], stopServices: async () => [], started: async pid => pid, kill: (pid, signal) => { killed.push([pid, signal]); }, closeTabs: async () => 0,
    later: () => {}, removeCopies: async () => [],
    tmpTrees: async () => [a, b, c, d],
    inside: async () => [
      proc(101, a), proc(102, a, { session: "01a14e9c-5b57-7280-b497-b75dc6c20a74" }), proc(103, a, { prime: true, session: "01a14e9c-5b57-7280-b497-b75dc6c20a74" }),
      proc(201, b), proc(202, b, { session: "01a14ea0-0000-7000-8000-000000000001" }),
      proc(301, c, { prime: true }),
      proc(401, d, { shared: true }),
    ],
    removeTmp: async dirs => { removed = dirs; return dirs; }, artifactCopies: async () => [], kernelStates: async () => [],
  };
  const base = mkdtempSync(join(tmpdir(), "job-tmp-tree-"));
  try {
    transcript(base, "01a14e9c-5b57-7280-b497-b75dc6c20a74", Date.now(), "ran");
    const left = await endLeftovers(source, base);
    assert.deepEqual(killed, [[101, "SIGTERM"], [102, "SIGTERM"]], "the rig's own process and the gone job's process stop, the gone job's kernel is left to the daemon");
    assert.deepEqual(removed, [a]);
    assert.deepEqual(left.tmp, [a]);
    assert.deepEqual(left.stopped.map(entry => entry.pid), [101, 102]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

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
