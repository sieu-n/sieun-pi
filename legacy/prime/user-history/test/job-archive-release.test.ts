// 10-20 us-metal02: the clean-room cancel of job "user history test run" (run7) stopped and archived it at 11:20:16Z through the owner's Stop
// and Archive routes while its own folder ~/scratch/01a15903-cd56-.../uh-f7f2fd2d held an export, and nothing released it: the archive route
// only archived the session, and only a deleted job's end ran endLeftovers. The chat's "finish the task" reopened the job 34 s later.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function detached(command: string, cwd: string): number {
  return Number(execFileSync("setsid", ["sh", "-c", `${command} >/dev/null 2>&1 & echo $!`], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" }).trim());
}

test("the owner's archive of a job releases its own folder and its recorded paths, and keeps a reopened job's work, a held folder, other chats' jobs and shared evidence", { skip: process.platform !== "linux" }, async t => {
  const home = mkdtempSync(join(tmpdir(), "job-archive-release-"));
  const pids: number[] = [];
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home;
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nprintf 'ActiveState=inactive\\nTransient=yes\\n'\n");
  chmodSync(join(bin, "systemctl"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  const { artifactsRoot, endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const { Chats } = await import("../src/chats.ts");
  const { IdIndex } = await import("../src/id-index.ts");
  const { loadRecord } = await import("../src/chat-brief.ts");
  const { fakeThreads, source } = await import("./chats-helpers.ts");

  const chat = "01a15903-32dc-722e-87d3-55af930292fe";
  const other = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
  const scratch = join(home, "scratch");
  const write = (file: string, text = "x") => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); return file; };
  const files = new Map<string, string>();
  /** A job session folder under `parent` with its transcript, a file in its own scratch folder, and an optional owned.json. */
  const job = (parent: string, sub: string, session: string, owned?: { paths: string[]; units: string[] }) => {
    const dir = join(artifactsRoot(), parent, sub);
    const file = write(join(dir, `${session}.jsonl`), JSON.stringify({ type: "session", id: session }) + "\n");
    write(join(scratch, session, "export", "package.json"));
    if (owned) write(join(dir, "owned.json"), JSON.stringify(owned));
    files.set(session, file);
    return file;
  };
  const cancelled = "01a15903-cd56-7138-b1c6-b06022221d92";
  job(chat, "sub-efba9220", cancelled, { paths: [join(scratch, "uhf7-rig")], units: [] });
  // A job's end deletes only a recorded path born after the job's folder, which Prime makes at the spawn.
  await pause(20);
  const rig = write(join(scratch, "uhf7-rig", "log.txt"));
  const reopened = "01a15903-0000-7000-8000-000000000002";
  job(chat, "sub-reopened", reopened);
  const held = "01a15903-0000-7000-8000-000000000003";
  job(chat, "sub-held", held);
  const foreign = "01a11ba8-0000-7000-8000-000000000004";
  job(other, "sub-foreign", foreign);
  const shared = write(join(scratch, "shared", "helper.mjs"));
  const report = write(join(home, "work", "uh-f7f2fd2d-count", "test.log"));
  const reader = detached(`exec tail -f ${shared}`, home);
  const user = detached("exec sleep 600", join(scratch, held, "export"));
  pids.push(reader, user);
  await pause(50);

  const dir = join(home, "data");
  mkdirSync(dir);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(chat);
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const state = (session: string, status: string) =>
    appendFileSync(files.get(session)!, JSON.stringify({ type: "session_state", timestamp: new Date().toISOString(), state: { status } }) + "\n");
  threads.archive = async (id: string) => { calls.push(`archive ${id}`); state(id, "archived"); if (id === reopened) state(id, "active"); };
  const chats = new Chats(index, threads, async id => { const sessionFile = files.get(id); return sessionFile ? { lifecycle: "live", sessionFile } : id === chat ? { lifecycle: "live" } : undefined; }, "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => Date.now()), leftovers: (folder, session) => endLeftovers(leftoverSource, folder, session),
  }, line => lines.push(line));
  await chats.adopt();

  for (const id of [cancelled, reopened, held, foreign]) await chats.archiveJob(id, "owner");

  assert.deepEqual(calls.filter(call => call.startsWith("archive")), [cancelled, reopened, held, foreign].map(id => `archive ${id}`));
  assert.ok(!existsSync(join(scratch, cancelled)), `the cancelled job's own folder is released\n${lines.join("\n")}`);
  assert.ok(!existsSync(rig), "the path the job's own record names is released");
  assert.ok(existsSync(join(scratch, reopened, "export", "package.json")), "a job reopened after the archive keeps its folder");
  assert.ok(existsSync(join(scratch, held, "export", "package.json")) && alive(user), "a folder a process still uses stays, and the process is not signalled");
  assert.ok(existsSync(join(scratch, foreign, "export", "package.json")), "a job of a chat this service does not hold keeps its folder");
  assert.ok(existsSync(shared) && alive(reader), "a shared helper and its reader stay");
  assert.ok(existsSync(report), "a ~/work report stays");
  chats.close();
});
