// run7 on 10-20 (clean-room job-cancel-cleanup): the owner's Stop and Archive ended job "user history test run" at 11:20:16Z. Prime told the
// chat "[child-exited: no-reply child:user history test run]" 49 ms after the abort, the chat read a plain exit and sent "You exited without a
// reply. Finish the task" at 11:20:49Z, and that reopened the archived job. Nothing on the service side kept the owner's cancel either, so the
// job-end note, the check-in's steer and the resume pass treated the Stop like any interruption.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockTime } from "../src/checkin-settings.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobCancelRecord } from "../src/job-cancels.ts";
import type { ChatAgent, ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, ownerAsks, row, source } from "./chats-helpers.ts";

const CHAT = "01a15903-32dc-722e-87d3-55af930292fe";
const JOB = "01a15903-cd56-7138-b1c6-b06022221d92";
const NAME = "user history test run";

/** The extension's context hooks for a session of id `id`, run in order the way Prime runs them before each model call. */
async function contextHooks(data: string): Promise<(id: string, messages: unknown[]) => Promise<unknown[]>> {
  const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  const pi = new Proxy({}, { get: (_target, key) => key === "on" ? (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (name === "context") handlers.push(handler); }
    : key === "getFlag" ? (flag: string) => flag === "agent-chat-data-dir" ? data : undefined : () => undefined });
  const { default: historyExtension } = await import("../extension/index.ts");
  historyExtension(pi as never);
  return async (id, messages) => {
    const ctx = { sessionManager: { getSessionId: () => id, getHeader: () => ({ type: "session", id }), getBranch: () => [], getEntries: () => [], getSessionName: () => "" } };
    let current = messages;
    for (const handler of handlers) {
      const result = await handler({ type: "context", messages: current }, ctx) as { messages?: unknown[] } | undefined;
      if (result?.messages) current = result.messages;
    }
    return current;
  };
}

