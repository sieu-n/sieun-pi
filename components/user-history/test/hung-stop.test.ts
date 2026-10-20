// At 20:05Z and 20:36Z on 10-19 d7 read 3 and 2 hung tool calls (ci-plan-replay 178 min in a `node --test` whose tests had passed,
// share-cascade 228 min in a curl_cffi probe at 0 cores), and a message to a session in such a call waits until the call returns, so d7's
// "tell the chat to interrupt it" could not reach it. The watch now stops a hung call's bash() commands so the await returns (src/hung-stop.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { type CallMark, CallWatch, type HungCall } from "../src/hung-calls.ts";
import { type CallHandle, CallStopper, type StopDeps } from "../src/hung-stop.ts";
import { type Footprints, readCallHandles, sample } from "../src/mac-usable-watch.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-19T21:01:30Z");
const SHARE = "01a1551d-0043-738a-8c55-0a533dcd27f9";
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const SINCE = Date.parse("2026-10-19T17:13:10Z");
const PROBE = "/home/sieun/Documents/Github/auto-sns-agent/apps/crawler-v3/.venv/bin/python /home/sieun/scratch/us08-our-load-cause/share-cascade/probe_h2b.py";
const call = (fields: Partial<HungCall> = {}): HungCall => ({ session: SHARE, name: "share-cascade", root: CRAWLER, tree: "Crawler VP", silentMin: 228, workCores: 0,
  kernelCores: 0, command: PROBE, why: "no progress", since: SINCE, ...fields });

function fakeDeps(found: CallHandle[]) {
  const kills: [number, string][] = [], told: [string, string, string][] = [], asked: { kernel: number; since: number }[][] = [];
  const deps: StopDeps = { handles: async wanted => { asked.push([...wanted]); return found; }, kill: (pid, signal) => { kills.push([pid, signal]); },
    tell: async (session, root, text) => { told.push([session, root, text]); }, log: () => {} };
  return { deps, kills, told, asked };
}

test("share-cascade's hung probe gets SIGTERM on its shell and child, the session is told why, and a call still hung a minute later gets SIGKILL", async () => {
  const fake = fakeDeps([{ kernel: 3141759, pid: 3851767, started: Math.floor(SINCE / 1000) + 24, command: PROBE, pids: [3851767, 3851865] }]);
  const stopper = new CallStopper(fake.deps);
  const first = await stopper.stop([call()], [{ pid: 3141759, session: SHARE }]);
  assert.deepEqual(fake.asked, [[{ kernel: 3141759, since: 0 }]]);
  assert.deepEqual(fake.kills, [[3851767, "SIGTERM"], [3851865, "SIGTERM"]]);
  assert.deepEqual(first.left, []);
  assert.deepEqual(first.stopped.map(entry => [entry.session, entry.handles.map(handle => handle.pid)]), [[SHARE, [3851767]]]);
  assert.equal(fake.told.length, 1);
  assert.equal(fake.told[0]![0], SHARE);
  assert.equal(fake.told[0]![1], CRAWLER);
  assert.match(fake.told[0]![2], /^\[hung call\] Your tool call ran 228 min with no output .* SIGTERM .*pid 3851767: \/home\/sieun\/Documents.*exit -15/);
  const second = await stopper.stop([call({ silentMin: 229 })], [{ pid: 3141759, session: SHARE }]);
  assert.deepEqual(fake.kills.slice(2), [[3851767, "SIGKILL"], [3851865, "SIGKILL"]]);
  assert.deepEqual(second.stopped, []);
  assert.deepEqual(second.left.map(entry => entry.session), [SHARE], "a TERM that did not free the call leaves it hung");
  assert.equal(fake.told.length, 1, "the session is told once");
});

test("a burning kernel and a call with no kernel read are left hung and never signaled", async () => {
  const fake = fakeDeps([]);
  const stopper = new CallStopper(fake.deps);
  const burning = call({ session: "burning", why: "kernel burning", kernelCores: 0.99 });
  const unread = call({ session: "unread" });
  const result = await stopper.stop([burning, unread], [{ pid: 76, session: "burning" }]);
  assert.deepEqual(fake.kills, []);
  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.left.map(entry => entry.session), ["burning", "unread"]);
  assert.deepEqual(fake.asked, []);
});

test("li-http-reads's `await hp` on a handle started 42 s before the call went silent is stopped, and a call with a handle of its own spares older ones", async () => {
  const LI = "01a155fe-56af-7770-b9f0-83aef1660e03", liSince = Date.parse("2026-10-19T21:46:54Z");
  const fake = fakeDeps([{ kernel: 2438074, pid: 108719, started: Math.floor(liSince / 1000) - 42, command: "cd apps/llm-wiki/content/sessions/2026/10/18/1116-linkedin-api-fixes/data/http && time python3 g07_stage.py prod list", pids: [108719, 108725] },
    { kernel: 77, pid: 78, started: Math.floor(SINCE / 1000) - 600, command: "sleep 9000", pids: [78] },
    { kernel: 77, pid: 90, started: Math.floor(SINCE / 1000) + 5, command: "ssh mac true", pids: [90, 91] }]);
  const stopper = new CallStopper(fake.deps);
  const result = await stopper.stop([call({ session: LI, name: "li-http-reads", silentMin: 87, since: liSince }), call({ session: "own" })],
    [{ pid: 2438074, session: LI }, { pid: 77, session: "own" }]);
  assert.deepEqual(fake.asked, [[{ kernel: 2438074, since: 0 }, { kernel: 77, since: 0 }]]);
  assert.deepEqual(fake.kills, [[108719, "SIGTERM"], [108725, "SIGTERM"], [90, "SIGTERM"], [91, "SIGTERM"]]);
  assert.deepEqual(result.stopped.map(entry => entry.session), [LI, "own"]);
  assert.deepEqual(result.left, []);
});

