// Guards metal-management 10-18 06:53:57Z: crawler lanes to box sent "Step landed: ..." and ended its turn waiting on its subagents, with
// p11 open; the 06:46Z hand back moved p11 to the chat, the chat rewrote its note, and the cleanup deleted the job and cut two of its subagents.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { BoardOp, ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

test("job cleanup: a reported job whose subagents still work keeps its open step and is not deleted; it goes once its tree is idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-cleanup-live-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = Date.parse("2026-10-18T06:53:57Z");
  let board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
    { id: "p11", text: "Move the census and TikTok Shop crawler lanes to us-metal02", status: "doing", job: "crawler lanes to box", children: [] }] };
  const applied: BoardOp[][] = [];
  const base = source(dir, {}, () => now);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...base, board: async () => board, waking: async () => false, wakes: async () => [],
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async (_id: string, ops: readonly BoardOp[]) => { applied.push([...ops]); } },
  }, line => lines.push(line));
  await chats.adopt();
  const job: ChildAgent = { id: "sub-fbdd234a", label: "crawler lanes to box", sessionName: "crawler lanes to box", sessionId: "s-lanes", status: "done",
    repliedSinceTask: true, lastActivityAt: now - 37_000 };
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 37_000,
    content: "[agent-message from child:crawler lanes to box]\nStep landed: the stopgap has run on us-metal02 since 06:50Z. crawl-verify is measuring now." } as ThreadMessage]);
  const helper = (id: string, name: string, status: ChildAgent["status"]): ChildAgent =>
    ({ id, label: name, sessionName: name, sessionId: "s-" + name, status, repliedSinceTask: status === "done", lastActivityAt: now - 5_000 });
  const tree = (deploy: ChildAgent["status"], verify: ChildAgent["status"]) => chats.roster(new Map([["c1", [job]], ["s-lanes", [
    helper("sub-5c7c8e24", "crawl-net", "done"), helper("sub-f19394ae", "crawl-runtime", "done"),
    helper("sub-93074bc6", "crawl-deploy", deploy), helper("sub-8498c5e1", "crawl-verify", verify)]]]));
  await tree("running", "running");
  threads.fire().live("c1", [job]);
  await chats.settled();
  const sweep = async () => { calls.length = 0; now += 11 * 60_000; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("delete") || call.startsWith("steer")); };

  assert.deepEqual(await sweep(), [], "06:46Z: no hand back and no delete while two subagents work");
  assert.deepEqual(applied, [], "p11 stays the job's");

  board = { ...board, plan: [{ ...board.plan[0]!, job: "c1", note: "Stopgap live since 06:50Z; measurement is running." }] };
  assert.deepEqual(await sweep(), [], "06:53Z: p11 no longer names the job, and its subagents still work");
  assert.ok(lines.includes("chat c1: kept job crawler lanes to box: a session under it waits on a board.wake or a subagent under it works"));

  await tree("done", "done");
  threads.sessionBusy.add("s-crawl-deploy");
  assert.deepEqual(await sweep(), [], "the daemon list is behind, but the daemon shows crawl-deploy in a tool call");
  assert.ok(lines.includes("chat c1: kept job crawler lanes to box: a subagent under it runs a turn, a tool call or a background bash"));

  threads.sessionBusy.clear();
  assert.deepEqual(await sweep(), ["delete c1 sub-fbdd234a"], "once nothing under it works and no open step names it, the job is deleted");
  chats.close();
});

test("job cleanup: a hand back whose steer fails ('Daemon is preparing an update restart') leaves the step on the job; the next one steers before it moves the step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-cleanup-handback-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const order: string[] = [];
  const threads = fakeThreads(calls);
  let restarting = true;
  threads.prompt = async (id: string, input: { message: string; mode: string }) => {
    if (restarting) throw new Error("Daemon is preparing an update restart");
    order.push(`${input.mode} ${id}`);
  };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = Date.parse("2026-10-18T06:46:19Z");
  let board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
    { id: "p11", text: "Move the census and TikTok Shop crawler lanes to us-metal02", status: "doing", job: "crawler lanes to box", note: "WireGuard is up.", children: [] }] };
  const base = source(dir, {}, () => now);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...base, board: async () => board, waking: async () => false, wakes: async () => [],
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async (_id: string, ops: readonly BoardOp[]) => {
      order.push("board");
      board = { ...board, plan: board.plan.map(item => { const op = ops.find(each => each.op === "plan_update" && each.id === item.id); return op && op.op === "plan_update" ? { ...item, ...(op.job ? { job: op.job } : {}), ...(typeof op.note === "string" ? { note: op.note } : {}) } : item; }) };
    } },
  }, line => lines.push(line));
  await chats.adopt();
  const job: ChildAgent = { id: "sub-fbdd234a", label: "crawler lanes to box", sessionName: "crawler lanes to box", sessionId: "s-lanes", status: "done",
    repliedSinceTask: true, lastActivityAt: now - 30_000 };
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 30_000,
    content: "[agent-message from child:crawler lanes to box]\nStep landed: wg-prod moved to 10.250.12.0/30." } as ThreadMessage]);
  await chats.roster(new Map([["c1", [job]]]));
  threads.fire().live("c1", [job]);
  await chats.settled();
  const sweep = async () => { calls.length = 0; now += 11 * 60_000; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("delete")); };

  assert.deepEqual(await sweep(), [], "the job is not deleted while p11 names it");
  assert.deepEqual(order, [], "the steer failed, so the board was not written");
  assert.equal(board.plan[0]!.job, "crawler lanes to box", "p11 stays on the job");
  assert.ok(lines.includes("chat c1: hand back the steps of crawler lanes to box: Daemon is preparing an update restart"));

  restarting = false;
  await sweep();
  assert.deepEqual(order, ["steer c1", "board"], "the chat is told before the step moves");
  assert.equal(board.plan[0]!.job, "c1");
  assert.match(board.plan[0]!.note ?? "", /^Handed back: job crawler lanes to box reported at /);
  chats.close();
});
