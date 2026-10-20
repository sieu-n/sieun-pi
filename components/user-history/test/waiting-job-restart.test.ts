// Guards launch main bro 10-20 09:26Z: the cleanup ended "g2g accounts setup" while p105 and p98 waited on promote 16 and 17, and the steps had
// no owner until the d9 run started a job by hand at 09:41Z. The cleanup now starts the fresh job itself and gives it the steps.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes, savedStatePath } from "../src/job-resume.ts";
import type { BoardOp, ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

async function rig(restart?: (chat: string, name: string, brief: (chat: string) => string) => Promise<{ id: string; name: string }>) {
  const dir = await mkdtemp(join(tmpdir(), "waiting-job-restart-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = Date.parse("2026-10-20T08:20:00Z");
  const sessionFile = join(dir, "sessions", "c1.jsonl");
  await mkdir(join(dir, "session-artifacts", "c1", "sub-aee2823c"), { recursive: true });
  await writeFile(join(dir, "session-artifacts", "c1", "sub-aee2823c", "rlm-subagent.json"), JSON.stringify({ prompt: "Set up the 50 G2G accounts.", createdAt: now - 3_600_000 }));
  let board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [{ id: "t9", text: "Pick the G2G seller for p120", from: "agent", done: false, at: new Date(now).toISOString() }], plan: [
    { id: "p105", text: "us-08 answers after promote 17", status: "blocked", job: "g2g accounts setup", waitFor: "806703daf reaches staging (promote 17's land)", children: [] },
    { id: "p98", text: "Paced p98 probe on prod", status: "blocked", job: "g2g accounts setup", waitFor: "promote 16 reaches prod", note: "Probe script ready.", children: [] },
    { id: "p120", text: "Second G2G order", status: "blocked", job: "g2g accounts setup", waitFor: "the owner picks the seller in t9", children: [] }] };
  const base = source(dir, {}, () => now);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...base, board: async () => board, waking: async () => false, wakes: async () => [],
    resumes: { store: jobResumes(join(dir, "job-resumes")), ...restart ? { restart } : {}, applyBoard: async (_id: string, ops: readonly BoardOp[]) => {
      board = { ...board, plan: board.plan.map(item => {
        const op = ops.find(each => each.op === "plan_update" && each.id === item.id);
        if (!op || op.op !== "plan_update") return item;
        return { ...item, ...op.job ? { job: op.job } : {}, ...op.sessionId ? { sessionId: op.sessionId } : {}, ...typeof op.note === "string" ? { note: op.note } : {} };
      }) };
    } },
  }, line => lines.push(line));
  await chats.adopt();
  const job: ChildAgent = { id: "sub-aee2823c", label: "g2g accounts setup", sessionName: "g2g accounts setup", sessionId: "s-g2g", status: "done",
    repliedSinceTask: true, lastActivityAt: now };
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now,
    content: "[agent-message from child:g2g accounts setup]\nStep landed: 245 accounts imported; p105 and p98 wait on promote 16 and 17." } as ThreadMessage]);
  await chats.roster(new Map([["c1", [job]]]));
  threads.fire().live("c1", [job]);
  await chats.settled();
  now += PARK_IDLE_MS + 6 * 60_000;
  await chats.tick();
  await chats.settled();
  chats.close();
  return { calls, lines, board: () => board };
}

test("waiting job cleanup: a job ended while its steps wait is replaced at once by a fresh job that owns them", async () => {
  const started: { chat: string; name: string; brief: string }[] = [];
  const { calls, lines, board } = await rig(async (chat, name, brief) => { started.push({ chat, name, brief: brief("launch main bro") }); return { id: "s-fresh", name }; });
  assert.ok(calls.includes("delete c1 sub-aee2823c"), "the quiet job is ended");
  assert.equal(started.length, 1, "one fresh job starts for the job's steps");
  assert.equal(started[0]!.chat, "c1");
  assert.match(started[0]!.name, /^g2g accounts setup resumed \d\d:\d\d$/);
  const brief = started[0]!.brief;
  assert.match(brief, /^Set up the 50 G2G accounts\./, "the fresh job gets the old brief first");
  assert.match(brief, /p105, p98 are yours now/);
  assert.doesNotMatch(brief, /p120/, "a step an open For you todo holds is not handed to the fresh job");
  assert.match(brief, /board\.wake\(run=\.\.\.\) or board\.wake\(at=\.\.\.\)/);
  assert.match(brief, /receiver_role="sibling", receiver_name="launch main bro"/);
  const [p105, p98, p120] = board().plan;
  for (const step of [p105!, p98!]) {
    assert.equal(step.sessionId, "s-fresh", `${step.id} is owned by the fresh job's session`);
    assert.equal(step.job, started[0]!.name);
    assert.match(step.note ?? "", /\nResumed: the chat service started job g2g accounts setup resumed /);
  }
  assert.match(p98!.note ?? "", /\nProbe script ready\.$/, "the step's old note stays");
  assert.equal(p120!.job, "g2g accounts setup", "the todo-held step keeps its job");
  assert.equal(p120!.sessionId, undefined);
  const saved = JSON.parse(await readFile(savedStatePath(p98!)!, "utf8")) as { steps: string[] };
  assert.deepEqual(saved.steps, ["p105", "p98", "p120"], "the saved state still lists every step the job held");
  assert.ok(lines.some(line => /started g2g accounts setup resumed \d\d:\d\d \(s-fresh\) for p105, p98$/.test(line)));
});

test("waiting job cleanup: a fresh job that cannot start leaves each step with the saved state note for the check-in", async () => {
  const { lines, board } = await rig(async () => { throw new Error("no chat c1"); });
  const p98 = board().plan[1]!;
  assert.equal(p98.job, "g2g accounts setup");
  assert.equal(p98.sessionId, undefined);
  assert.ok(savedStatePath(p98) !== undefined, "the note names the saved state");
  assert.doesNotMatch(p98.note ?? "", /Resumed:/);
  assert.ok(lines.includes("chat c1: resume waiting job g2g accounts setup: no chat c1"));
});