test("the watch line leaves a stopped call out of hung, d7's hung_calls reads 0 and flags the stop with its chat", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hung-stop-"));
  try {
    const row = { sessionId: SHARE, activeSessionId: SHARE, sessionName: "share-cascade", parentSessionId: CRAWLER, lifecycle: "live", activity: "working",
      isSessionActive: true, isStreaming: true, isRunningTools: true, workerPid: 1565325, lastActivityAt: new Date(SINCE).toISOString() };
    const crawler = { sessionId: CRAWLER, activeSessionId: CRAWLER, sessionName: "Crawler VP", lifecycle: "live", activity: "working", isRunningTools: false,
      hasRunningRlmChildren: true, workerPid: 1565325, lastActivityAt: new Date(NOW - MIN).toISOString() };
    const calls = new CallWatch();
    const seeds: { calls: CallMark[] }[] = [];
    for (let at = NOW - 25 * MIN; at < NOW; at += MIN) seeds.push({ calls: [{ session: SHARE, since: SINCE, at, kernelS: 12, workS: 3, command: PROBE }] });
    calls.seed(seeds);
    const fake = fakeDeps([{ kernel: 3141759, pid: 3851767, started: Math.floor(SINCE / 1000) + 24, command: PROBE, pids: [3851767, 3851865] }]);
    const footprints: Footprints = { workers: { 1565325: { pids: 3, bytes: 1 } }, swap_used_bytes: 0, pressure_level: null, cpu_s: 0,
      kernels: [{ pid: 3141759, root: CRAWLER, session: SHARE, pids: 3, bytes: 1, own: 1, biggest: null, cpu_s: 12, work_cpu_s: 3 }] };
    const line = await sample({ dataDir, rows: () => [crawler, row], chats: async () => new Set([CRAWLER]), title: id => id === CRAWLER ? "Crawler VP" : null,
      queue: async () => { throw new Error("no queue"); }, log: () => {}, now: () => NOW, footprints: async () => footprints, feed: async () => null,
      memory: async () => ({ groups: null }), services: async () => [], calls, stop: new CallStopper(fake.deps) });
    assert.ok(line);
    assert.equal(line.hung, undefined);
    assert.deepEqual(line.stopped?.map(entry => [entry.name, entry.tree, entry.silentMin]), [["share-cascade", "Crawler VP", 228]]);
    assert.deepEqual([...calls.hung()], [], "Settings > Hosts reads the stopped call as working");
    assert.deepEqual(fake.kills.map(([pid, signal]) => `${pid} ${signal}`), ["3851767 SIGTERM", "3851865 SIGTERM"]);
    const output = measure({ now: NOW + 30_000, watch: [line], log: { holds: [] }, chats: [] });
    assert.equal(output.metrics.hung_calls, 0);
    const flagged = (output.flagged ?? []).filter(slice => slice.kind === "hung_call_stopped");
    assert.deepEqual(flagged.map(slice => [slice.chat, slice.item]), [[CRAWLER, SHARE]]);
    assert.match(flagged[0]!.excerpt, /^Crawler VP: share-cascade \(01a1551d-.*\) ran one tool call 228 min with no output at 0 cores, so the watch stopped its bash\(\) command at 21:01Z/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
test("a real rlm.bash await on a silent command returns -15 once the stopper signals the handle the helper finds", { skip: process.platform !== "linux" || !existsSync(KERNEL_PY) }, async () => {
  // The trailing "rlm.repl" argument makes the footprint helper read this python as a kernel; the await is Prime's own rlm.bash.
  const script = "import asyncio\nfrom rlm.bash import bash\nasync def main():\n    return (await bash('sleep 600')).exit_code\nprint(asyncio.run(main()), flush=True)";
  const since = Math.floor(Date.now() / 1000);
  const kernel = spawn(KERNEL_PY, ["-c", script, "rlm.repl"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  kernel.stdout.on("data", chunk => { out += String(chunk); });
  const exited = new Promise<number | null>(resolve => kernel.on("exit", code => resolve(code)));
  try {
    let found: CallHandle[] = [];
    while (!found.length && kernel.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 100));
      found = await readCallHandles([{ kernel: kernel.pid!, since }]);
    }
    assert.equal(found.length, 1);
    assert.match(found[0]!.command, /^sleep 600$/);
    const stopper = new CallStopper({ handles: readCallHandles, kill: (pid, signal) => { process.kill(pid, signal); }, tell: async () => {}, log: () => {} });
    const result = await stopper.stop([call({ session: "real", since: since * 1000 })], [{ pid: kernel.pid!, session: "real" }]);
    assert.equal(result.stopped.length, 1);
    assert.equal(await exited, 0);
    assert.equal(out.trim(), "-15");
    assert.deepEqual(await readCallHandles([{ kernel: kernel.pid!, since }]), [], "no handle is left");
  } finally {
    kernel.kill("SIGKILL");
  }
});
