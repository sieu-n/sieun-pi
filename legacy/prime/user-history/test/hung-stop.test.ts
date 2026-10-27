// At 20:05Z and 20:36Z on 10-19 d7 read 3 and 2 hung tool calls (ci-plan-replay 178 min in a `node --test` whose tests had passed,
// share-cascade 228 min in a curl_cffi probe at 0 cores), and a message to a session in such a call waits until the call returns, so d7's
// "tell the chat to interrupt it" could not reach it. The watch now stops a hung call's bash() commands so the await returns (src/hung-stop.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { type CallMark, CallWatch, type HungCall } from "../src/hung-calls.ts";
import { type CallHandle, CallStopper, interruptCell, pidAlive, type StopDeps } from "../src/hung-stop.ts";
import { type Footprints, readCallHandles, sample } from "../src/mac-usable-watch.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-19T21:01:30Z");
const SHARE = "01a1551d-0043-738a-8c55-0a533dcd27f9";
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
const SINCE = Date.parse("2026-10-19T17:13:10Z");
const PROBE = "/home/sieun/Documents/Github/auto-sns-agent/apps/crawler-v3/.venv/bin/python /home/sieun/scratch/us08-our-load-cause/share-cascade/probe_h2b.py";
const call = (fields: Partial<HungCall> = {}): HungCall => ({ session: SHARE, name: "share-cascade", root: CRAWLER, tree: "Crawler VP", silentMin: 228, workCores: 0,
  kernelCores: 0, command: PROBE, why: "no progress", since: SINCE, ...fields });

function fakeDeps(found: CallHandle[], alive: (pid: number) => boolean = () => true, handled: (kernel: number) => boolean = () => true) {
  const kills: [number, string][] = [], told: [string, string, string][] = [], asked: { kernel: number; since: number }[][] = [], interrupts: number[] = [];
  const deps: StopDeps = { handles: async wanted => { asked.push([...wanted]); return found; }, kill: (pid, signal) => { kills.push([pid, signal]); }, alive,
    interrupt: kernel => { if (!handled(kernel)) return false; interrupts.push(kernel); return true; },
    tell: async (session, root, text) => { told.push([session, root, text]); }, log: () => {} };
  return { deps, kills, told, asked, interrupts };
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
  assert.deepEqual(second.left.map(entry => entry.session), [SHARE], "a TERM that did not free the call leaves it hung, and the minute of its SIGKILL interrupts no cell");
  assert.deepEqual(fake.interrupts, []);
  assert.equal(fake.told.length, 1, "the session is told once");
});

test("hdx-metaads-commit's call, which SIGTERM left waiting at 22:47Z and which was not judged hung again for 30 min, gets SIGKILL on what still runs a minute later", async () => {
  const HDX = "01a155a9-1a0e-710e-a134-cd82a3372982", hdxSince = 1792446397262;
  const probe = "cd apps/crawler-v3 && PYTHONPATH=. uv run python /home/sieun/work/alert-meta-writer/revoke_probe.py";
  const fake = fakeDeps([{ kernel: 500, pid: 501, started: Math.floor(hdxSince / 1000) + 3, command: probe, pids: [501, 502, 503] }], pid => pid !== 503);
  const stopper = new CallStopper(fake.deps);
  const hdx = call({ session: HDX, name: "hdx-metaads-commit", silentMin: 61, since: hdxSince });
  await stopper.stop([hdx], [{ pid: 500, session: HDX }]);
  const next = await stopper.stop([], [{ pid: 500, session: HDX }]);
  assert.deepEqual(next, { stopped: [], left: [] });
  assert.deepEqual(fake.kills, [[501, "SIGTERM"], [502, "SIGTERM"], [503, "SIGTERM"], [501, "SIGKILL"], [502, "SIGKILL"]]);
  const later = await stopper.stop([call({ ...hdx, silentMin: 91 })], [{ pid: 500, session: HDX }]);
  assert.deepEqual(later.stopped.map(entry => [entry.silentMin, entry.cell]), [[91, 500]], "a call still hung after both signals gets its cell interrupted");
  assert.equal(fake.kills.length, 5, "and its handles get no more signals");
});