test("run7: the owner's Stop of a job reaches its chat as a cancel, and no recovery reopens it until he sends to it", async t => {
  const root = mkdtempSync(join(tmpdir(), "job-cancel-"));
  process.env.SIEUN_PI_HOSTS = join(root, "no-hosts.json");
  const data = join(root, "browser-chat");
  mkdirSync(data, { recursive: true });
  const jobFile = join(root, "session-artifacts", CHAT, "sub-efba9220", `${JOB}.jsonl`);
  mkdirSync(join(jobFile, ".."), { recursive: true });
  writeFileSync(jobFile, JSON.stringify({ type: "session", id: JOB, parentSession: join(root, "sessions", `${CHAT}.jsonl`), rlmDepth: 1 }) + "\n");

  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(data, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = Date.parse("2026-10-20T11:20:16.250Z");
  const stoppedAt = now;
  const agents: ChatAgent[] = [{ key: "child:sub-efba9220", sessionId: JOB, childId: "sub-efba9220", name: NAME, job: NAME, sender: NAME, link: "subagent",
    state: "done", lastActivityAt: new Date(stoppedAt).toISOString(), steps: ["p1"] }];
  const rows = (): SessionRow[] => [row(CHAT, new Date(now).toISOString(), { chat: true, agents })];
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
    { id: "p1", text: "Count user-history test results at f7f2fd2d", status: "doing", job: NAME, sessionId: JOB, children: [] }] };
  const chats = new Chats(index, threads, async id => id === JOB ? { lifecycle: "live", sessionFile: jobFile } : { lifecycle: "live" }, "b1",
    loadRecord(join(data, "extension-loads.json")), { ...source(data, { [CHAT]: board }, () => now, rows), cancels: jobCancelRecord(join(data, "job-cancels.json")) },
    line => lines.push(line));
  t.after(() => { chats.close(); rmSync(root, { recursive: true, force: true }); });
  await chats.adopt();
  const child: ChildAgent = { id: "sub-efba9220", label: NAME, sessionName: NAME, status: "done", repliedSinceTask: false, lastActivityAt: stoppedAt, sessionId: JOB };
  threads.fire().children(CHAT, [child]);
  threads.transcripts.set(CHAT, [ownerAsks("count the tests at f7f2fd2d", stoppedAt - 433_000)]);
  const task: ThreadMessage = ownerAsks("[task from parent] count the tests", stoppedAt - 433_000);
  const aborted: ThreadMessage = { role: "assistant", content: [], provider: "anthropic", model: "claude-opus-5-5", stopReason: "aborted", errorMessage: "Request was aborted", timestamp: stoppedAt };
  threads.views.set(JOB, { messages: [task, aborted] });
  const step = async () => { now += 30_000; calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => !call.startsWith("pin") && !call.startsWith("steering")); };

  const cancel = await chats.cancelJob(JOB, "stop");
  assert.deepEqual(cancel, { at: stoppedAt, how: "stop", by: "owner", parent: CHAT, child: "sub-efba9220" }, "the Stop is kept with the job's parent and child id");

  const context = await contextHooks(data);
  const notice = { role: "custom", customType: "rlm_child_terminal_notice", content: `[child-exited: no-reply child:${NAME}]`, display: true,
    details: { kind: "completed_without_reply", childId: "sub-efba9220", sessionName: NAME }, timestamp: stoppedAt + 49 };
  const other = { ...notice, content: "[child-exited: no-reply child:other]", details: { kind: "completed_without_reply", childId: "sub-other", sessionName: "other" } };
  const seen = await context(CHAT, [notice, other]) as { content: string; details: Record<string, unknown> }[];
  assert.equal(seen[0]!.content, `[child-exited: cancelled child:${NAME}] ${NAME} was stopped by the owner at ${clockTime(stoppedAt)}. The owner ended it on ` +
    "purpose, so don't reopen it, message it to finish, or start a copy of it.");
  assert.doesNotMatch(seen[0]!.content, /no-reply|without a reply/);
  assert.deepEqual(seen[0]!.details, { kind: "cancelled", childId: "sub-efba9220", sessionName: NAME, by: "owner", at: stoppedAt, how: "stop" });
  assert.equal(seen[1]!.content, "[child-exited: no-reply child:other]", "another child's exit stays as Prime wrote it");
  assert.equal((await context("01a1598a-0fd8-70da-b05c-ffc3a9098309", [notice]) as typeof seen)[0]!.content, notice.content, "another session's child of the same id is not this one");

  assert.deepEqual(await step(), [], "no job-end note, wake or restart for the cancelled job");
  assert.deepEqual(await chats.steerJob(CHAT, NAME, "finish the task"),
    { cancelled: `${NAME} was stopped by the owner at ${clockTime(stoppedAt)}. The owner ended it on purpose, so nothing reopens it; don't start a copy of it.` },
    "the check-in's steer is refused");
  assert.deepEqual(calls.filter(call => call.includes(JOB)), []);

  await chats.reopenJob(JOB);
  const later = { ...notice, timestamp: now + 1_000 };
  const after = await context(CHAT, [notice, later]) as typeof seen;
  assert.match(after[0]!.content, /cancelled child:/, "the notice of the Stop keeps its words");
  assert.equal(after[1]!.content, notice.content, "an exit after the owner reopened the job is a plain exit again");
  const endedAgain = now + 2_000;
  threads.views.set(JOB, { messages: [task, aborted, ownerAsks("go on with the count", now), { ...aborted, timestamp: endedAgain }] });
  agents[0] = { ...agents[0]!, lastActivityAt: new Date(endedAgain).toISOString() };
  threads.fire().children(CHAT, [{ ...child, lastActivityAt: endedAgain }]);
  assert.deepEqual(await step(), [`steer ${CHAT} [job] ${NAME} was aborted at ${clockTime(endedAgain)} and sent no report`], "once reopened, a later end gets the job-end note as before");
  assert.deepEqual(await chats.steerJob(CHAT, NAME, "finish the task"), { session: JOB, act: "steer" });
});

