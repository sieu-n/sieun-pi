import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leftoverSource } from "../src/job-leftovers.ts";
import { type Footprints, type RawKernel, type RawOrphan, readFootprints, watchLine } from "../src/mac-usable-watch.ts";

/**
 * 10-15 00:37 to 00:53Z: the VP of SEO tree grew to 16 to 25.5 GiB and the Mac swapped at up to 25,873 swapouts a second. old_analysis.py (pid
 * 77405, 30.26 GB at its peak) ran under a nohup'd runner.py that the job 'seo data memory fix' started; the chat deleted the job at about
 * 00:45Z and the runner went on. The watch line counts such an orphan against its chat's tree.
 */
const GB = 1024 ** 3;
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const SEO_JOB = "01a13a00-0000-7000-8000-5e0da7a00001";
const KERNEL = 4242;
const STARTED = 1792024560;

/** A minute of the SEO tree: the chat's kernel (1 GiB with a 0.5 GiB vite under it), the orphaned runner.py, and old_analysis.py holding the rest. */
function seoFootprints(gb: number): Footprints {
  const kernel: RawKernel = { pid: KERNEL, root: SEO, session: SEO, pids: 2, bytes: 1 * GB,
    biggest: { pid: 5000, bytes: 0.5 * GB, started: STARTED - 3600, command: "node vite dev --port 5189" } };
  const orphan = (pid: number, bytes: number, command: string): RawOrphan => ({ pid, bytes, started: STARTED, command, root: SEO, session: SEO_JOB });
  return { workers: { 11: { pids: 6, bytes: gb * GB + 0.3 * GB } }, kernels: [kernel],
    orphans: [orphan(77400, 0.02 * GB, "python3 runner.py"), orphan(77405, (gb - 1.02) * GB, "python3 old_analysis.py --all")], swap_used_bytes: 20 * GB, pressure_level: 2, cpu_s: 0.2 };
}
const at = (clock: string) => Date.parse(`2026-10-15T${clock}:00Z`);
const rowOf = (sessionId: string, extra: Record<string, unknown> = {}) => ({ sessionId, activeSessionId: `a-${sessionId}`, lifecycle: "live", activity: "idle",
  lastActivityAt: new Date(at("00:30")).toISOString(), workerPid: 11, ...extra });

test("an orphan with the SEO env counts against the SEO tree: a real detached process the helper finds under no worker, and the watch line adds it to VP of SEO", async () => {
  const job = `01a1ffff-0000-7000-8000-${String(process.pid).padStart(12, "0")}`;
  const state = join(homedir(), ".prime", "agent", "session-artifacts", SEO, "sub-test", "session-artifacts", job, "harness");
  const shell = spawn("/bin/sh", ["-c", `"$0" -e "setTimeout(() => {}, 6000)" & exit 0`, process.execPath], { env: { ...process.env, RLM_HARNESS_STATE_DIR: state }, stdio: "ignore" });
  await new Promise(resolve => shell.once("exit", resolve));
  const measured = await readFootprints([process.pid]);
  const orphan = measured.orphans!.find(entry => entry.session === job);
  assert.ok(orphan, JSON.stringify(measured.orphans));
  assert.equal(orphan.root, SEO);
  assert.equal(orphan.command, `${process.execPath} -e setTimeout(() => {}, 6000)`);
  assert.ok(orphan.started! > Date.now() / 1000 - 60);
  assert.ok(measured.cpu_s < 1, `the helper costs ${measured.cpu_s} s of CPU`);
  const strays = await leftoverSource.strays([job]);
  assert.deepEqual(strays.map(stray => stray.pid), [orphan.pid], "the delete notice's reader finds it by its session");
  const footprints: Footprints = { ...seoFootprints(20), orphans: [{ ...orphan, bytes: 12 * GB }] };
  const line = watchLine({ now: at("00:45"), rows: [rowOf(SEO, { sessionName: "VP of SEO" }), rowOf("other", { sessionName: "ops guy" })], footprints, queue: null,
    chats: new Set([SEO]), title: () => null, cpuMs: 0 });
  assert.deepEqual(line.trees, [{ root: SEO, tree: "VP of SEO", gb: 13, biggest: { pid: orphan.pid, gb: 12, started: orphan.started, command: orphan.command } }],
    "the deleted job's session is no row, so its env root names the tree");
});

test("a shared service is in no tree: a PM2 God Daemon with the SEO env and the app under it are no orphans, while a dev server the session nohup'd itself still counts", async () => {
  const job = `01a1fffe-0000-7000-8000-${String(process.pid).padStart(12, "0")}`;
  const state = join(homedir(), ".prime", "agent", "session-artifacts", SEO, "sub-test", "session-artifacts", job, "harness");
  const daemon = "process.title = 'PM2 v7.0.3: God Daemon (/tmp/tree-guard-pm2)'; require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6001)'], { stdio: 'ignore' }); setTimeout(() => {}, 6000)";
  const shell = spawn("/bin/sh", ["-c", `"$0" -e "${daemon}" & "$0" -e "setTimeout(() => {}, 6002)" & exit 0`, process.execPath],
    { env: { ...process.env, RLM_HARNESS_STATE_DIR: state }, stdio: "ignore" });
  await new Promise(resolve => shell.once("exit", resolve));
  await new Promise(resolve => setTimeout(resolve, 300));
  const measured = await readFootprints([process.pid]);
  assert.deepEqual(measured.orphans!.filter(entry => entry.session === job).map(entry => entry.command), [`${process.execPath} -e setTimeout(() => {}, 6002)`],
    "the PM2 daemon and its app count toward no tree");
  assert.deepEqual((await leftoverSource.strays([job])).map(stray => stray.command), [`${process.execPath} -e setTimeout(() => {}, 6002)`]);
});
