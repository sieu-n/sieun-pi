// Crawler VP on 10-18: 16 jobs ended their turns on "Provider rate limit exceeded ... waits for its slot at 21:49:27Z" at 19:53Z. The daemon
// still listed them running, the 20:51Z check-in read "working, no activity for 58 min", job-steer steered them, and each steer sat in a
// stopped queue until the owner aborted, resumed the queue and steered again at 20:56Z. The fixture is the trimmed tail of one of them,
// "census kafka producer" (sub-6ad2ffff).
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { Chats } from "../src/chats.ts";
import { lastTurnError, withFailedTurns } from "../src/held-turns.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, SessionRow } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "census-kafka-producer-429-1018.jsonl");
const JOB = "01a14d5d-bd24-72ad-8840-7156b5ef0baf";
const NOW = Date.parse("2026-10-18T20:51:45Z");

test("a transcript that ends on a 429 reads as a failed turn until an input or a pi-pool queue place follows it", async () => {
  const tail = await readFile(FIXTURE, "utf8");
  assert.match(lastTurnError(tail) ?? "", /^Provider rate limit exceeded .* waits for its slot at 2026-10-18T21:49:27\.000Z/);
  const steer = JSON.stringify({ type: "message", timestamp: "2026-10-18T20:56:04.216Z", message: { role: "user", content: [{ type: "text", text: "[check-in] Resume now." }] } });
  assert.equal(lastTurnError(tail + steer + "\n"), undefined, "the hand fix's steer started a turn");
  const queued = JSON.stringify({ type: "custom", customType: "pi-pool-queue", data: { position: 3, total: 9 } });
  assert.equal(lastTurnError(tail + queued + "\n"), undefined, "a turn queued for a slot starts by itself");
  const ended = JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [] } });
  assert.equal(lastTurnError(tail + ended + "\n"), undefined);
});

test("a job the daemon lists running whose last turn failed reads failed, loses its wake, and job-steer steers it for its slot", async () => {
  const home = await mkdtemp(join(tmpdir(), "job-steer-error-"));
  const folder = join(home, ".prime", "agent", "session-artifacts", "c1", "sub-6ad2ffff");
  await mkdir(folder, { recursive: true });
  await copyFile(FIXTURE, join(folder, `${JOB}.jsonl`));

  const working: JobFact = { key: "sub-6ad2ffff", name: "census kafka producer", state: "working", sessionId: JOB, wake: "run 39151289185" };
  const [fact] = await withFailedTurns([working], join(home, ".prime", "agent"), "c1");
  assert.equal(fact!.state, "failed");
  assert.equal(fact!.wake, undefined);
  assert.match(fact!.error ?? "", /rate_limit_error, 429/);

  const calls: string[] = [];
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add("c1");
  const at = Date.parse("2026-10-18T19:53:55.003Z");
  const agent = (sessionId: string, name: string): ChatAgent => ({ key: `child:sub-${sessionId}`, sessionId, childId: `sub-${sessionId}`, name, job: name, sender: name,
    link: "subagent", state: "working", lastActivityAt: new Date(at).toISOString(), steps: [] });
  const agents = [agent(JOB, "census kafka producer"), agent("w1", "census writer speed")];
  const rows = (): SessionRow[] => [row("c1", new Date(NOW).toISOString(), { chat: true, agents })];
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Census on Kafka", status: "doing", children: [
    { id: "p2", text: "Producer timeouts reach 0", status: "doing", job: "census kafka producer", sessionId: JOB, children: [] },
    { id: "p3", text: "Writer speed", status: "doing", job: "census writer speed", sessionId: "w1", children: [] }] }] };
  const threads = fakeThreads(calls);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
    { ...source(home, { c1: board }, () => NOW, rows), home });
  await chats.adopt();
  threads.fire().children("c1", agents.map(entry => ({ id: entry.childId!, label: entry.name, sessionName: entry.name, sessionId: entry.sessionId!, status: "running" as const, lastActivityAt: at })));
  calls.length = 0;
  // Its 429 names the slot it waits for, so since c7c9d5ee (10-22) it is a pool wait and gets a steer, which Prime runs at the slot: a restart
  // starts a turn the pool refuses again.
  assert.deepEqual(await chats.steerJob("c1", "census kafka producer", "Resume your step now."), { session: JOB, act: "steer" });
  assert.deepEqual(await chats.steerJob("c1", "census writer speed", "Report your numbers."), { session: "w1", act: "steer" }, "a job whose turn runs is steered");
  assert.deepEqual(calls.filter(call => /^(restart|steer|abort|resume) /.test(call)), [
    `steer ${JOB} [check-in] Resume your step now.`,
    "steer w1 [check-in] Report your numbers."]);
  chats.close();
});
