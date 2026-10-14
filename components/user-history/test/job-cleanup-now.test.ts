import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { deletedJobRecord } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, PlanItem, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * Mac stays usable 10-14 18:19 KST: 162 Python kernels held 11.8 GB, 15 of them in jobs that had reported and were done, and the cleanup only
 * deleted a finished job once it had been quiet 60 min (none since 07:12Z). A job is now deleted when its turn ends with its report in the
 * chat, and a job the board or its own words still owe work is kept.
 */
const NOW = Date.parse("2026-10-14T09:19:43Z");
const job = (id: string, name: string, extra: Partial<ChildAgent> = {}): ChildAgent =>
  ({ id, label: name, sessionName: name, status: "done", repliedSinceTask: true, lastActivityAt: NOW - 60_000, ...extra });
const report = (name: string, body: string, at = NOW - 60_000): ThreadMessage =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\n${body}`, display: true, timestamp: at }) as ThreadMessage;
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan });

async function chat(plan: PlanItem[], messages: ThreadMessage[]) {
  const dir = await mkdtemp(join(tmpdir(), "job-cleanup-now-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set("c1", messages);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board(plan) }, () => NOW), deletedJobs: deletedJobRecord(join(dir, "deleted-jobs.json")) }, line => lines.push(line));
  await chats.adopt();
  return { chats, threads, calls, lines, deletes: () => calls.filter(call => call.startsWith("delete")) };
}

test("a finished job is deleted as soon as its turn ends with its report in the chat, with no wait for the sweep", async () => {
  const done = job("sub-1", "media serving build");
  const { chats, threads, deletes, lines } = await chat([], [report("media serving build", "Landed a1b2c3d, verify green.")]);
  threads.fire().live("c1", [{ ...done, status: "running", activity: { kind: "executing", toolName: "ipython" } }]);
  await chats.settled();
  assert.deepEqual(deletes(), [], "a working job is not touched");
  threads.fire().children("c1", [done]);
  await chats.settled();
  assert.deepEqual(deletes(), ["delete c1 sub-1"], "deleted at its turn end, 1 min quiet");
  assert.deepEqual(lines.filter(line => line.includes("finished job")), ["chat c1: deleted finished job media serving build (reported, quiet 1 min, no open step)"]);
  chats.close();
});

test("a job whose report has not reached the chat yet is kept until it does", async () => {
  const { chats, threads, deletes } = await chat([], []);
  threads.fire().live("c1", [{ ...job("sub-1", "probe family fix"), status: "running", activity: { kind: "writing" } }]);
  threads.fire().children("c1", [job("sub-1", "probe family fix")]);
  await chats.settled();
  assert.deepEqual(deletes(), [], "the chat's transcript holds no message from it");
  threads.transcripts.set("c1", [report("probe family fix", "Fixed.")]);
  threads.fire().idle("c1");
  await chats.settled();
  assert.deepEqual(deletes(), ["delete c1 sub-1"], "the chat went idle with the report in");
  chats.close();
});

test("a job an open step names, or whose last reply holds parked work, is kept while a plain report next to it is deleted at once", async () => {
  const step: PlanItem = { id: "p7", text: "Build: the lease gauge", status: "doing", job: "fair crawl queue", children: [] };
  const jobs = [job("sub-1", "fair crawl queue"), job("sub-2", "collab lane self balance"), job("sub-3", "watchlist all green")];
  const { chats, threads, deletes } = await chat([step], [report("fair crawl queue", "Pushed r3."), report("collab lane self balance", "I'm still waiting for the r14 sha."),
    report("watchlist all green", "It's already landed.")]);
  threads.fire().live("c1", jobs.map(child => ({ ...child, status: "running" as const })));
  threads.fire().children("c1", jobs);
  await chats.settled();
  assert.deepEqual(deletes(), ["delete c1 sub-3"]);
  chats.close();
});

test("a mid-turn job is never deleted: one the hub shows working is not asked for, and one the daemon answers running is kept and not recorded", async () => {
  const { chats, threads, calls, deletes, lines } = await chat([], [report("ci self healing", "Done."), report("wiki secrets guard", "Done.")]);
  const working = job("sub-1", "ci self healing", { status: "running", activity: { kind: "executing", toolName: "ipython" } });
  const racing = job("sub-2", "wiki secrets guard");
  threads.fire().live("c1", [working, { ...racing, status: "running" }]);
  threads.deleteAnswer = "running";
  threads.fire().children("c1", [working, racing]);
  await chats.settled();
  assert.deepEqual(deletes(), ["delete c1 sub-2"], "only the job the hub shows done is asked for");
  assert.ok(lines.includes("chat c1: kept job wiki secrets guard: the daemon shows it running"), lines.join("\n"));
  assert.ok(!lines.some(line => line.includes("deleted finished job")), lines.join("\n"));
  threads.deleteAnswer = "deleted";
  threads.fire().idle("c1");
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-2", "delete c1 sub-2"], "a job the daemon kept is asked again at the next look");
  chats.close();
});

test("a delete the daemon does not answer in time is tried again at the next sweep, not only after a service start", async () => {
  // Crawler VP 10-14 12:3xZ: census write cuts and live route parity fixes timed out after 30 s and stayed alive with their state saved.
  const { chats, threads, calls, lines } = await chat([], [report("census write cuts", "Done.")]);
  const done = job("sub-1", "census write cuts");
  threads.fire().live("c1", [{ ...done, status: "running" }]);
  const answer = threads.deleteSubagent.bind(threads);
  let fail = true;
  threads.deleteSubagent = async (id: string, childId: string) => {
    if (!fail) return answer(id, childId);
    calls.push(`delete ${id} ${childId}`);
    throw new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "delete_rlm_subagent"');
  };
  threads.fire().children("c1", [done]);
  await chats.settled();
  assert.ok(lines.some(line => line.startsWith("chat c1: delete job census write cuts: Timed out") && line.endsWith("tried again at the next sweep")), lines.join("\n"));
  fail = false;
  threads.fire().idle("c1");
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), ["delete c1 sub-1", "delete c1 sub-1"]);
  assert.ok(lines.includes("chat c1: deleted finished job census write cuts (reported, quiet 1 min, no open step)"), lines.join("\n"));
  chats.close();
});

test("frontend bro 10-14: a job whose attached record froze at an error is deleted once the daemon's row shows it done and replied later", async () => {
  // The chat's record of email list funnel columns: status error, no reply, last activity 02:19:44Z. The daemon's row: done, replied, 06:14:17Z.
  const frozen = job("sub-6fd4ad58", "email list funnel columns", { status: "error", repliedSinceTask: false, lastActivityAt: Date.parse("2026-10-14T02:19:44Z") });
  const row = job("sub-6fd4ad58", "email list funnel columns", { status: "done", repliedSinceTask: true, lastActivityAt: Date.parse("2026-10-14T06:14:17Z") });
  const { chats, threads, deletes } = await chat([], [report("email list funnel columns", "Both fixes are done.", Date.parse("2026-10-14T06:14:12Z"))]);
  (threads as unknown as { isLive(id: string): boolean }).isLive = () => true;
  threads.fire().live("c1", [frozen]);
  await chats.settled();
  await (chats as unknown as { roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(new Map([["c1", [row]]]));
  threads.fire().idle("c1");
  await chats.settled();
  assert.deepEqual(deletes(), ["delete c1 sub-6fd4ad58"]);
  chats.close();
});
