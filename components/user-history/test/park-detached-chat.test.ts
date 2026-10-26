// Guards clean-room w81 run3 on us-metal02, 10-23: the job "test file count" (sub-d1d34737) reported at 08:47:05Z with p2 waiting on it, the
// idle unload stopped its session at 08:49Z, and its chat detached at 09:24Z. From then on the chat's children came from the daemon's rows,
// whose saved subagent rows carry no repliedSinceTask, so the waiting-job cleanup never read the job as reported and never parked it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes, resumeJobName } from "../src/job-resume.ts";
import type { ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

test("a reported job whose session the idle unload stopped is parked after its chat detaches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "park-detached-"));
  try {
    let now = Date.parse("2026-10-23T08:47:05Z");
    let live = true;
    const threads = Object.assign(fakeThreads([]), { isLive: () => live });
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    await mkdir(join(dir, "session-artifacts", "c1", "sub-d1d34737"), { recursive: true });
    await writeFile(join(dir, "session-artifacts", "c1", "sub-d1d34737", "rlm-subagent.json"), JSON.stringify({ prompt: "Count the test files.", createdAt: now - 3_600_000 }));
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Count test files", status: "doing", children: [
      { id: "p2", text: "Record both counts", status: "doing", job: "test file count", waitFor: "The release owner's message", children: [] }] }] };
    const started: string[] = [];
    const lines: string[] = [];
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", "c1.jsonl") }), "b1", loadRecord(join(dir, "loads.json")), {
      ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
      resumes: { store: jobResumes(join(dir, "job-resumes")), restart: async (_chat, name) => { started.push(name); return { id: "s-fresh", name }; }, applyBoard: async () => {} } },
      line => lines.push(line));
    await chats.adopt();
    const held: ChildAgent = { id: "sub-d1d34737", label: "test file count", sessionName: "test file count", sessionId: "01a167cf", status: "done", repliedSinceTask: true, lastActivityAt: now };
    threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now,
      content: "[agent-message from child:test file count]\n415 test files." } as ThreadMessage]);
    await chats.roster(new Map([["c1", [held]]]));
    threads.fire().live("c1", [held]);
    await chats.settled();
    // The idle unload stops the job's session and the chat detaches: the daemon's saved row has no repliedSinceTask.
    live = false;
    const { repliedSinceTask: _, ...saved } = { ...held, lastActivityAt: Date.parse("2026-10-23T08:49:17Z") };
    await chats.roster(new Map([["c1", [saved]]]));
    now = Date.parse("2026-10-23T09:56:00Z");
    await chats.tick();
    await chats.settled();
    chats.close();
    // The name carries the box's local HH:MM (`resumeJobName`), so it is built with the same formatter and clock, whatever TZ the box runs in.
    assert.deepEqual(started, [resumeJobName("test file count", now)], lines.join("\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
