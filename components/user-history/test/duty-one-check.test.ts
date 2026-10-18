// Guards one check per duty at a time. On 10-18 the Chat reopen duty of chat-057a (01a14210, d1) had a missed 12:37Z run whose job ran the
// reopen check, which passed at 15:55:17Z (clean-room/chat-reopen/20261018-1553). The job's turn ended, and at 15:55:56Z the server read
// that run's stale missed verdict and started a push run beside the job's after-job measure. The push run measured met and still started
// a job, which ran the check a second time (20261018-1556).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dailySlot, type Duty } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const MIN = 60_000;
const NOW = Date.parse("2026-10-18T15:55:56.291Z");
const MISSED = Object.fromEntries(["followup_answered", "tools_after_reopen", "chat_listed_after_reopen"]
  .map(key => [key, { value: 0, target: 1, op: ">=" as const, met: false }]));

test("a push run waits for the ended job's after-job measure and starts no second check when it reads met (10-18 15:55Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-one-check-"));
  try {
    const count = join(dir, "prechecks");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(count)}, "x");
await new Promise(done => setTimeout(done, 200));
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { followup_answered: 1, tools_after_reopen: 1, chat_listed_after_reopen: 1 } }));`);
    const store = new DutyStore(dir);
    const lastSlotAt = dailySlot("07:19", NOW);
    const duty: Duty = {
      id: "d1", name: "Chat reopen", ownerWords: "fix plan and duties based on the board skill and pursue completion of plans", goal: "a reopened chat answers",
      metrics: [
        { key: "followup_answered", label: "Follow-up answered", op: ">=", target: 1, headline: true },
        { key: "tools_after_reopen", label: "Tools after reopen", op: ">=", target: 1 },
        { key: "chat_listed_after_reopen", label: "Listed after reopen", op: ">=", target: 1 },
      ],
      schedule: { kind: "daily", at: "07:19" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "run the check",
      status: "active", createdAt: NOW - 24 * 60 * MIN, updatedAt: NOW - 24 * 60 * MIN, runCount: 1, lastSlotAt, lastRunAt: lastSlotAt,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const at = Date.parse("2026-10-18T12:37:45.189Z");
    const job = { id: "01a14f04-a48a-7478-b540-e3852727be4a", name: "chat reopen chat-057a 21:37" };
    await store.appendRun(CHAT, { duty: "d1", at, slot: at, trigger: "owner", ms: 554, verdict: "missed", metrics: MISSED, summary: "followup_answered 0", job });
    const started: string[] = [];
    const stopped: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "chat-057a", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
        ended: async last => [...last],
        stop: async ended => { stopped.push(ended.id); },
      },
      checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    await duties.tick();
    await duties.settled();
    await duties.tick();
    await duties.settled();
    duties.close();
    const runs = await store.runs(CHAT);
    assert.equal((await readFile(count, "utf8")).length, 1, "the duty's check ran more than once");
    assert.deepEqual(started, []);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.after?.verdict, "met");
    assert.deepEqual(stopped, [job.id]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an after-job measure that finds a run of its duty going waits for it and takes that run's measure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-one-check-reverse-"));
  try {
    const count = join(dir, "prechecks");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(count)}, "x");
await new Promise(done => setTimeout(done, 200));
writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { followup_answered: 1, tools_after_reopen: 1, chat_listed_after_reopen: 1 } }));`);
    const store = new DutyStore(dir);
    const lastSlotAt = dailySlot("07:19", NOW);
    await store.update(CHAT, duties => { duties.push({
      id: "d1", name: "Chat reopen", ownerWords: "pursue completion of plans", goal: "a reopened chat answers",
      metrics: [{ key: "followup_answered", label: "Follow-up answered", op: ">=", target: 1, headline: true }],
      schedule: { kind: "daily", at: "07:19" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "run the check",
      status: "active", createdAt: NOW - 24 * 60 * MIN, updatedAt: NOW - 24 * 60 * MIN, runCount: 1, lastSlotAt, lastRunAt: lastSlotAt }); });
    const at = NOW - 30 * MIN;
    const job = { id: "job-0", name: "chat reopen chat-057a 00:25" };
    await store.appendRun(CHAT, { duty: "d1", at, slot: at, trigger: "owner", ms: 554, verdict: "missed", metrics: MISSED, summary: "followup_answered 0", job });
    let asked!: () => void;
    const endedAsked = new Promise<void>(done => { asked = done; });
    let answer!: () => void;
    const answered = new Promise<void>(done => { answer = done; });
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => NOW, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "chat-057a", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
        ended: async last => { asked(); await answered; return [...last]; },
        stop: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    });
    const tick = duties.tick();
    await endedAsked;
    assert.equal(await duties.runNow(CHAT, "d1"), true);
    answer();
    await tick;
    await duties.settled();
    duties.close();
    const runs = await store.runs(CHAT);
    assert.equal((await readFile(count, "utf8")).length, 1, "the duty's check ran more than once");
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.after?.at, runs[0]!.at);
    assert.equal(runs[1]!.after?.verdict, "met");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
