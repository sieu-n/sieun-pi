import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { OWNER_UI } from "../src/checkin-settings.ts";
import { JOB_CLEANUP_EVERY_MS } from "../src/chat-checkin.ts";
import { InterruptedRuns } from "../src/chat-resume.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { InterruptedReport, InterruptedRun } from "../src/shared/interrupted.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

/**
 * Crawler VP 10-15: alert follow through stopped mid-tool at 13:29Z, and at 13:48Z a token hook failure and a worker stop ended about 20 more
 * jobs, some of them two levels under the chat (tunnel-budget, curl-multi-gate). The server only woke a direct job on a token or connection
 * error, and the resume script, run by hand, counted no job whose chat had taken a message since. Nothing restarted them, so every step they
 * owned sat on its wait and stalled_steps read 1 for two check-ins in a row. The server now sends each interrupted job of its chats
 * "continue" itself.
 */
const at = "2026-10-15T13:48:27Z";
const job = (id: string, reason: InterruptedRun["reason"], head: string): InterruptedRun =>
  ({ id: id.slice(-12), name: id, reason, session_id: id, error: "x", errored_at: at, head: head.slice(-12), head_session_id: head });

test("resumeJobs messages each interrupted job itself, reopens a dead worker's head, and leaves hung runs alone", async () => {
  const planned: InterruptedReport = { paused: [job("j-alert", "cut_off", "chat1"), job("j-curl", "error", "chat1"), job("j-hung", "hung", "chat1"),
    job("j-dead", "worker_failed", "chat2"), job("chat1", "cut_off", "chat1"), job("j-other", "error", "owner-terminal")], heads: [], checked_at: "now" };
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return planned; });
  const reopened: string[] = [];
  const owned = new Set(["chat1", "chat2"]);
  await runs.resumeJobs(run => run.session_id !== "chat1" && owned.has(run.head_session_id ?? ""), async id => { reopened.push(id); });
  assert.deepEqual(reopened, ["chat2"]);
  assert.deepEqual(calls, [["--dry-run", "--direct"], ["--direct", "--only", "j-alert,j-curl,j-dead"]]);
});

test("resumeJobs runs nothing more when no job of a chat is interrupted", async () => {
  const calls: string[][] = [];
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return { paused: [job("j-other", "error", "elsewhere")], heads: [], checked_at: "now" }; });
  assert.equal(await runs.resumeJobs(run => run.head_session_id === "chat1", async () => {}), null);
  assert.deepEqual(calls, [["--dry-run", "--direct"]]);
});

test("the server resumes the interrupted jobs of its active chats and their root jobs once per job sweep", async () => {
  const dir = await mkdtemp(join(tmpdir(), "interrupted-jobs-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  await index.add("c2");
  const start = Date.parse("2026-10-15T13:50:00Z");
  let now = start;
  const root: ChatAgent = { key: "thread:r1", sessionId: "r1", name: "ops land follow through", job: "session:r1", sender: "ops land follow through", link: "root",
    state: "idle", steps: [], lastActivityAt: at };
  const rows = (): SessionRow[] => [row("c1", at, { chat: true, agents: [root] }), row("c2", at, { chat: true, agents: [] })];
  const asked: InterruptedRun[][] = [];
  const paused = [job("j-alert", "cut_off", "c1"), job("j-nested", "error", "c1"), job("r1", "worker_stopped", "r1"), job("c1", "cut_off", "c1"),
    job("j-paused-chat", "cut_off", "c2"), job("j-terminal", "error", "t1")];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, rows), interrupted: async isJob => { asked.push(paused.filter(isJob)); return null; } }, () => {});
  await chats.adopt();
  await chats.setCheckIn("c2", { pause: "forever" }, OWNER_UI);
  const step = async (ms: number) => { now += ms; await chats.tick(); await chats.settled(); };
  await step(0);
  assert.deepEqual(asked.map(found => found.map(run => run.session_id)), [["j-alert", "j-nested", "r1"]],
    "jobs of c1 at any depth and its root job; never a chat, a job of a chat the owner paused, or a run outside the chats");
  await step(JOB_CLEANUP_EVERY_MS - 1);
  assert.equal(asked.length, 1, "once per job sweep");
  await step(1);
  assert.equal(asked.length, 2);
  chats.close();
});
