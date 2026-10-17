import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { JOB_CLEANUP_EVERY_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { ARTIFACTS, deletedFolders, endLeftovers, KILL_AFTER_MS, type LeftoverSource, leftoverSource } from "../src/job-leftovers.ts";
import type { ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const SEO = "01a11a24-a46e-77ff-adf7-671d01d462e2";
const SEO_JOB = "01a13a00-0000-7000-8000-5e0da7a00001";
const STARTED = 1792024560;
const session = (n: number) => `01a1fffd-0000-7000-8000-${String(process.pid * 10 + n).padStart(12, "0")}`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts `script` under node, detached from this process the way a nohup'd job command is, with a session's RLM_HARNESS_STATE_DIR; returns its pid. */
async function detached(root: string, id: string, script: string): Promise<number> {
  const state = join(ARTIFACTS, root, "session-artifacts", id, "harness");
  const shell = spawn("/bin/sh", ["-c", `"$0" -e "${script}" & echo $!`, process.execPath], { env: { ...process.env, RLM_HARNESS_STATE_DIR: state }, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  shell.stdout.on("data", chunk => { out += chunk; });
  await new Promise(resolve => shell.once("exit", resolve));
  return Number(out.trim());
}

test("a gone job's detached processes and its subagent's are stopped, one that ignores SIGTERM by SIGKILL after 10 s, its Aside tabs closed, and another session's process stays", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-leftovers-"));
  const [job, child, other] = [session(1), session(2), session(3)];
  await writeFile(join(dir, `${job}.jsonl`), "");
  await mkdir(join(dir, "sub-child"));
  await writeFile(join(dir, "sub-child", `${child}.jsonl`), "");
  await writeFile(join(dir, "aside-browser-tabs.json"), JSON.stringify({ owner: dir, tabs: { T1: "https://example.com" } }));
  await writeFile(join(dir, "sub-child", "aside-browser-tabs.json"), JSON.stringify({ owner: join(dir, "sub-child"), tabs: { T2: "about:blank" } }));
  const runner = await detached(SEO, job, "setTimeout(() => {}, 60000)");
  const stubborn = await detached(SEO, child, "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)");
  const kept = await detached(SEO, other, "setTimeout(() => {}, 60000)");
  await new Promise(resolve => setTimeout(resolve, 300));
  const closed: string[][] = [];
  const real: LeftoverSource = { ...leftoverSource, closeTabs: async ids => { closed.push([...ids]); return ids.length; } };
  try {
    const left = await endLeftovers(real, dir);
    assert.deepEqual(left.stopped.map(entry => entry.pid).sort(), [runner, stubborn].sort());
    assert.deepEqual(closed, [["T1", "T2"]]);
    assert.equal(left.tabs, 2);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(alive(runner), false, "SIGTERM ends the runner");
    assert.equal(alive(stubborn), true, "the one that ignores SIGTERM still runs before the SIGKILL");
    await new Promise(resolve => setTimeout(resolve, KILL_AFTER_MS + 2000));
    assert.equal(alive(stubborn), false, "SIGKILL after 10 s");
    assert.equal(alive(kept), true, "a process of a session outside the gone job stays");
  } finally {
    for (const pid of [runner, stubborn, kept]) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
});

function chatsWith(dir: string, calls: string[], asked: string[][], summary: (id: string) => Promise<{ lifecycle: string } | undefined>, now: number) {
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const leftovers = async (folder: string, id?: string) => {
    asked.push([folder, id ?? ""]);
    return { stopped: [{ pid: 77400, bytes: 0.02 * GB, started: STARTED, command: "python3 runner.py" }, { pid: 77405, bytes: 27 * GB, started: STARTED, command: "python3 old_analysis.py --all" }], tabs: 2 };
  };
  const lines: string[] = [];
  const chats = new Chats(index, threads, summary as never, "b1", loadRecord(join(dir, "extension-loads.json")), { ...source(dir, {}, () => now), leftovers }, line => lines.push(line));
  return { chats, threads, index, lines };
}

test("the cleanup's delete of a finished job stops what it left, logs it and sends the chat no notice", async () => {
  const NOW = Date.parse("2026-10-15T00:45:00Z");
  const dir = await mkdtemp(join(tmpdir(), "job-leftovers-delete-"));
  const calls: string[] = [];
  const asked: string[][] = [];
  const { chats, threads, index, lines } = chatsWith(dir, calls, asked, async () => ({ lifecycle: "live" }), NOW);
  const done: ChildAgent = { id: "sub-1", label: "seo data memory fix", sessionName: "seo data memory fix", sessionId: SEO_JOB, status: "done", repliedSinceTask: true, lastActivityAt: NOW - MIN };
  threads.transcripts.set(SEO, [{ role: "custom", customType: "agent_message", content: "[agent-message from child:seo data memory fix]\nDone, runner started.", display: true,
    timestamp: NOW - MIN } as ThreadMessage]);
  await index.add(SEO);
  await chats.adopt();
  threads.fire().live(SEO, [{ ...done, status: "running", activity: { kind: "executing", toolName: "ipython" } }]);
  threads.fire().children(SEO, [done]);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [`delete ${SEO} sub-1`]);
  assert.deepEqual(asked, [[join(ARTIFACTS, SEO, "sub-1"), SEO_JOB]], "once, for the job's folder and session, after the delete");
  assert.equal(calls.find(call => call.startsWith(`notice ${SEO}`)), undefined);
  assert.ok(lines.some(line => line.includes("stopped 77400, 77405, closed 2 Aside tabs")), lines.join("\n"));
  chats.close();
});

test("a job the chat deleted itself (rlm-subagent.json says deleted) has its detached process stopped and its tab closed by the sweep, and a live job keeps its own", { timeout: 60_000 }, async () => {
  const chatDir = await mkdtemp(join(tmpdir(), "job-leftovers-sweep-"));
  const [gone, live] = [session(4), session(5)];
  for (const [folder, id, status] of [["sub-gone", gone, "deleted"], ["sub-live", live, "running"]] as const) {
    await mkdir(join(chatDir, folder));
    await writeFile(join(chatDir, folder, `${id}.jsonl`), "");
    await writeFile(join(chatDir, folder, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId: folder, status }));
    await writeFile(join(chatDir, folder, "aside-browser-tabs.json"), JSON.stringify({ owner: folder, tabs: { [`T-${folder}`]: "http://127.0.0.1:8767/" } }));
  }
  const server = await detached(SEO, gone, "setTimeout(() => {}, 60000)");
  const kept = await detached(SEO, live, "setTimeout(() => {}, 60000)");
  await new Promise(resolve => setTimeout(resolve, 300));
  const closed: string[][] = [];
  const real: LeftoverSource = { ...leftoverSource, closeTabs: async ids => { closed.push([...ids]); return ids.length; } };
  try {
    assert.deepEqual(await deletedFolders(chatDir), [join(chatDir, "sub-gone")]);
    const left = await endLeftovers(real, await deletedFolders(chatDir));
    assert.deepEqual(left.stopped.map(entry => entry.pid), [server]);
    assert.deepEqual(closed, [["T-sub-gone"]]);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(alive(server), false);
    assert.equal(alive(kept), true, "the live job's process stays");
    assert.deepEqual(JSON.parse(await readFile(join(chatDir, "sub-gone", "aside-browser-tabs.json"), "utf8")).tabs, {}, "the closed tabs leave the record");
    const again = await endLeftovers(real, await deletedFolders(chatDir));
    assert.deepEqual([again.stopped.length, closed.length], [0, 1], "the next sweep finds nothing and opens no Aside call");
  } finally {
    for (const pid of [server, kept]) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
});

test("the service sweeps each chat for deleted jobs' leftovers once per cleanup interval and logs what it stopped", async () => {
  let now = Date.parse("2026-10-16T08:45:00Z");
  const dir = await mkdtemp(join(tmpdir(), "job-leftovers-tick-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const swept: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(SEO);
  const deletedLeftovers = async (chat: string) => {
    swept.push(chat);
    return swept.length === 1 ? { stopped: [{ pid: 3013, bytes: 0.02 * GB, started: STARTED, command: "python3 -m http.server 8767" }], tabs: 1 } : { stopped: [], tabs: 0 };
  };
  const chats = new Chats(index, threads, (async () => ({ lifecycle: "live" })) as never, "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now), deletedLeftovers }, line => lines.push(line));
  await chats.adopt();
  await chats.tick(); await chats.settled();
  await chats.tick(); await chats.settled();
  assert.deepEqual(swept, [SEO], "once per interval");
  assert.ok(lines.includes(`chat ${SEO.slice(0, 8)}: deleted jobs ended; stopped 3013, closed 1 Aside tabs`), lines.join("\n"));
  now += JOB_CLEANUP_EVERY_MS;
  await chats.tick(); await chats.settled();
  assert.deepEqual(swept, [SEO, SEO]);
  assert.equal(lines.filter(line => line.includes("deleted jobs ended")).length, 1, "a sweep that stops nothing logs nothing");
  assert.equal(calls.filter(call => call.startsWith("notice")).length, 0, "the chat gets no notice");
  chats.close();
});
