// Replays us-metal02 10-23 23:06:20Z to 23:30:21Z. Update 793302-1792796780311 (ctl-784514-1792796779) prepared from 23:06:20.311Z, and its
// planned sidecar recorded "crawler prod deploy resumed 13:31" (01a16707-1c9d), the root CI and RepoOps' cleanup had started for p355, as
// streaming with an accepted prompt in flight and shouldResume true. The prepare drained its turn (pi-pool released it after 0.1 s at 23:06:20Z),
// p355 already named crawler metal deploy (01a16a9f), and at 23:06:50.118Z the replaced-root sweep read the root idle and archived it
// (service-archives.json op d0f25f63, replaced_job_end). The update listed it under stoppedBeforeRestore with reason unknown at 23:06:50.435Z
// and never resumed it. Its board.wake for run 40036134910 then reopened it at 23:30:21Z.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { archiveDutyJob } from "../src/chat-duty-job.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { IdleUnloader, type UnloadSource } from "../src/idle-unload.ts";
import { jobResumes, type JobResume } from "../src/job-resume.ts";
import type { PrimeUpdate } from "../src/prime-update.ts";
import type { ChatAgent, ChatBoard, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a1180e-6567-747f-bf44-452520ebdd1b";
const ROOT = "01a16707-1c9d-7255-93e3-3224a40a8395";
const NEXT = "01a16a9f-79ae-7455-990a-bbf82e27e3bf";
const at = "2026-10-23T22:51:09Z";
const update = (phase: string): PrimeUpdate => ({ requestId: "793302-1792796780311", phase, startedAt: "2026-10-23T23:06:20.311Z",
  file: "/home/sieun/.prime/agent/update-restarts/ctl-784514-1792796779.json" });
const agent = (sessionId: string, name: string, steps: string[] = []): ChatAgent =>
  ({ key: `thread:${sessionId}`, sessionId, name, job: `session:${sessionId}`, sender: name, link: "root", state: "idle", steps, lastActivityAt: at });

async function rig(dir: string, state: { update: PrimeUpdate | null; waking: boolean; now: number }) {
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const store = jobResumes(join(dir, "job-resumes"));
  const saved: JobResume = { chat: CHAT, childId: "sub-eb6c4665", job: "crawler prod deploy", steps: ["p355"], event: "p355 waits for the crawler-only sha",
    brief: "b", report: "r", endedAt: Date.parse("2026-10-23T04:31:21Z"), resumed: { id: ROOT, name: "crawler prod deploy resumed 13:31" } };
  await store.save(saved);
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: at, todos: [], plan: [
    { id: "p355", text: "Ship the crawler-only fix for Instagram stories to production", status: "blocked", job: "crawler metal deploy", sessionId: NEXT, children: [] }] };
  const rows = (): SessionRow[] => [row(CHAT, at, { chat: true, agents: [agent(ROOT, "crawler prod deploy resumed 13:31"), agent(NEXT, "crawler metal deploy", ["p355"])] })];
  const threads = fakeThreads([]);
  const lines: string[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, { [CHAT]: board }, () => state.now, rows), resumes: { store, applyBoard: async () => {} },
    waking: async session => state.waking && session === ROOT, updating: async () => state.update }, line => lines.push(line));
  await chats.adopt();
  const sweep = async () => { await chats.tick(); await chats.settled(); };
  return { chats, threads, lines, sweep };
}

test("the replaced-root sweep archives no root while a Prime update prepares or restores, and archives it once the update ends (10-23 23:06:50Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replaced-root-update-"));
  try {
    const state = { update: update("preparing") as PrimeUpdate | null, waking: false, now: Date.parse("2026-10-23T23:06:50.118Z") };
    const { chats, threads, lines, sweep } = await rig(dir, state);
    await sweep();
    assert.deepEqual([...threads.archivedBy], [], "the root the prepare drained is kept while the update prepares");
    assert.ok(lines.includes("chats: Prime update 793302-1792796780311 is preparing; no replaced root is archived until it ends"), lines.join("\n"));
    state.update = update("restoring");
    state.now += 30 * 60_000;
    await sweep();
    assert.deepEqual([...threads.archivedBy], [], "and while it restores");
    state.update = null;
    state.now += 30 * 60_000;
    await sweep();
    chats.close();
    assert.deepEqual([...threads.archivedBy], [[ROOT, "replaced_job_end"]], "once the update ended, the replaced root is archived as before");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the replaced-root sweep keeps a root that waits on a board.wake, since the wake would reopen it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "replaced-root-wake-"));
  try {
    const state = { update: null, waking: true, now: Date.parse("2026-10-23T23:06:50.118Z") };
    const { chats, threads, sweep } = await rig(dir, state);
    await sweep();
    chats.close();
    assert.deepEqual([...threads.archivedBy], [], "the root asleep on its board.wake for run 40036134910 is kept");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the duty archive queue's try fails while a Prime update runs, so the queue tries again after it", async () => {
  const archived: string[] = [];
  let running: PrimeUpdate | null = update("preparing");
  const archive = archiveDutyJob({ archive: async id => { archived.push(id); } }, async () => [row("d1", at)], async () => running);
  await assert.rejects(archive("d1"), /Prime update 793302-1792796780311 is preparing; the archive waits until it ends/);
  assert.deepEqual(archived, []);
  running = null;
  await archive("d1");
  assert.deepEqual(archived, ["d1"]);
});

test("the idle unload stops no session while a Prime update runs", async () => {
  const lines: string[] = [];
  let read = 0;
  const source = { idleMs: () => 15 * 60_000, updating: async () => update("restoring"), log: (line: string) => lines.push(line),
    chats: async () => { read += 1; return new Set<string>(); } } as unknown as UnloadSource;
  const unloader = new IdleUnloader(source);
  await unloader.sweep();
  await unloader.sweep();
  assert.equal(read, 0, "the sweep plans nothing");
  assert.deepEqual(lines, ["idle unload: Prime update 793302-1792796780311 is restoring; no session is stopped until it ends"], "and logs the update once");
});

test("the job cleanup deletes or ends no job while a Prime update runs, and deletes the finished one once it ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-cleanup-update-"));
  try {
    const calls: string[] = [];
    const lines: string[] = [];
    const threads = fakeThreads(calls);
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    let now = 10_000_000;
    let running: PrimeUpdate | null = update("restoring");
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p3", text: "Audit", status: "done", job: "auditor", children: [] }] };
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, { c1: board }, () => now), updating: async () => running }, line => lines.push(line));
    await chats.adopt();
    const old = now - 61 * 60_000;
    threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", content: "[agent-message from child:auditor]\nDone.", display: true, timestamp: old } as ThreadMessage]);
    threads.fire().live("c1", [{ id: "k1", label: "auditor", sessionName: "auditor", status: "done", repliedSinceTask: true, lastActivityAt: old }]);
    await chats.settled();
    const deletes = async () => { calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("delete")); };
    assert.deepEqual(await deletes(), [], "the finished job is kept while the update restores");
    assert.ok(lines.includes("chats: Prime update 793302-1792796780311 is restoring; no job is deleted or ended until it ends"), lines.join("\n"));
    running = null;
    now += 11 * 60_000;
    assert.deepEqual(await deletes(), ["delete c1 k1"], "and deleted at the first cleanup after it");
    chats.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
