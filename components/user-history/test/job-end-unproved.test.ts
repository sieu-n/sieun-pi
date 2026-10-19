// 10-19 us-metal02: the job end deleted ~/scratch/retire-2547, release-fold and saved-session-archive at 01:27Z and 01:53Z while chat 01a14210
// still read their evidence, and at 02:06Z the end of job metal agent verification deleted the shared ~/scratch/release-applied and SIGTERMed
// four release processes of other jobs (3085180, 3469500, 3567932, 3850115) that ran the release helper from it under systemd-run. Both came from
// paths a transcript or a process's arguments only named. A job's end now deletes and signals nothing on such a mention, and still stops the
// processes its own kernels left detached.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts `command` detached under the user's init, as systemd-run or a nohup'd job would leave it, and returns its pid. */
function detached(command: string, env: Record<string, string>, cwd: string): number {
  return Number(execFileSync("setsid", ["sh", "-c", `${command} >/dev/null 2>&1 & echo $!`], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).trim());
}

test("a deleted job's end keeps every path it only named and a shared helper's release processes, and stops its own detached process",
  { skip: !existsSync("/proc/self/cwd") }, async t => {
    const home = mkdtempSync(join(tmpdir(), "job-end-unproved-"));
    const pids: number[] = [];
    t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
    process.env.HOME = home;
    const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
    const scratch = join(home, "scratch");
    const artifacts = join(home, ".prime", "agent", "session-artifacts");
    const chat = join(artifacts, "01a14210-4e7d-72c3-aa67-e3d476f4e728");
    const job = join(chat, "sub-7e8789ef");
    const session = "01a150f1-c33c-753f-9526-0cdb90358874";
    mkdirSync(job, { recursive: true });
    const start = Date.now();
    await pause(30);
    const write = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "x"); return path; };
    const named = [
      write(join(scratch, "retire-2547", "EVIDENCE.md")),
      write(join(scratch, "release-applied", "frozen", "release-chat.mjs")),
      write(join(scratch, "release-fold", "tree", "pnpm-workspace.yaml")),
      write(join(home, "tmp", "p8iso-rig", "home", "daemon.log")),
      write(join(artifacts, "grafana-c", "c8tree", "pnpm-workspace.yaml")),
    ];
    const release = detached(`exec tail -f ${join(scratch, "release-applied", "frozen", "release-chat.mjs")}`, {}, join(scratch, "release-applied"));
    const rig = detached("exec sleep 301", { HOME: join(home, "tmp", "p8iso-rig", "home") }, join(home, "tmp", "p8iso-rig"));
    const stray = detached("exec sleep 302", { RLM_HARNESS_STATE_DIR: join(chat, "session-artifacts", session, "harness") }, home);
    pids.push(release, rig, stray);
    await pause(30);
    writeFileSync(join(job, `${session}.jsonl`), JSON.stringify({ type: "session", version: 3, id: "x", timestamp: new Date(start).toISOString() }) + "\n" +
      JSON.stringify({ type: "message", text: `published ~/scratch/release-applied/frozen/release-chat.mjs; wrote ~/scratch/retire-2547/EVIDENCE.md; ` +
        `git archive into ~/scratch/release-fold/tree; rig at ${join(home, "tmp", "p8iso-rig")}; tests in ~/.prime/agent/session-artifacts/grafana-c/c8tree` }) + "\n");
    writeFileSync(join(job, "rlm-subagent.json"), JSON.stringify({ status: "deleted" }));
    const left = await endLeftovers(leftoverSource, [job]);
    await pause(200);
    for (const path of named) assert.ok(existsSync(path), path);
    assert.ok(alive(release), "the release that runs the shared helper keeps running");
    assert.ok(alive(rig), "a process that only holds a named path keeps running");
    assert.deepEqual(left.stopped.map(entry => entry.pid), [stray]);
    assert.ok(!alive(stray), "the job's own detached process stops");
  });
