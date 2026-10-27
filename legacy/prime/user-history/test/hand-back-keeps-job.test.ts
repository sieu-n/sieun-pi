// Guards clean-room w81 run5 on us-metal02, 10-26: the job "test file count" (sub-868db11d) reported at 08:30:31Z before its chat set p2's
// wait. The sweep at 08:30:43Z handed p2 back to the chat and, in the same sweep, deleted the job ("reported, quiet 0 min, no open step").
// The chat linked p2 to the job again at 08:30:51Z, to a deleted job, so the release message could never reach it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { JOB_CLEANUP_EVERY_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { BoardOp, ChatBoard, ChildAgent, PlanItem, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

test("a job whose step goes back to the chat is kept for the chat's turn, and stays the same session once the chat gives the step back to it with a wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hand-back-keeps-job-"));
  try {
    let now = Date.parse("2026-10-26T08:30:31Z");
    const calls: string[] = [];
    const threads = fakeThreads(calls);
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    await mkdir(join(dir, "session-artifacts", "c1", "sub-868db11d"), { recursive: true });
    await writeFile(join(dir, "session-artifacts", "c1", "sub-868db11d", "rlm-subagent.json"), JSON.stringify({ prompt: "Count the test files.", createdAt: now - 60_000,
      model: { provider: "openai-codex", modelId: "gpt-6-astra" } }));
    let board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
      { id: "p2", text: "Record both counts", status: "doing", job: "test file count", children: [] }] };
    const update = (id: string, change: Partial<PlanItem>) => { board = { ...board, plan: board.plan.map(item => item.id === id ? { ...item, ...change } : item) }; };
    const lines: string[] = [];
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", "c1.jsonl") }), "b1", loadRecord(join(dir, "loads.json")), {
      ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
      resumes: { store: jobResumes(join(dir, "job-resumes")),
        applyBoard: async (_id: string, ops: readonly BoardOp[]) => {
          for (const op of ops) if (op.op === "plan_update") update(op.id, { ...op.job ? { job: op.job } : {}, ...typeof op.note === "string" ? { note: op.note } : {} });
          // The chat's own write of 08:30:43Z lands right after: its new note and the job's session id, and no wait yet.
          update("p2", { text: "Record the change from 491 test files after the release", sessionId: "01a17754", note: "Done when both counts and their difference are recorded here." });
        } } },
      line => lines.push(line));
    await chats.adopt();
    const job: ChildAgent = { id: "sub-868db11d", label: "test file count", sessionName: "test file count", sessionId: "01a17754", status: "done", repliedSinceTask: true, lastActivityAt: now };
    threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now,
      content: "[agent-message from child:test file count]\n491 test files." } as ThreadMessage]);
    await chats.roster(new Map([["c1", [job]]]));
    threads.fire().live("c1", [job]);
    now += 12_000;
    await chats.tick();
    await chats.settled();
    assert.equal(board.plan[0]!.job, "c1", "p2 went back to the chat");
    assert.ok(!calls.some(call => call.startsWith("delete c1")), `the job is kept for the chat's turn:\n${lines.join("\n")}`);
    // The chat's turn: p2 goes back to the job, now with its wait.
    update("p2", { job: "test file count", sessionId: "01a17754", waitFor: "The release owner's message" });
    now += JOB_CLEANUP_EVERY_MS;
    await chats.tick();
    await chats.settled();
    assert.ok(!calls.some(call => call.startsWith("delete c1")), "a step names the job again, so it is kept");
    now = Date.parse("2026-10-26T08:30:31Z") + 6 * 60 * 60_000;
    await chats.tick();
    await chats.settled();
    chats.close();
    assert.ok(!calls.some(call => call.startsWith("delete c1")), `the job still waits as the same session 6 h later:\n${lines.join("\n")}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
