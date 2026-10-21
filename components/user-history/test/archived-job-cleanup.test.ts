// 10-19 us-metal02: the owner archived chat-057a (01a14210) at 05:31:26Z while its jobs went on working, and the sweep of deleted jobs read
// only the chats in the live set, so the tree, the systemd-run rig and the detached process its deleted fixture job owned stayed until a copy
// of the job was moved under a live chat (~/work/evidence-retention/e2e/NOTE.md). A deleted job now releases what it owns whether its chat is
// live or archived, and the sweep never opens the archived chat.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts `command` detached under the user's init with `env`, as a job's nohup'd or setsid'd helper would leave it, and returns its pid. */
function detached(command: string, cwd: string, env: Record<string, string> = {}): number {
  return Number(execFileSync("setsid", ["sh", "-c", `${command} >/dev/null 2>&1 & echo $!`], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).trim());
}

test("a deleted job releases what it owns under a live chat and under an archived one; an active job, an unknown chat, a held path and a path outside the roots stay", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "archived-job-cleanup-"));
  const pids: number[] = [];
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "systemctl-calls");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> ${calls}\ncase "$*" in\n  *show*) printf 'ActiveState=active\\nTransient=yes\\n' ;;\nesac\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  const { ARTIFACTS, deletedFolders, endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const { Chats } = await import("../src/chats.ts");
  const { IdIndex } = await import("../src/id-index.ts");
  const { loadRecord } = await import("../src/chat-brief.ts");
  const { JOB_CLEANUP_EVERY_MS } = await import("../src/chat-checkin.ts");
  const { fakeThreads, source } = await import("./chats-helpers.ts");

  const live = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
  const archived = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
  const unknown = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
  // The stray helper scans every process on the box, so each run's sessions get ids of their own: at 17:3xZ on 10-19 under a load of 280 one
  // run's sweep found another run's stray by the shared session id and stopped it, and the other run logged "stopped no process".
  const run = randomBytes(4).toString("hex");
  const sessionId = (n: number) => `01a153f4-0000-7000-8000-${run}000${n}`;
  const scratch = join(home, "scratch");
  const write = (file: string, text = "x") => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); return file; };
  /** A job folder the daemon wrote: its record with `status`, its transcript, and its ownership record. */
  const job = (chat: string, sub: string, status: string, session: string, owned: { paths: string[]; units: string[] }) => {
    const dir = join(ARTIFACTS, chat, sub);
    write(join(dir, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId: sub, status }));
    write(join(dir, `${session}.jsonl`), JSON.stringify({ type: "message", text: `used ${join(scratch, "shared", "helper.mjs")}` }) + "\n");
    write(join(dir, "owned.json"), JSON.stringify(owned));
    return dir;
  };
  const tree = (name: string) => { write(join(scratch, name, "tree", "note.txt")); return join(scratch, name, "tree"); };

  // Prime makes a job's folder at its spawn, before the job makes anything, and a job's end deletes only a recorded path born after it.
  for (const [chat, sub] of [[live, "sub-l1"], [archived, "sub-a1"], [archived, "sub-a2"], [archived, "sub-a3"], [unknown, "sub-u1"]]) mkdirSync(join(ARTIFACTS, chat!, sub!), { recursive: true });
  await pause(20);
  const liveTree = tree("live-job");
  job(live, "sub-l1", "deleted", sessionId(1), { paths: [liveTree], units: ["live-rig.service"] });
  const archivedTree = tree("archived-job");
  const archivedSession = sessionId(2);
  const archivedDir = job(archived, "sub-a1", "deleted", archivedSession, { paths: [archivedTree], units: ["archived-rig.service"] });
  const stray = detached("exec sleep 600", home, { RLM_HARNESS_STATE_DIR: join(archivedDir, archivedSession, "harness") });
  const activeTree = tree("active-job");
  job(archived, "sub-a2", "completed", sessionId(3), { paths: [activeTree], units: ["active-rig.service"] });
  const busyTree = tree("busy-job");
  const sharedHelper = write(join(scratch, "shared", "helper.mjs"));
  const report = write(join(home, "src", "archived-job", "REPORT.md"));
  job(archived, "sub-a3", "deleted", sessionId(4), { paths: [busyTree, join(scratch, "shared"), join(home, "src", "archived-job")], units: [] });
  const busy = detached("exec sleep 600", busyTree);
  const reader = detached(`exec tail -f ${sharedHelper}`, home);
  const unknownTree = tree("unknown-job");
  job(unknown, "sub-u1", "deleted", sessionId(5), { paths: [unknownTree], units: ["unknown-rig.service"] });
  pids.push(stray, busy, reader);
  await pause(50);

  const dir = join(home, "data");
  mkdirSync(dir);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(live);
  await index.add(archived);
  const threadCalls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(threadCalls);
  let now = Date.parse("2026-10-19T12:43:20Z");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now), archived: new IdIndex(join(dir, "archived-chats.json"), "Archived chat index"),
    deletedLeftovers: async chat => endLeftovers(leftoverSource, await deletedFolders(join(ARTIFACTS, chat))),
  }, line => lines.push(line));
  await chats.adopt();
  await chats.archive(archived, "owner");
  assert.ok(!(await chats.ids()).has(archived), "the owner's archive takes the chat out of the live set");
  threadCalls.length = 0;

  now += JOB_CLEANUP_EVERY_MS;
  await chats.tick();
  await chats.settled();

  assert.ok(!existsSync(liveTree), "a deleted job of a live chat releases its tree");
  assert.ok(!existsSync(archivedTree), "a deleted job of an archived chat releases its tree");
  for (const kept of [activeTree, busyTree, sharedHelper, report, unknownTree, archivedDir]) assert.ok(existsSync(kept), kept);
  const stops = readFileSync(calls, "utf8").split("\n").filter(line => line.startsWith("--user stop")).sort();
  assert.deepEqual(stops, ["--user stop -- archived-rig.service", "--user stop -- live-rig.service"]);
  await pause(200);
  assert.ok(!alive(stray), "the archived chat's deleted job's detached process is stopped");
  assert.ok(alive(busy) && alive(reader), "no process that uses a recorded path is signalled");
  assert.deepEqual(threadCalls.filter(call => call.includes(archived)), [], "the sweep never opens, resumes, pins or unarchives the archived chat");
  assert.ok(!(await chats.ids()).has(archived), "the archived chat stays out of the live set");
  assert.ok(lines.some(line => line.startsWith(`chat ${archived.slice(0, 8)} (archived): deleted jobs ended; stopped ${stray}`)), lines.join("\n"));
  chats.close();
});
