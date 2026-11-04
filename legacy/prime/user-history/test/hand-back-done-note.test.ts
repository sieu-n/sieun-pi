// Guards designer bro's p450 on 11-03: the job sweep read p450 open on "ai usage viewer" at about 12:26Z, the chat marked it done with its done
// note right after, and the sweep's hand back wrote the note it had read under its "Handed back" line, so the done note was gone until the d9
// spot audit restored it at board rev 4445 on 11-04.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { handBackNote } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import { applyBoardOp } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const WORKING = "Owner's words, 11-03: an AI usage viewer and per-use-case model pickers. The job moves his pick to staging.";
const DONE = "Done when staging shows the AI usage page and the pickers. Done 11-03 12:25Z: staging settings is settings/ai-usage-console.";
const CLOSE: BoardOp = { op: "plan_update", id: "p450", status: "done", job: null, note: DONE };

/**
 * A chat whose job "ai usage viewer" reported with p450 open, on a real board store. `tell` runs while the sweep tells the chat; `staleRead`
 * closes p450 right after the job sweep reads the board, and that read still returns it open.
 */
async function rig(during: { tell?: (boards: BoardStore) => Promise<void>; staleRead?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "hand-back-done-note-"));
  const boards = new BoardStore(dir);
  await mkdir(boards.dir, { recursive: true });
  await writeFile(join(boards.dir, "c1.json"), JSON.stringify({ v: 2, rev: 1, updatedAt: "2026-11-03T11:46:00Z", todos: [], plan: [{ id: "p450",
    text: "Design an AI usage page and per-task model pickers on 5180", status: "doing", job: "ai usage viewer", note: WORKING, children: [] }] }));
  const stale = await boards.read("c1");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.prompt = async (id: string, input: { message: string; mode: string }) => { calls.push(`${input.mode} ${id} ${input.message}`); await during.tell?.(boards); };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = Date.parse("2026-11-03T12:25:00Z");
  let closed = false;
  const board = async (id: string): Promise<ChatBoard | null> => {
    // The job sweep's own read (`cleanJobs`) is the one that must see p450 open while the chat closes it.
    if (during.staleRead && !closed && new Error().stack?.includes("cleanJobs")) { closed = true; await boards.apply(id, [CLOSE], "agent"); return stale; }
    return boards.read(id);
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now), board, waking: async () => false, wakes: async () => [],
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") },
  }, () => {});
  await chats.adopt();
  const job: ChildAgent = { id: "sub-a1b2c3d4", label: "ai usage viewer", sessionName: "ai usage viewer", sessionId: "s-viewer", status: "done",
    repliedSinceTask: true, lastActivityAt: now - 30_000 };
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 30_000,
    content: "[agent-message from child:ai usage viewer]\nDone: staging settings is settings/ai-usage-console." } as ThreadMessage]);
  await chats.roster(new Map([["c1", [job]]]));
  threads.fire().live("c1", [job]);
  await chats.settled();
  now += 11 * 60_000;
  await chats.tick();
  await chats.settled();
  chats.close();
  const p450 = (await boards.read("c1"))!.plan[0]!;
  await rm(dir, { recursive: true, force: true });
  return { p450, told: calls.some(call => call.includes("its open step is yours now")), closed };
}

test("hand back: the chat's done write that lands while the sweep tells the chat keeps its done note, status and owner", async () => {
  const { p450, told } = await rig({ tell: boards => boards.apply("c1", [CLOSE], "agent").then(() => {}) });
  assert.ok(told);
  assert.equal(p450.status, "done");
  assert.equal(p450.note, DONE, "the hand back writes nothing over a step that was closed after the sweep read it");
  assert.equal(p450.job, undefined);
});

test("hand back: a step the chat closed right after the sweep read the board is not handed back, and the chat gets no turn for it", async () => {
  const { p450, told, closed } = await rig({ staleRead: true });
  assert.ok(closed, "the sweep read the board");
  assert.equal(told, false);
  assert.equal(p450.status, "done");
  assert.equal(p450.note, DONE);
});

test("hand back: an open step still gets the line above its current note", async () => {
  const { p450, told } = await rig({});
  assert.ok(told);
  assert.equal(p450.job, "c1");
  assert.match(p450.note ?? "", /^Handed back: job ai usage viewer reported at \d\d:\d\d with this step open, so the step is the chat's\.\n/);
  assert.ok(p450.note!.endsWith(WORKING));
});

test("hand back first: the chat's later done write keeps its done note, with or without a job change", () => {
  const at = "2026-11-03T12:26:00Z";
  const handed: ChatBoard = { v: 2, rev: 3, updatedAt: at, todos: [], plan: [{ id: "p450", text: "Design an AI usage page", status: "doing", job: "c1",
    note: `${handBackNote("ai usage viewer", Date.parse("2026-11-03T12:25:00Z"))}\n${WORKING}`, children: [] }] };
  const unlinked = applyBoardOp(handed, CLOSE, "agent", at, () => "p9").board.plan[0]!;
  assert.equal(unlinked.note, DONE);
  const kept = applyBoardOp(handed, { op: "plan_update", id: "p450", status: "done", note: DONE }, "agent", at, () => "p9").board.plan[0]!;
  assert.match(kept.note ?? "", /^Handed back: job ai usage viewer reported at \d\d:\d\d with this step open, so the step is the chat's\.\n/);
  assert.ok(kept.note!.endsWith(DONE));
});