// At 05:51Z on 10-20 d7 read rb-api-portal 96 min into one ipython call, a backtracking re.findall with its kernel at 0.99 cores and no command
// to stop, and the watch left it hung.
const RBAP = "01a15748-186e-72b7-a8e6-4c119db52892", RBAP_ROOT = "01a1180e-6567-747f-bf44-452520ebdd1b", RBAP_SINCE = Date.parse("2026-10-20T04:15:34Z");
const rbap = (fields: Partial<HungCall> = {}): HungCall => call({ session: RBAP, name: "rb-api-portal", root: RBAP_ROOT, tree: "CI and RepoOps", silentMin: 96,
  workCores: 0, kernelCores: 0.99, command: null, why: "kernel burning", since: RBAP_SINCE, ...fields });

test("rb-api-portal's burning kernel gets its cell interrupted once and the session is told, and a kernel with no handler or no read is left hung", async () => {
  const fake = fakeDeps([], () => true, kernel => kernel !== 77);
  const stopper = new CallStopper(fake.deps);
  const noHandler = call({ session: "old-kernel", why: "kernel burning", kernelCores: 0.99 });
  const unread = call({ session: "unread" });
  const first = await stopper.stop([rbap(), noHandler, unread], [{ pid: 3141, session: RBAP }, { pid: 77, session: "old-kernel" }]);
  assert.deepEqual(fake.kills, [], "no process is killed");
  assert.deepEqual(fake.asked, [], "a burning kernel's handles are not read");
  assert.deepEqual(fake.interrupts, [3141]);
  assert.deepEqual(first.stopped.map(entry => [entry.session, entry.cell, entry.handles]), [[RBAP, 3141, []]]);
  assert.deepEqual(first.left.map(entry => entry.session), ["old-kernel", "unread"]);
  assert.equal(fake.told.length, 1);
  assert.deepEqual(fake.told[0]!.slice(0, 2), [RBAP, RBAP_ROOT]);
  assert.match(fake.told[0]![2], /^\[hung call\] Your tool call ran 96 min with no output while your kernel used 0\.99 cores .*SIGUSR2 to kernel pid 3141.*KeyboardInterrupt\. Your kernel and its variables were kept/);
  const second = await stopper.stop([rbap({ silentMin: 97 })], [{ pid: 3141, session: RBAP }]);
  assert.deepEqual(fake.interrupts, [3141], "a cell is interrupted once");
  assert.deepEqual(second.left.map(entry => entry.silentMin), [97], "a call still hung after its interrupt counts as hung");
});

test("a call with no handle left to stop, or still hung after SIGTERM and SIGKILL, gets its cell interrupted", async () => {
  const fake = fakeDeps([{ kernel: 500, pid: 501, started: Math.floor(SINCE / 1000) + 3, command: "uv run python probe.py", pids: [501] }], () => false);
  const stopper = new CallStopper(fake.deps);
  const awaiting = call({ session: "awaiting" });
  await stopper.stop([call(), awaiting], [{ pid: 500, session: SHARE }, { pid: 600, session: "awaiting" }]);
  assert.deepEqual(fake.kills, [[501, "SIGTERM"]]);
  assert.deepEqual(fake.interrupts, [600], "a no-progress call with no handle, such as an await on a socket, gets its cell interrupted");
  await stopper.stop([], [{ pid: 500, session: SHARE }]);
  const later = await stopper.stop([call({ silentMin: 262 })], [{ pid: 500, session: SHARE }]);
  assert.deepEqual(fake.interrupts, [600, 500]);
  assert.deepEqual(later.stopped.map(entry => [entry.session, entry.cell]), [[SHARE, 500]]);
  assert.equal(fake.kills.length, 1, "no handle gets another signal");
});

