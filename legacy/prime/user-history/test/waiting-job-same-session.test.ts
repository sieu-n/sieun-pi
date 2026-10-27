// Guards clean-room w81 on us-metal02, 10-26: chat 01a177e7 ("test file counts 4") spawned "test file count" (sub-3eed36dc) on
// openai-codex/gpt-6-astra at medium thinking and told it to wait, as the same job, for the release owner's message. The job reported at 11:13Z
// with p1 doing and p2 waiting on that message, the idle unload stopped its session at 11:15:49Z, and the chat went dormant. At 12:15:31Z,
// right after the chat woke, the job cleanup deleted the job and started the root "test file count resumed 21:15" (01a17823) in its place,
// so the chat's rlm.list_subagents() came back empty. A waiting job now stays the same session, whatever its quiet time.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { BoardOp, ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const CHAT = "01a177e7-cec2-7794-9271-b2d025b779ba";
const JOB = "sub-3eed36dc";
const SESSION = "01a177e9-0000-7000-8000-000000000000";
const REPORTED = Date.parse("2026-10-26T11:13:24Z");
const WAIT = "The release owner's message that the next sieun-pi chat release is on this box.";

const plan = (): ChatBoard["plan"] => [{ id: "p1", text: "Count test files before and after the next chat release", status: "doing", job: "test file count",
  sessionId: SESSION, children: [{ id: "p2", text: "Record both counts and their difference", status: "todo", job: "test file count", sessionId: SESSION,
    waitFor: WAIT, children: [] }] }];

test("a reported job that waits on a message stays the same session through a dormant chat, its wake and hours of quiet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waiting-job-same-session-"));
  try {
    let now = REPORTED;
    let dormant = false;
    const calls: string[] = [];
    const lines: string[] = [];
    const ops: BoardOp[] = [];
    const threads = Object.assign(fakeThreads(calls), { isDormant: () => dormant });
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add(CHAT);
    await mkdir(join(dir, "session-artifacts", CHAT, JOB), { recursive: true });
    await writeFile(join(dir, "session-artifacts", CHAT, JOB, "rlm-subagent.json"), JSON.stringify({ prompt: "Count the test files, then wait for the release owner.",
      createdAt: now - 5 * 60_000, model: { provider: "openai-codex", modelId: "gpt-6-astra" } }));
    const board: ChatBoard = { v: 2, rev: 4, updatedAt: "", todos: [], plan: plan() };
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", `${CHAT}.jsonl`) }), "b1",
      loadRecord(join(dir, "loads.json")), {
        ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
        resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async (_id: string, batch: readonly BoardOp[]) => { ops.push(...batch); } } },
      line => lines.push(line));
    await chats.adopt();
    const job: ChildAgent = { id: JOB, label: "test file count", sessionName: "test file count", sessionId: SESSION, status: "done", repliedSinceTask: true,
      lastActivityAt: now };
    threads.transcripts.set(CHAT, [{ role: "custom", customType: "agent_message", display: true, timestamp: now,
      content: "[agent-message from child:test file count]\n493 test files at 20:13:24 KST. I wait in this same job for the release owner's notice." } as ThreadMessage]);
    await chats.roster(new Map([[CHAT, [job]]]));
    threads.fire().live(CHAT, [job]);
    await chats.settled();
    // 12:13Z the chat sits dormant; 12:15Z it wakes; then the sweeps of the next 6 hours.
    for (const [at, asleep] of [["2026-10-26T12:13:20Z", true], ["2026-10-26T12:15:20Z", false], ["2026-10-26T14:15:00Z", false], ["2026-10-26T18:15:00Z", false]] as const) {
      now = Date.parse(at);
      dormant = asleep;
      await chats.tick();
      await chats.settled();
    }
    chats.close();
    const log = lines.join("\n");
    assert.deepEqual(calls.filter(call => call.startsWith("delete")), [], `the waiting job is never deleted:\n${log}`);
    assert.deepEqual(await readdir(join(dir, "job-resumes")).catch(() => []), [], "no saved state, since nothing ends the job");
    assert.deepEqual(ops, [], "no step moves to another session");
    assert.deepEqual(board.plan, plan(), "p1 and p2 still name the job's own session, where the release owner's message goes");
    assert.doesNotMatch(log, /ended waiting job|resumed \d\d:\d\d/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Clean-room w81 run4 on 10-26: the service restarted while the chat sat detached, and the daemon's saved row of the job had no
// repliedSinceTask, so the job's reply is read from its own session file. That read still lets the cleanup delete a finished job.
test("after a restart with the chat detached, a reported job with no open step is deleted from its own session file, and one with a waiting step is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waiting-job-restart-"));
  try {
    const childDir = join(dir, "session-artifacts", CHAT, JOB);
    const jobFile = join(childDir, `${SESSION}.jsonl`);
    const now = Date.parse("2026-10-26T12:40:00Z");
    await mkdir(childDir, { recursive: true });
    await writeFile(join(childDir, "rlm-subagent.json"), JSON.stringify({ prompt: "Count the test files.", createdAt: REPORTED - 5 * 60_000, sessionFile: jobFile }));
    const from = { sessionId: CHAT, sessionName: "test file counts 4" };
    await writeFile(jobFile, [
      { type: "session", id: SESSION, timestamp: "2026-10-26T11:08:49Z", rlmDepth: 1 },
      { type: "custom_message", customType: "agent_message", content: "[task from parent] Count the test files.", timestamp: "2026-10-26T11:08:49Z",
        details: { id: `spawn:${JOB}`, message: "Count the test files.", from, fromRelationship: "parent" } },
      { type: "message", timestamp: "2026-10-26T11:13:24Z", message: { role: "toolResult", content: [{ type: "text", text: "ok" }],
        details: { sentAgentMessages: [{ id: "agentmsg_1", message: "493 test files.", deliveryStatus: "delivered", receiverRole: "parent", target: from }] } } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const sweep = async (open: boolean) => {
      const calls: string[] = [];
      const threads = Object.assign(fakeThreads(calls), { isLive: () => false });
      const index = new IdIndex(join(dir, `chats-${open}.json`), "Chat index");
      await index.add(CHAT);
      const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: open ? plan() : [{ ...plan()[0]!, status: "done", children: [] }] };
      const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", `${CHAT}.jsonl`) }), "b1",
        loadRecord(join(dir, `loads-${open}.json`)), {
          ...source(dir, {}, () => now), board: async () => board, waking: async () => false, wakes: async () => [],
          resumes: { store: jobResumes(join(dir, `job-resumes-${open}`)), applyBoard: async () => {} } },
        () => {});
      await chats.adopt();
      threads.transcripts.set(CHAT, [{ role: "custom", customType: "agent_message", display: true, timestamp: REPORTED,
        content: "[agent-message from child:test file count]\n493 test files." } as ThreadMessage]);
      await chats.roster(new Map([[CHAT, [{ id: JOB, label: "test file count", sessionName: "test file count", sessionId: SESSION, status: "done",
        lastActivityAt: Date.parse("2026-10-26T11:15:49Z") } satisfies ChildAgent]]]));
      await chats.tick();
      await chats.settled();
      chats.close();
      return calls.filter(call => call.startsWith("delete"));
    };
    assert.deepEqual(await sweep(false), [`delete ${CHAT} ${JOB}`], "the reply in the job's file makes it reported, and no open step names it");
    assert.deepEqual(await sweep(true), [], "an open step names it, so it waits as the same session");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
