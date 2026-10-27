// metal-management on 10-27: the chat was told "prod off metal02 code ended with p132 open" at about 17:10Z and kept p132 on that job, which
// last wrote at 17:27:26Z, waiting on the crawler ops train's p1020 with no board.wake, and the idle unload stopped it at 17:29:50Z. The owner
// had paused the chat's check-in, the end notice fires once, and nothing else told the chat until d9 read p132 stuck at 18:48Z
// (stuck_steps_all 1). frontend bro's p352 to p354 went the same way between 14:44Z and 17:57Z.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";
import { dutySink, fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
const JOB = "01a17d74-1f46-74e1-b2c8-58b10ee130f2";
const ended = "2026-10-27T17:27:26.195Z";
const MIN = 60_000;
const TITLE = "Move every prod workload off us-metal02 onto us-metal01";
const p132 = (fields: Partial<PlanItem> = {}): PlanItem => ({ id: "p132", text: TITLE, status: "doing",
  job: "prod off metal02 code", sessionId: JOB, waitFor: "the crawler ops train's p1020 going live with the c180 commits", children: [], ...fields });
const job = (fields: Partial<ChatAgent> = {}): ChatAgent => ({ key: "child:sub-1", childId: "sub-1", sessionId: JOB, name: "prod off metal02 code", job: "sub-1",
  sender: "prod off metal02 code", link: "subagent", state: "idle", steps: ["p132"], lastActivityAt: ended, ...fields });

interface Rig { steps?: PlanItem[]; todos?: ChatBoard["todos"]; agents?: ChatAgent[]; paused?: boolean; minutes?: number[]; duty?: string[] }

/** The steers the chat gets over one tick at each of `minutes` after the job's last write. */
async function told({ steps = [p132()], todos = [], agents = [job()], paused = true, minutes = [33], duty }: Rig): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "unmoved-steps-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add(CHAT);
    await writeFile(join(dir, "check-in-settings.json"), JSON.stringify({ [CHAT]: paused ? { everyMs: 7_200_000, pausedUntil: "forever", pausedBy: "owner" } : { everyMs: 21_600_000 } }));
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: ended, todos, plan: steps };
    let now = Date.parse(ended);
    const rows = (): SessionRow[] => [row(CHAT, "2026-10-27T17:26:00Z", { chat: true, agents })];
    const calls: string[] = [];
    const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, { [CHAT]: board }, () => now, rows), duty: dutySink().duty, ...duty ? { dutyJobs: async () => duty } : {} }, () => {});
    await chats.adopt();
    for (const minute of minutes) {
      now = Date.parse(ended) + minute * MIN;
      await chats.tick();
      await chats.settled();
      await chats.settled();
    }
    chats.close();
    return calls.filter(call => call.startsWith(`steer ${CHAT} `) && call.includes("no live owner"));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a step whose job stopped writing over 30 min ago with no wake is told to its owner-paused chat", async () => {
  const lines = await told({});
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /This open step has no live owner: nobody wrote on it for 30 min, and no board\.wake, pi-pool slot or open For you todo holds it, so d9 counts it as stuck: p132 "Move every prod workload off us-metal02 onto us-metal01" waits for "the crawler ops train.*" \(prod off metal02 code, quiet since \d\d:\d\d\)\. Give each one a live owner now/);
});

test("a step is not told while its job wrote within 30 min, sleeps on a board.wake, waits for a pool slot or has a subagent at work", async () => {
  assert.deepEqual(await told({ minutes: [20] }), []);
  assert.deepEqual(await told({ agents: [job({ state: "working", wait: "waits until 19:00Z" })] }), []);
  assert.deepEqual(await told({ agents: [job({ queued: { position: 3, total: 9, since: Date.parse(ended) } })] }), []);
  assert.deepEqual(await told({ agents: [job({ subagentsRunning: 2 })] }), []);
});

test("a step an open For you todo holds, or a chat whose duty job works, is not told", async () => {
  assert.deepEqual(await told({ steps: [p132({ waitFor: "t14" })], todos: [{ id: "t14", text: "Scale media to 18?", from: "agent", done: false, step: "p132", at: ended }] }), []);
  const checkIn: ChatAgent = { key: "thread:01a17e00-0000-7000-8000-000000000001", sessionId: "01a17e00-0000-7000-8000-000000000001", name: "check-in mm 18:00",
    job: "session:01a17e00", sender: "check-in mm 18:00", link: "root", state: "working", steps: [] };
  assert.deepEqual(await told({ agents: [job(), checkIn], duty: [checkIn.sessionId!] }), []);
});

test("the same unmoved steps are told again each live window, and a chat whose check-in runs is told too", async () => {
  assert.equal((await told({ minutes: [33, 40, 50, 62] })).length, 1, "within 30 min of the last notice the same set is not told again");
  assert.equal((await told({ minutes: [33, 64] })).length, 2);
  assert.equal((await told({ paused: false })).length, 1, "vent's check-in runs every 6 h, so the chat hears it first");
});

test("a step with no owner, or one handed back to a chat that went quiet, is told", async () => {
  const lines = await told({ steps: [{ id: "p132", text: TITLE, status: "doing", children: [] }], agents: [] });
  assert.match(lines[0] ?? "", /p132 "Move every prod workload.*" is doing \(no owner\)/);
  assert.match((await told({ steps: [{ id: "p132", text: TITLE, status: "doing", job: CHAT, children: [] }], agents: [] }))[0] ?? "", /\(01a14d31-6ec0-7005-bbe8-c38b7ae73cfb, quiet since \d\d:\d\d\)/);
});
