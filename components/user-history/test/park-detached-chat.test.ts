// Guards clean-room w81 run3 on us-metal02, 10-23: the job "test file count" (sub-d1d34737) reported at 08:47:05Z with p2 waiting on it, the
// idle unload stopped its session at 08:49Z, and its chat detached at 09:24Z. From then on the chat's children came from the daemon's rows,
// whose saved subagent rows carry no repliedSinceTask, so the waiting-job cleanup never read the job as reported and never parked it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

// Guards clean-room w81 run4 on 10-26: "test file count" reported at 04:28Z, the idle unload stopped its session at 04:30Z, and the service
// restarted at 04:40Z and 05:04Z while its chat sat detached. A new service has no earlier record of the reply, the daemon's saved row has no
// repliedSinceTask, so the reply is read from the job's own session file.
test("after a service restart with the chat detached, a reported job is parked from its own session file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "park-restart-"));
  try {
    const chat = "01a17670-5734-7128-8240-87429d77098b";
    const childDir = join(dir, "session-artifacts", chat, "sub-1a0965af");
    const jobFile = join(childDir, "01a17671-73ae-77d7-b5b4-bdf779dd0f42.jsonl");
    const now = Date.parse("2026-10-26T05:40:00Z");
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "rlm-subagent.json"), JSON.stringify({ prompt: "Count the test files.", createdAt: now - 3_600_000, sessionFile: jobFile,
      model: { provider: "openai-codex", modelId: "gpt-6-astra" } }));
    const from = { sessionId: chat, sessionName: "test file counts" };
    const lines = (reply: boolean) => [
      { type: "session", id: "01a17671-73ae-77d7-b5b4-bdf779dd0f42", timestamp: "2026-10-26T04:21:49Z", rlmDepth: 1 },
      { type: "model_change", provider: "openai-codex", modelId: "gpt-6-astra", timestamp: "2026-10-26T04:21:49Z" },
      { type: "thinking_level_change", thinkingLevel: "medium", timestamp: "2026-10-26T04:21:49Z" },
      { type: "custom_message", customType: "agent_message", content: "[task from parent] Count the test files.", timestamp: "2026-10-26T04:21:49Z",
        details: { id: "spawn:sub-1a0965af", message: "Count the test files.", from, fromRelationship: "parent" } },
      ...reply ? [{ type: "message", timestamp: "2026-10-26T04:27:59Z", message: { role: "toolResult", content: [{ type: "text", text: "ok" }],
        details: { sentAgentMessages: [{ id: "agentmsg_5eb6", message: "486 test files.", deliveryStatus: "delivered", receiverRole: "parent", target: from }] } } }] : [],
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    const park = async (reply: boolean) => {
      await writeFile(jobFile, lines(reply));
      const threads = Object.assign(fakeThreads([]), { isLive: () => false });
      const index = new IdIndex(join(dir, `chats-${reply}.json`), "Chat index");
      await index.add(chat);
      const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Count test files", status: "doing", children: [
        { id: "p2", text: "Record both counts", status: "doing", job: "test file count", sessionId: "01a17671-73ae-77d7-b5b4-bdf779dd0f42",
          waitFor: "The release owner messages that the next sieun-pi chat release reached this box.", children: [] }] }] };
      const started: { name: string; model?: string }[] = [];
      const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", `${chat}.jsonl`) }), "b1",
        loadRecord(join(dir, `loads-${reply}.json`)), {
        ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
        resumes: { store: jobResumes(join(dir, `job-resumes-${reply}`)), applyBoard: async () => {},
          restart: async (_chat, name, _brief, model) => { started.push({ name, ...model ? { model: `${model.provider}/${model.modelId} ${model.thinkingLevel}` } : {} }); return { id: "s-fresh", name }; } } },
        () => {});
      await chats.adopt();
      // The saved chat's first page holds the job's report, and the daemon's saved row of the job has no repliedSinceTask.
      threads.transcripts.set(chat, [{ role: "custom", customType: "agent_message", display: true, timestamp: Date.parse("2026-10-26T04:27:59Z"),
        content: "[agent-message from child:test file count]\n486 test files." } as ThreadMessage]);
      await chats.roster(new Map([[chat, [{ id: "sub-1a0965af", label: "test file count", sessionName: "test file count",
        sessionId: "01a17671-73ae-77d7-b5b4-bdf779dd0f42", status: "done", lastActivityAt: Date.parse("2026-10-26T04:30:11Z") } satisfies ChildAgent]]]));
      await chats.tick();
      await chats.settled();
      chats.close();
      return started;
    };
    assert.deepEqual(await park(true), [{ name: resumeJobName("test file count", now), model: "openai-codex/gpt-6-astra medium" }],
      "the reply in the job's file makes it reported, and the fresh job keeps its model and thinking");
    assert.deepEqual((await park(false)).length, 1, "a job whose file shows no reply since its task ended silently, and waitingJobs parks that too");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Guards clean-room w81 run4 on 10-26: from 05:47Z to 07:59Z each sweep of the dormant chat 01a17670 saved "test file count" again and then
// met "The chat is dormant" at the delete. The park now saves nothing while the chat is dormant and finishes at its next wake.
test("a waiting job of a dormant chat is saved and parked only once the chat wakes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "park-dormant-"));
  try {
    let now = Date.parse("2026-10-23T08:47:05Z");
    let dormant = true;
    const threads = Object.assign(fakeThreads([]), { isLive: () => false, isDormant: () => dormant });
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    await mkdir(join(dir, "session-artifacts", "c1", "sub-d1"), { recursive: true });
    await writeFile(join(dir, "session-artifacts", "c1", "sub-d1", "rlm-subagent.json"), JSON.stringify({ prompt: "Count the test files.", createdAt: now - 3_600_000 }));
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
      { id: "p2", text: "Record both counts", status: "doing", job: "test file count", waitFor: "The release owner's message", children: [] }] };
    const started: string[] = [];
    const lines: string[] = [];
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", "c1.jsonl") }), "b1", loadRecord(join(dir, "loads.json")), {
      ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
      resumes: { store: jobResumes(join(dir, "job-resumes")), restart: async (_chat, name) => { started.push(name); return { id: "s-fresh", name }; }, applyBoard: async () => {} } },
      line => lines.push(line));
    await chats.adopt();
    threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now,
      content: "[agent-message from child:test file count]\n415 test files." } as ThreadMessage]);
    await chats.roster(new Map([["c1", [{ id: "sub-d1", label: "test file count", sessionName: "test file count", sessionId: "s-job", status: "done",
      repliedSinceTask: true, lastActivityAt: now } satisfies ChildAgent]]]));
    for (const minutes of [70, 80]) {
      now = Date.parse("2026-10-23T08:47:05Z") + minutes * 60_000;
      await chats.tick();
      await chats.settled();
    }
    assert.deepEqual(await readdir(join(dir, "job-resumes")).catch(() => []), [], "nothing is saved while the chat is dormant");
    assert.equal(lines.filter(line => line.includes("is parked at the chat's next wake")).length, 1, lines.join("\n"));
    dormant = false;
    now += 11 * 60_000;
    await chats.tick();
    await chats.settled();
    chats.close();
    assert.deepEqual(started, [resumeJobName("test file count", now)], lines.join("\n"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
