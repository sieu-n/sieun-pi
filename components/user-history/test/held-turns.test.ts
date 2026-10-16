import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { InterruptedRuns } from "../src/chat-resume.ts";
import { Chats } from "../src/chats.ts";
import { endState } from "../src/checkin-end-state.ts";
import { type JobFact, stepView } from "../src/checkin-steps.ts";
import { readHeldTurns, RESUME_PENDING_FILE, RESUME_PENDING_FRESH_MS, withHeldTurns, writeResumePending } from "../src/held-turns.ts";
import { IdIndex } from "../src/id-index.ts";
import type { InterruptedRun } from "../src/shared/interrupted.ts";
import type { ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

/**
 * frontend bro (01a11ba8), 10-15 and 10-16. A worker stop at 16:07Z cut four jobs, which read job_ended until the resume pass sent them
 * "continue" at 16:32Z, and lost the first task of watchlist viewers and scroll (sub-1ae59fb8), spawned at 15:37Z: its file held only two worker
 * recovery notices, and p157 read job_ended for 3 h. The workers' SIGTERM at 17:43:22Z aborted stuck steps root cause (01a14075) while it
 * waited 103rd in pi-pool, the daemon then listed it only as saved, and the owner's stop archived it and two more step owners at 18:25Z; nothing
 * resumed them, and p158, p146 and p157 read stuck.
 */
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const NOW = Date.parse("2026-10-15T16:20:00Z");
const self = new Set([CHAT, "frontend bro"]);
const step = (id: string, extra: Partial<PlanItem>): PlanItem => ({ id, text: `step ${id}`, status: "doing", children: [], ...extra });
const end = (item: PlanItem, facts: readonly JobFact[]) => endState(stepView(item, NOW - 30 * 60_000, self, facts, [], [], NOW), [], [], self, NOW, facts);

test("a job cut by a worker stop reads moving while the resume pass holds its continue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "held-turns-"));
  const toast = "01a14019-8e78-7157-a686-a5a77af356da";
  const facts: JobFact[] = [{ key: "sub-b1e2c400", name: "toast round border fix", state: "ended", activityAt: NOW - 13 * 60_000 }];
  const p150 = step("p150", { job: "toast round border fix" });
  assert.equal(end(p150, facts).state, "job_ended", "the old reading: ended");
  await writeResumePending(dir, [{ session_id: toast, reason: "worker_stopped" }], NOW);
  const held = await readHeldTurns(dir, NOW);
  const marked = withHeldTurns(facts, held.sessions, key => key === "sub-b1e2c400" ? toast : undefined);
  assert.equal(end(p150, marked).state, "moving");
  assert.equal(end(p150, marked).reason, "job toast round border fix sleeps on the chat service's continue after its cut turn (worker_stopped)");
  const stale = await readHeldTurns(dir, NOW + RESUME_PENDING_FRESH_MS + 1);
  assert.equal(stale.sessions.has(toast), false, "a resume list two sweeps old holds nothing");
  await writeFile(join(dir, RESUME_PENDING_FILE), "{");
  assert.equal((await readHeldTurns(dir, NOW)).sessions.has(toast), false, "a broken file holds nothing");
});

test("resumeJobs names the step owners to the script and records the cut runs it found", async () => {
  const calls: string[][] = [];
  const cut: InterruptedRun = { id: "e005db", name: "watchlist viewers and scroll", reason: "never_started", session_id: "w1", error: "x", errored_at: "t", head: "w1", head_session_id: "w1" };
  const runs = new InterruptedRuns(async args => { calls.push([...args]); return { paused: [cut], heads: [], checked_at: "now" }; });
  const found: string[][] = [];
  await runs.resumeJobs(run => run.session_id === "w1", async () => {}, new Set(["w1", "d1"]), async list => { found.push(list.map(run => run.session_id!)); });
  assert.deepEqual(calls, [["--dry-run", "--direct", "--owners", "w1,d1"], ["--direct", "--only", "w1", "--owners", "w1,d1"]]);
  assert.deepEqual(found, [["w1"]]);
});

test("resumeJobs reopens a cut job the daemon no longer knows, sends its continue again, and keeps a cut job the head rule misses", async () => {
  const calls: string[][] = [];
  const queueAudit: InterruptedRun = { id: "af137c9fa4e0", name: "queue audit", reason: "aborted", session_id: "qa", error: "x", errored_at: "2026-10-15T22:28:20.847Z",
    head: "f4b9cf4fb51f" };
  const gone = { error: "prime-agent send --json af137c9fa4e0 continue failed (1): Error: Unknown active session: 01a14174-ce46-7478-97ef-af137c9fa4e0" };
  let sends = 0;
  const runs = new InterruptedRuns(async args => {
    calls.push([...args]);
    if (args.includes("--dry-run")) return { paused: [queueAudit], heads: [], checked_at: "now" };
    sends++;
    return { paused: [queueAudit], heads: [], children: [{ id: "af137c9fa4e0", name: "queue audit", head: "f4b9cf4fb51f",
      result: sends === 1 ? gone : { deliveryStatus: "delivered", deliveryMode: "steer" } }], checked_at: "now" };
  });
  const reopened: string[] = [];
  const report = await runs.resumeJobs(() => false, async id => { reopened.push(id); }, new Set(["w1"]), undefined, new Set(["qa"]));
  assert.deepEqual(calls, [["--dry-run", "--direct", "--owners", "w1,qa"], ["--direct", "--only", "qa", "--owners", "w1,qa"], ["--direct", "--only", "qa", "--owners", "w1,qa"]]);
  assert.deepEqual(reopened, ["qa"], "the gone job is reopened from its file before the second send");
  assert.deepEqual(report?.children?.[0]?.result, { deliveryStatus: "delivered", deliveryMode: "steer" });
});

test("the job sweep passes every open step's owner to the resume pass, a job lost before its first turn and a saved root included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "held-turns-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const at = "2026-10-15T16:07:02Z";
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: at, plan: [
    step("p156", { status: "todo", children: [step("p157", { status: "todo", job: "watchlist viewers and scroll", sessionId: "w1" })] }),
    step("p146", { job: "demo train inbox creators" }),
    step("p158", { job: "stuck steps root cause", sessionId: "pk1" }),
    step("p149", { status: "done", job: "5180 cold load memory fix", sessionId: "x1" })] };
  const trains: ChatAgent = { key: "thread:d1", sessionId: "d1", name: "demo train inbox creators", job: "session:d1", sender: "demo train inbox creators",
    link: "root", state: "idle", steps: ["p146"], lastActivityAt: at };
  const rows = (): SessionRow[] => [row(CHAT, at, { chat: true, agents: [trains] })];
  const owners: string[][] = [];
  const kept: string[][] = [];
  const paused: InterruptedRun[] = ["w1", "d1", "pk1", "x1"].map(session => ({ id: session, name: session, reason: "never_started", session_id: session, error: "x",
    errored_at: at, head: session, head_session_id: session }));
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { [CHAT]: board }, () => NOW, rows),
      interrupted: async (isJob, named) => { owners.push([...named].sort()); kept.push(paused.filter(isJob).map(run => run.session_id!)); return null; } }, () => {});
  await chats.adopt();
  await chats.tick();
  await chats.settled();
  assert.deepEqual(owners, [["d1", "pk1", "w1"]], "open leaf steps only, never a done step's job");
  assert.deepEqual(kept, [["w1", "d1", "pk1"]], "a step owner counts as the chat's job wherever its session sits");
  chats.close();
});
