// ops guy 10-20: p439's job "hyperdx error logs" (01a154a4), a subagent of the check-in job 23:40, waited on pi-pool slots from 08:20Z to 13:15Z.
// withFailedTurns looked for its transcript only under the chat's own folder, so the check-ins at 10:03Z and 11:23Z read the agents panel's cut
// line, saw no pool wait, read the job failed and p439 stuck, and the server restarted it into another 429. The fixture is its tail at 10:03Z.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import { jobFacts, nestedJobs, poolWait } from "../src/checkin-steps.ts";
import { cutActivity, cutEnd } from "../src/cut-end.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { withFailedTurns } from "../src/held-turns.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "hyperdx-error-logs-pool-wait-1020.jsonl");
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const DUTY_JOB = "01a1549e-6720-7668-bc94-02cc1f88dda7";
const JOB = "01a154a4-bc26-756b-9e0a-41f44a9d5473";
const NOW = Date.parse("2026-10-20T10:03:17Z");
const board = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p429", text: "Production and the dev boxes run with no alert firing for this chat",
  status: "doing", children: [{ id: "p439", text: "Fix: hyperdx-error-logs fires since 09:18Z", status: "doing", job: JOB, sessionId: JOB,
    waitFor: "promote 16 (run 39382235504 on e8609c8c04, in gates since 06:45Z)", children: [] }] }] } as unknown as ChatBoard);

test("a duty job's subagent that waits on a pi-pool slot reads as a pool wait from its own transcript, so its step is moving and gets no push", async () => {
  const agentDir = join(await mkdtemp(join(tmpdir(), "nested-pool-wait-")), ".prime", "agent");
  const file = join(agentDir, "session-artifacts", DUTY_JOB, "sub-299e90d1", `${JOB}.jsonl`);
  await mkdir(join(file, ".."), { recursive: true });
  await copyFile(FIXTURE, file);
  const cut = cutEnd((await readFile(FIXTURE, "utf8")).split("\n"));
  assert.ok(cut?.error, "the roster reads a cut with a provider error");
  const child: ChildAgent = { id: "sub-299e90d1", label: "hyperdx error logs", sessionName: "hyperdx error logs", sessionId: JOB, status: "error",
    error: cutActivity(cut), lastActivityAt: Date.parse("2026-10-20T08:23:11Z") };
  const nested = nestedJobs([DUTY_JOB], [], new Map([[DUTY_JOB, [child]]]));
  const facts = jobFacts([], board(), [], CHAT, nested);
  assert.equal(poolWait(facts[0]), false, "the cut line alone names no pool wait");
  const before = await withFailedTurns(facts, agentDir, CHAT);
  assert.equal(poolWait(before[0]), false, "the chat's own folder does not hold the transcript");

  const read = await withFailedTurns(facts, agentDir, CHAT, () => undefined, async session => session === JOB ? file : undefined);
  assert.equal(read[0]!.state, "failed");
  assert.match(read[0]!.error ?? "", /waits for its slot at 2026-10-20T08:30:00\.000Z/);
  assert.equal(poolWait(read[0]), true);

  const stuck = checkInPrecheck(undefined, before, board(), NOW, { self: [CHAT] });
  assert.equal(stuck.end.find(entry => entry.view.item.id === "p439")?.state, "release", "the 10:03Z reading");
  const precheck = checkInPrecheck(undefined, read, board(), NOW, { self: [CHAT] });
  const end = precheck.end.find(entry => entry.view.item.id === "p439");
  assert.equal(end?.state, "moving");
  assert.match(end?.reason ?? "", /waits for its slot in the token pool/);
  assert.deepEqual(precheck.jobs.filter(push => push.fact.sessionId === JOB), [], "no restart for a job pi-pool holds");
});

test("the check-in finds that transcript through the catalog's session file and reads p439 moving, where the 10:03Z run read stuck_steps 1", async () => {
  const home = await mkdtemp(join(tmpdir(), "nested-pool-wait-chats-"));
  const file = join(home, ".prime", "agent", "session-artifacts", DUTY_JOB, "sub-299e90d1", `${JOB}.jsonl`);
  await mkdir(join(file, ".."), { recursive: true });
  await copyFile(FIXTURE, file);
  const cut = cutEnd((await readFile(FIXTURE, "utf8")).split("\n"))!;
  const child: ChildAgent = { id: "sub-299e90d1", label: "hyperdx error logs", sessionName: "hyperdx error logs", sessionId: JOB, status: "error",
    error: cutActivity(cut), lastActivityAt: Date.parse("2026-10-20T08:23:11Z") };
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  const rows = (): SessionRow[] => [row(CHAT, new Date(NOW - 60_000).toISOString(), { chat: true })];
  const listed = async (id: string) => id === JOB ? { lifecycle: "live", sessionFile: file } : { lifecycle: "live" };
  const chats = new Chats(index, fakeThreads([]), listed, "b1", loadRecord(join(home, "extension-loads.json")),
    { ...source(home, { [CHAT]: board() }, () => NOW, rows), home, dutyJobs: async id => id === CHAT ? [DUTY_JOB] : [] });
  await chats.adopt();
  await chats.roster(new Map([[DUTY_JOB, [child]]]));
  const output = await chats.measureCheckIn(CHAT);
  chats.close();
  assert.equal(output?.metrics.stuck_steps, 0);
});
