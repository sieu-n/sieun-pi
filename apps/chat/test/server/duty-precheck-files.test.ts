/**
 * Each precheck launch keeps its own state copy, so a cleanup of one run that lands late leaves the STATE_FILE of the next run. Until 11-23
 * every run of a duty shared `<duty>.state.next.json`, and fixture.test's second duty run read "error" once during a release at box load 240.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-precheck-files.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { clearPrecheck, launchPrecheck, measure, runsScript, waitPrecheck, type PrecheckLaunch } from "../../server/duty-run.ts";
import type { Duty } from "../../web/src/lib/api/shared/chat-duties.ts";

delete process.env.INVOCATION_ID;

test("a late cleanup of one run's precheck leaves the next run's STATE_FILE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-precheck-files-"));
  try {
    // The precheck waits 300 ms before it reads its STATE_FILE, the gap in which the last run's cleanup lands.
    const script = `const fs = require("fs"); setTimeout(() => { const seen = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); ` +
      `fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ runs: (seen.runs ?? 0) + 1 })); ` +
      `fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { runs: (seen.runs ?? 0) + 1 } })); }, 300);`;
    const duty = { id: "d1", name: "Files", schedule: { kind: "every", minutes: 60 }, precheck: { command: ["node", "-e", script], cwd: dir, timeoutMs: 30_000 } } as unknown as Duty;
    const first = await launchPrecheck(duty, dir, join(dir, "d1-261123-050000.json"), [], "run", "files-1");
    assert.deepEqual((await waitPrecheck(duty, first)).metrics, { runs: 1 });
    const second = await launchPrecheck(duty, dir, join(dir, "d1-261123-050001.json"), [], "run", "files-2");
    await clearPrecheck(first);
    assert.deepEqual((await waitPrecheck(duty, second)).metrics, { runs: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrapper pid whose cmdline reads empty, as inside its execve, still runs, so the wait reads the exit file it writes later", async () => {
  assert.equal(runsScript(null, "/d/d1.sh"), false, "no such process");
  assert.equal(runsScript("/bin/sh\0/d/d1.sh\0", "/d/d1.sh"), true);
  assert.equal(runsScript("node\0server.js\0", "/d/d1.sh"), false, "a reused pid");
  assert.equal(runsScript("", "/d/d1.sh"), true, "inside its execve, or ended and not reaped yet");
  // A process with an empty cmdline that stays: a child perl never reaps. Until 11-23 the first poll read it as ended, and the run recorded
  // "it ended with no exit code" while the wrapper went on (duty-queued.test.ts in a parallel run, 3 of 32 files). The holder is no dash
  // script: dash catches SIGCHLD and reaps a child that exits before its `exec sleep` with wait4(-1, WNOHANG), so under load the pid went
  // away after the loop below saw it empty, and this test failed in a parallel run at load 150.
  const dir = mkdtempSync(join(tmpdir(), "duty-precheck-exec-"));
  const holder = spawn("perl", ["-e", "$| = 1; my $pid = fork() // die; if (!$pid) { exit 0 } print \"$pid\\n\"; sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const pid = Number(await new Promise<string>(done => holder.stdout!.once("data", chunk => done(String(chunk)))));
    while (readFileSync(`/proc/${pid}/cmdline`, "utf8") !== "") await new Promise(done => setTimeout(done, 10));
    const duty = { id: "d1", schedule: { kind: "every", minutes: 60 }, precheck: { command: ["true"], cwd: dir, timeoutMs: 30_000 } } as unknown as Duty;
    const at = (name: string) => join(dir, name);
    const launch: PrecheckLaunch = { mode: "run", output: at("d1.json"), exit: at("d1.exit"), stderr: at("d1.stderr.log"), nextState: at("d1.next-state.json"),
      script: at("d1.sh"), env: at("d1.env"), startedAt: Date.now(), hardStopMs: 30_000, runner: { kind: "pid", pid } };
    setTimeout(() => {
      writeFileSync(launch.output, JSON.stringify({ metrics: { up: 1 } }));
      writeFileSync(launch.exit, "0\n");
    }, 300);
    assert.deepEqual((await waitPrecheck(duty, launch)).metrics, { up: 1 });
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a precheck that crashes with a stack shows its error line, and the run's detail is its whole stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-precheck-crash-"));
  try {
    const crash = join(dir, "crash.mjs");
    writeFileSync(crash, "function deep() { throw new TypeError('the board answered 502'); }\nfunction mid() { deep(); }\nmid();\n");
    const duty = { id: "d1", name: "Crash", ownerWords: "w", goal: "g", onMiss: "m", metrics: [{ key: "up", label: "Up", op: ">=", target: 1, headline: true }],
      schedule: { kind: "every", minutes: 60 }, precheck: { command: ["node", crash], cwd: dir, timeoutMs: 30_000 } } as unknown as Duty;
    const { record } = await measure({ duty, chat: { id: "ag_crash", name: "Crash" }, dir, trigger: "owner", previous: [], board: null, liveJob: () => false, boardApi: "http://x" });
    assert.equal(record.verdict, "error");
    assert.match(record.error!, /^exit 1: TypeError: the board answered 502 \(all of stderr: /);
    assert.doesNotMatch(record.error!, /Node\.js v\d/);
    const stderr = readFileSync(record.detail!, "utf8");
    assert.match(stderr, /at deep \(/);
    assert.match(stderr, /Node\.js v\d/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