test("interruptCell sends SIGUSR2 only to a kernel whose /proc status shows it caught", () => {
  const sent: [number, string][] = [];
  const kill = process.kill;
  process.kill = ((pid: number, signal: string) => { sent.push([pid, signal]); return true; }) as typeof process.kill;
  try {
    assert.equal(interruptCell(41, () => "Name:\tpython\nSigCgt:\t0000000100000802\n"), true);
    assert.equal(interruptCell(42, () => "Name:\tpython\nSigCgt:\t0000000100000002\n"), false, "a kernel booted before the handler");
    assert.equal(interruptCell(43, () => { throw new Error("ENOENT"); }), false, "a gone kernel or a box with no /proc");
  } finally {
    process.kill = kill;
  }
  assert.deepEqual(sent, [[41, "SIGUSR2"]]);
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


test("d7 reads hung_calls 0 when the watch interrupted rb-api-portal's cell and flags the interrupt with its chat", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hung-cell-"));
  try {
    const at = Date.parse("2026-10-20T05:51:30Z");
    const row = { sessionId: RBAP, activeSessionId: RBAP, sessionName: "rb-api-portal", parentSessionId: RBAP_ROOT, lifecycle: "live", activity: "working",
      isSessionActive: true, isStreaming: true, isRunningTools: true, workerPid: 2000, lastActivityAt: new Date(RBAP_SINCE).toISOString() };
    const root = { sessionId: RBAP_ROOT, activeSessionId: RBAP_ROOT, sessionName: "CI and RepoOps", lifecycle: "live", activity: "working", isRunningTools: false,
      hasRunningRlmChildren: true, workerPid: 2000, lastActivityAt: new Date(at - MIN).toISOString() };
    const calls = new CallWatch();
    const seeds: { calls: CallMark[] }[] = [];
    for (let minute = at - 25 * MIN; minute < at; minute += MIN) seeds.push({ calls: [{ session: RBAP, since: RBAP_SINCE, at: minute, kernelS: 5000 + 0.99 * (minute - at) / 1000, workS: 2, command: null }] });
    calls.seed(seeds);
    const fake = fakeDeps([]);
    const footprints: Footprints = { workers: { 2000: { pids: 2, bytes: 1 } }, swap_used_bytes: 0, pressure_level: null, cpu_s: 0,
      kernels: [{ pid: 3141, root: RBAP_ROOT, session: RBAP, pids: 1, bytes: 1, own: 1, biggest: null, cpu_s: 5000, work_cpu_s: 2 }] };
    const line = await sample({ dataDir, rows: () => [root, row], chats: async () => new Set([RBAP_ROOT]), title: id => id === RBAP_ROOT ? "CI and RepoOps" : null,
      queue: async () => { throw new Error("no queue"); }, log: () => {}, now: () => at, footprints: async () => footprints, feed: async () => null,
      memory: async () => ({ groups: null }), services: async () => [], calls, stop: new CallStopper(fake.deps) });
    assert.ok(line);
    assert.equal(line.hung, undefined);
    assert.deepEqual(fake.interrupts, [3141]);
    assert.deepEqual(line.stopped?.map(entry => [entry.name, entry.why, entry.cell]), [["rb-api-portal", "kernel burning", 3141]]);
    const output = measure({ now: at + 30_000, watch: [line], log: { holds: [] }, chats: [] });
    assert.equal(output.metrics.hung_calls, 0);
    const flagged = (output.flagged ?? []).filter(slice => slice.kind === "hung_call_stopped");
    assert.deepEqual(flagged.map(slice => [slice.chat, slice.item]), [[RBAP_ROOT, RBAP]]);
    assert.match(flagged[0]!.excerpt, /^CI and RepoOps: rb-api-portal \(01a15748-.*\) ran one tool call 96 min with no output, its kernel at 0\.99 cores, so the watch interrupted the cell in kernel 3141 at 05:51Z\.$/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const KERNEL_PY = join(homedir(), ".prime/agent/kernel-venv/bin/python");
test("a real rlm.bash await on a silent command returns -15 once the stopper signals the handle the helper finds", { skip: process.platform !== "linux" || !existsSync(KERNEL_PY) }, async () => {
  // The trailing "rlm.repl" argument makes the footprint helper read this python as a kernel; the await is Prime's own rlm.bash. Start times
  // come from the whole-second btime, so the helper can read a process up to a second before it started, and `since` sits 2 s early.
  const script = "import asyncio\nfrom rlm.bash import bash\nasync def main():\n    return (await bash('sleep 600')).exit_code\nprint(asyncio.run(main()), flush=True)";
  const since = Math.floor(Date.now() / 1000) - 2;
  const kernel = spawn(KERNEL_PY, ["-c", script, "rlm.repl"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
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
    const stopper = new CallStopper({ handles: readCallHandles, kill: (pid, signal) => { process.kill(pid, signal); }, interrupt: () => false, alive: pidAlive,
      tell: async () => {}, log: () => {} });
    const result = await stopper.stop([call({ session: "real", since: since * 1000 })], [{ pid: kernel.pid!, session: "real" }]);
    assert.equal(result.stopped.length, 1);
    assert.equal(await exited, 0);
    assert.equal(out.trim(), "-15");
    assert.deepEqual(await readCallHandles([{ kernel: kernel.pid!, since }]), [], "no handle is left");
  } finally {
    for (const handle of await readCallHandles([{ kernel: kernel.pid!, since: 0 }]).catch(() => [])) for (const pid of handle.pids) process.kill(pid, "SIGKILL");
    try { process.kill(-kernel.pid!, "SIGKILL"); } catch { /* gone */ }
  }
});

const BOARD_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../../skills/board/src");
test("a real kernel's backtracking regex cell returns KeyboardInterrupt once the stopper interrupts it, and the kernel serves the next cell", { skip: process.platform !== "linux" || !existsSync(KERNEL_PY) }, async () => {
  // Prime's own kernel with the board skill of this tree pre-imported, as every session's kernel has it; the cell is rb-api-portal's kind of call.
  const kernel = spawn(KERNEL_PY, ["-m", "rlm.repl"], { stdio: ["pipe", "pipe", "inherit"], detached: true, env: { ...process.env, PYTHONPATH: BOARD_SRC } });
  const events: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: kernel.stdout! }).on("line", line => { events.push(JSON.parse(line) as Record<string, unknown>); for (const wake of waiters.splice(0)) wake(); });
  const until = async (match: (event: Record<string, unknown>) => boolean, ms: number): Promise<Record<string, unknown> | undefined> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = events.find(match);
      if (found || Date.now() > end) return found;
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 100); });
    }
  };
  const run = (id: string, code: string) => kernel.stdin!.write(JSON.stringify({ type: "execute", id, code }) + "\n");
  try {
    assert.ok(await until(event => event.event === "ready", 10_000));
    run("boot", "import board");
    assert.equal((await until(event => event.event === "done" && event.id === "boot", 10_000))?.status, "ok");
    run("regex", "import re\nre.findall(r'(a+)+$', 'a' * 60 + 'b')");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(events.some(event => event.id === "regex" && event.event === "done"), false, "the regex runs on");
    const stopper = new CallStopper({ handles: readCallHandles, kill: (pid, signal) => { process.kill(pid, signal); }, interrupt: interruptCell, alive: pidAlive,
      tell: async () => {}, log: () => {} });
    const result = await stopper.stop([rbap({ session: "real" })], [{ pid: kernel.pid!, session: "real" }]);
    assert.deepEqual(result.stopped.map(entry => entry.cell), [kernel.pid]);
    assert.equal((await until(event => event.event === "error" && event.id === "regex", 10_000))?.ename, "KeyboardInterrupt");
    assert.equal((await until(event => event.event === "done" && event.id === "regex", 10_000))?.status, "error");
    run("after", "print('alive', 1 + 1)");
    assert.equal((await until(event => event.event === "done" && event.id === "after", 10_000))?.status, "ok");
    assert.ok(events.some(event => event.id === "after" && event.event === "stdout" && event.text === "alive"), "the kernel kept serving");
  } finally {
    try { process.kill(-kernel.pid!, "SIGKILL"); } catch { /* gone */ }
  }
});
