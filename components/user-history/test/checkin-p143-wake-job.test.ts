import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { endState } from "../src/checkin-end-state.ts";
import { type JobFact, stepView } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { ChildAgent, PlanItem, ThreadMessage } from "../src/shared/types.ts";
import { waking } from "../src/wakes.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * Slack green guy 10-15: job blog signup fix sent its last reply at 10:01:51Z, owned open step p143 and slept on a board.wake for 10-22 10:00Z (its
 * 7-day recheck of #257). The chat was attached, and the hub's children carry no session id, so at 11:07Z the sweep skipped the wake check and
 * deleted the job. The 11:18Z check-in read p143's owner as "(not found)" and its wait "main merges landing #257; ..." as an event no live job
 * watched, while main merges worked on #257.
 */
const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";
const SESSION = "01a13ebb-29b3-70a4-9d55-280256a35c6a";
const REPORTED = Date.parse("2026-10-15T10:01:51Z");
const SWEEP = Date.parse("2026-10-15T11:07:27Z");
const WAIT = "main merges landing #257; then blog signup fix rechecks 7 days after deploy";
const P143: PlanItem = { id: "p143", text: "Build: fix the biggest measured loss between on-topic blog readers and signup, shipped to everyone", status: "doing",
  job: "blog signup fix", waitFor: WAIT, children: [] };
const HUB: ChildAgent = { id: "sub-4d5ce6c0", label: "blog signup fix", sessionName: "blog signup fix", status: "done", repliedSinceTask: true, lastActivityAt: REPORTED };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "sg-p143-"));
  const childDir = join(dir, "session-artifacts", CHAT, HUB.id);
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, "rlm-subagent.json"), JSON.stringify({ prompt: "Fix the blog to signup loss, then recheck 7 days after deploy.", createdAt: REPORTED - 3_600_000 }));
  const wakeDir = join(dir, "wakes");
  await mkdir(wakeDir);
  await writeFile(join(wakeDir, `${SESSION}-time-1792663200.json`), JSON.stringify({ session: SESSION, root: CHAT, on: { kind: "time", at: 1792663200000 },
    note: "7-day recheck of PR #257", since: Date.parse("2026-10-15T10:01:46Z") }));
  const boards = new BoardStore(dir);
  await mkdir(boards.dir, { recursive: true });
  await writeFile(join(boards.dir, `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [P143] }));
  let now = REPORTED;
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set(CHAT, [{ role: "custom", customType: "agent_message", content: "[agent-message from child:blog signup fix]\nPR #257 is green; recheck set for 10-22.",
    display: true, timestamp: REPORTED } as ThreadMessage]);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", `${CHAT}.jsonl`) }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now), board: id => boards.read(id), waking: session => waking(wakeDir, session),
      resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") } }, line => lines.push(line));
  await chats.adopt();
  const roster = (children: ChildAgent[]) => (chats as unknown as { roster(byChat: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> }).roster(new Map([[CHAT, children]]));
  const sweep = async () => { now = SWEEP; await chats.tick(); await chats.settled(); };
  return { chats, threads, calls, lines, roster, sweep };
}

test("p143: an attached chat's job asleep on a board.wake is kept, with its session from the daemon's list", async () => {
  const { chats, threads, calls, lines, roster, sweep } = await setup();
  await roster([{ ...HUB, sessionId: SESSION }]);
  threads.fire().live(CHAT, [HUB]);
  await chats.settled();
  assert.ok(SWEEP - REPORTED > PARK_IDLE_MS, "quiet long enough to park");
  await sweep();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [], lines.join("\n"));
  assert.ok(lines.includes("chat 01a11b0b: kept job blog signup fix: it waits on a board.wake"), lines.join("\n"));
  chats.close();
});

test("p143: a job whose session the daemon's list has not given yet is kept, since its wakes cannot be read", async () => {
  const { chats, threads, calls, lines, sweep } = await setup();
  threads.fire().live(CHAT, [HUB]);
  await chats.settled();
  await sweep();
  assert.deepEqual(calls.filter(call => call.startsWith("delete")), [], lines.join("\n"));
  assert.ok(lines.some(line => line.startsWith("chat 01a11b0b: kept job blog signup fix: the daemon's list has not given its session yet")), lines.join("\n"));
  chats.close();
});

test("p143: with blog signup fix gone, a wait whose first clause names the working job main merges is moving", () => {
  const facts: JobFact[] = [{ key: "sub-7a1c0e2f", name: "main merges", state: "working", wake: "a board.wake on run 38712000001" }];
  const now = Date.parse("2026-10-15T11:18:37Z");
  const view = stepView(P143, now - 2 * 3_600_000, new Set([CHAT]), facts, [], [], now);
  const end = endState(view, [], [], new Set([CHAT]), now, facts);
  assert.equal(end.state, "moving", end.reason);
  assert.match(end.reason, /main merges/);
});
