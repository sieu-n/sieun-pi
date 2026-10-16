import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { checkInPrecheck, PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { OK_STATES } from "../src/checkin-end-state.ts";
import { STEP_STALE_MS, type JobFact } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { ChatBoard, ChildAgent, PlanItem, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

/**
 * frontend bro 10-16: inbox tree lines reported at 02:18Z with p164 doing, and email compose polish reported at 03:41Z with p168 doing. The
 * chat closed neither, the cleanup ended both jobs at 03:42Z and 04:02Z, and the 04:04Z check-in read both steps job_ended (stuck_steps 2).
 * Now the cleanup hands each step to the chat with a "close or continue" turn as soon as the report is in.
 */
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const TREE_AT = Date.parse("2026-10-16T02:18:53Z");
const COMPOSE_AT = Date.parse("2026-10-16T03:41:59Z");
const CHECK_IN = Date.parse("2026-10-16T04:04:07Z");
const step = (id: string, text: string, job: string, note?: string): PlanItem => ({ id, text, status: "doing", job, children: [], ...(note ? { note } : {}) });
const PLAN: PlanItem[] = [
  step("p156", "Every menu, input and button in the demo comes from one shared set", "demo train ui round", "the inbox commit lands after inbox tree lines reports"),
  step("p164", "Nested rows in Inbox, Watchlist and the picker share one tree line design", "inbox tree lines"),
  step("p168", "Email compose gets clear handling of creators with no email", "email compose polish"),
];
const job = (id: string, name: string, at: number, status: ChildAgent["status"] = "done"): ChildAgent =>
  ({ id, sessionId: `${id}-session`, label: name, sessionName: name, status, repliedSinceTask: status === "done", lastActivityAt: at });
const TRAIN = job("sub-01a14130", "demo train ui round", COMPOSE_AT, "running");
const TREE = job("sub-5533de65", "inbox tree lines", TREE_AT);
const COMPOSE = job("sub-867e3ab7", "email compose polish", COMPOSE_AT);
const report = (name: string, text: string, at: number): ThreadMessage =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\n\n${text}`, display: true, timestamp: at } as ThreadMessage);

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hand-back-"));
  for (const child of [TREE, COMPOSE]) {
    await mkdir(join(dir, "session-artifacts", CHAT, child.id), { recursive: true });
    await writeFile(join(dir, "session-artifacts", CHAT, child.id, "rlm-subagent.json"), JSON.stringify({ prompt: `Brief of ${child.label}`, createdAt: TREE_AT - 3_600_000 }));
  }
  const boards = new BoardStore(dir);
  await mkdir(boards.dir, { recursive: true });
  await writeFile(join(boards.dir, `${CHAT}.json`), JSON.stringify({ v: 2, rev: 1, updatedAt: "", todos: [], plan: PLAN }));
  let now = COMPOSE_AT + 60_000;
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set(CHAT, [report("inbox tree lines", "Done. Nested rows on 5180 now share one look, $lib/ui/TreeLines.svelte.", Date.parse("2026-10-16T02:32:42Z")),
    report("email compose polish", "The compose polish is done on 5180 Staging Inbox.", COMPOSE_AT)]);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile: join(dir, "sessions", `${CHAT}.jsonl`) }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now), board: id => boards.read(id), waking: async () => false,
      resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: (id, ops) => boards.apply(id, ops, "agent") } }, line => lines.push(line));
  await chats.adopt();
  const sweep = async (at: number) => { now = at; await chats.tick(); await chats.settled(); };
  return { chats, threads, calls, lines, boards, sweep };
}

/** Stuck steps by check-in run: the first run saw the plan as it was at 02:17Z, each later run reads the run before it. */
function checkIns(facts: readonly JobFact[]) {
  const self = [CHAT, "frontend bro"];
  let memory = checkInPrecheck(undefined, facts, { v: 2, rev: 1, updatedAt: "", todos: [], plan: PLAN } as unknown as ChatBoard, TREE_AT - 60_000, { self }).memory;
  return (board: ChatBoard, at: number) => {
    const run = checkInPrecheck(memory, facts, board, at, { self });
    memory = run.memory;
    return run.end.filter(entry => !OK_STATES.has(entry.state)).map(entry => [entry.view.item.id, entry.state]);
  };
}

test("p164 and p168: a job that reported with its step doing hands the step to the chat with one close-or-continue turn, and stuck_steps reads 0", async () => {
  const { chats, threads, calls, lines, boards, sweep } = await setup();
  threads.fire().live(CHAT, [TRAIN, { ...TREE, status: "running", repliedSinceTask: false }, { ...COMPOSE, status: "running", repliedSinceTask: false }]);
  await chats.settled();
  threads.fire().children(CHAT, [TRAIN, TREE, COMPOSE]);
  await chats.settled();
  await new Promise(resolve => setTimeout(resolve, 20));
  await chats.settled();
  const handed = (await boards.read(CHAT))!;
  const [p156, p164, p168] = handed.plan;
  assert.equal(p156!.job, "demo train ui round", "a step another working job owns stays with it, though its note names inbox tree lines");
  assert.deepEqual([p164!.job, p168!.job], [CHAT, CHAT]);
  assert.match(p164!.note!, /^Handed back: job inbox tree lines reported at \S+ with this step open, so the step is the chat's\.$/m, "inbox tree lines was quiet 83 min, so the same sweep also saved it");
  assert.match(p168!.note!, /^Handed back: job email compose polish reported at /, "email compose polish was quiet 1 min: handed back, kept");
  const turns = calls.filter(call => call.startsWith(`steer ${CHAT} `));
  assert.equal(turns.length, 2, calls.join("\n"));
  assert.ok(turns.some(turn => turn.includes("inbox tree lines reported") && turn.endsWith("Close or continue p164.")), turns.join("\n"));
  assert.ok(turns.some(turn => turn.includes("email compose polish reported") && turn.endsWith("Close or continue p168.")), turns.join("\n"));
  assert.ok(!turns.some(turn => turn.includes("open step names it")), "the open-steps notice skips a step already handed back");
  assert.ok(lines.includes("chat 01a11ba8: handed p164 back to the chat: job inbox tree lines reported with them open"), lines.join("\n"));

  await sweep(COMPOSE_AT + PARK_IDLE_MS + 10 * 60_000);
  assert.equal(calls.filter(call => call.startsWith(`steer ${CHAT} `)).length, 2, "handed once");
  assert.deepEqual(calls.filter(call => call.startsWith("delete")).sort(), [`delete ${CHAT} ${TREE.id}`, `delete ${CHAT} ${COMPOSE.id}`], "both are still saved and ended");
  const parked = (await boards.read(CHAT))!;
  assert.match(parked.plan[1]!.note!, /^Saved state: job inbox tree lines .*\nHanded back: job inbox tree lines /);
  assert.equal(parked.plan[1]!.job, CHAT);
  chats.close();

  const facts: JobFact[] = [{ key: TRAIN.id, name: "demo train ui round", state: "working" }];
  const unchanged = checkIns(facts);
  assert.deepEqual(unchanged({ v: 2, rev: 1, updatedAt: "", todos: [], plan: PLAN } as unknown as ChatBoard, CHECK_IN), [["p164", "job_ended"], ["p168", "job_ended"]],
    "the 04:04Z check-in on the board the old cleanup left: stuck_steps 2");
  const run = checkIns(facts);
  assert.deepEqual(run(parked, CHECK_IN), [], "stuck_steps 0 while the chat's turn has its chance");
  assert.deepEqual(run(parked, CHECK_IN + STEP_STALE_MS + 60_000), [["p164", "no_owner"], ["p168", "no_owner"]], "a step the chat left 2 h after its turn is stuck again");
});

test("a reported job keeps a step that waits on something", async () => {
  const { chats, threads, calls, boards } = await setup();
  await boards.apply(CHAT, [{ op: "plan_update", id: "p164", waitFor: "run 38830122888 green" }], "agent");
  threads.fire().live(CHAT, [TRAIN, { ...TREE, status: "running", repliedSinceTask: false }]);
  await chats.settled();
  threads.fire().children(CHAT, [TRAIN, TREE]);
  await chats.settled();
  assert.equal((await boards.read(CHAT))!.plan[1]!.job, "inbox tree lines");
  assert.ok(!calls.some(call => call.includes("Close or continue")), calls.join("\n"));
  chats.close();
});
