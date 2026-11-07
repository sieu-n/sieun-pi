// Replays the AI harness chat's Wiki dream (d4) from 11-05 17:55Z to 11-07 03:38Z. The 17:55:07Z verify run read wiki_problems 0 with every part on
// target and started "wiki dream AI harness developer environment 02:55", whose first model call at 17:55:51Z pi-pool parked for an 18:10Z slot.
// The job was archived at 18:00:43Z as cut, and pi-pool did not admit its tree again, so its rerun never came. The push gave up beside any cut
// run waiting for its rerun, so no run read d4 until the 16:30:18Z schedule run of 11-06, which read wiki_problems 29. That run's job was cut
// at 16:35:31Z for a 16:40Z slot, and no run read d4 again until its rerun at 03:38:24Z on 11-07, which read 43. A cut job now gets the push
// runs as reads while pi-pool holds its tree in its line, and is replaced once no line holds it; a missed duty with parts is read every
// PART_READ_MS, also while a fix step on its metric has a live job.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PART_READ_MS } from "../src/duty-push.ts";
import { Duties, IN_POOL_LINE, NOTHING_DUE } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty, DutyJobRef, DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { CheckInView, PlanItem } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const NO_TOKEN = "token hook gave no token (credential_unavailable): pi-pool: this session waits for its slot";

type Run = { at: number; trigger: DutyRunRecord["trigger"]; problems: number; job: DutyJobRef; cutAt: number; slotAt: number };

async function replay(run: Run, fixLive: boolean, body: (at: { tick: (now: number, problems: number, following: number) => Promise<void>; runs: () => Promise<DutyRunRecord[]>;
  retired: string[]; started: string[] }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duty-cut-push-read-"));
  try {
    const out = join(dir, "out.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE);`);
    const store = new DutyStore(dir);
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles and whcih articles exist itself should always be up to date", goal: "no page behind code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 24 * 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Rewrite each page behind code.", status: "active", createdAt: run.at - 48 * 60 * MIN, updatedAt: run.at - 48 * 60 * MIN, runCount: 0,
      lastRunAt: run.at,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const result = (value: number) => ({ value, target: 0, op: "<=" as const, met: value <= 0 });
    await store.appendRun(CHAT, { duty: "d4", at: run.at, slot: run.at, trigger: run.trigger, ms: 43_000, verdict: run.problems ? "missed" : "met",
      summary: `wiki_problems ${run.problems}`, metrics: { wiki_problems: result(run.problems) }, parts: { wiki_problems_following: result(0) }, job: run.job,
      cut: { error: NO_TOKEN, at: run.cutAt, provider: "anthropic", slotAt: run.slotAt } });
    let now = run.at;
    const retired: string[] = [];
    const started: string[] = [];
    // pi-pool keeps a cut tree's wait in its line until 15 min past its slot (WAIT_STALE_SEC), and admitted neither tree in the window.
    const inLine = run.trigger === "schedule" ? () => true : () => now < run.slotAt + 15 * MIN;
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }),
        working: async () => false, kept: async () => null, reported: async () => false, repliedSince: async () => false, steer: async () => {},
        retire: async job => { retired.push(job.id); },
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
      },
      poolAdmits: async () => false,
      poolHolds: async tree => tree === run.job.id && inLine() ? "line" : null,
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: fixLive ? [FIX] : [] }),
      fixLive: async () => fixLive,
    });
    const tick = async (at: number, problems: number, following: number) => {
      now = at;
      await writeFile(out, JSON.stringify({ metrics: { wiki_problems: problems, wiki_problems_following: following } }));
      await duties.tick();
      await duties.settled();
    };
    const runs = async () => (await store.runs(CHAT)).filter(entry => entry.duty === "d4");
    try { await body({ tick, runs, retired, started }); } finally { duties.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const FIX = { id: "p1455", text: "d4 gets a push read every 15 min", status: "doing", job: "d4 push reads gap 11-07", duty: "d4/wiki_problems", children: [] } as PlanItem;

const VERIFY: Run = {
  at: Date.parse("2026-11-05T17:55:07.223Z"), trigger: "verify", problems: 0, job: { id: "01a1ab2f-verify-0255", name: "wiki dream AI harness developer environment 02:55" },
  cutAt: Date.parse("2026-11-05T17:55:51.346Z"), slotAt: Date.parse("2026-11-05T18:10:00Z"),
};

test("a met duty with parts gets its part reads beside a cut job pi-pool holds in its line, then replaces it (Wiki dream, 11-05 18:11Z to 18:43Z)", async () => {
  await replay(VERIFY, false, async ({ tick, runs, retired, started }) => {
    await tick(VERIFY.at + PART_READ_MS + MIN, 0, 0);
    let read = await runs();
    assert.equal(read.length, 2, "the push run reads d4 while the cut run waits for its rerun");
    assert.equal(read[0]!.trigger, "push");
    assert.ok(read[0]!.summary.includes(IN_POOL_LINE), read[0]!.summary);
    assert.deepEqual(started, [], "a new job would queue behind the cut job's 18:10Z cell");
    await tick(VERIFY.at + 2 * (PART_READ_MS + MIN), 0, 0);
    read = await runs();
    assert.equal(read.length, 3, "the next part read comes PART_READ_MS later");
    assert.ok(read[0]!.summary.includes(NOTHING_DUE), read[0]!.summary);
    assert.deepEqual(retired, [VERIFY.job.id], "a cut job no line holds no longer keeps the duty");
    await tick(VERIFY.at + 3 * (PART_READ_MS + MIN), 0, 2);
    assert.equal((await runs()).length, 4);
    assert.equal(started.length, 1, "a page behind gets a writer at the next part read");
  });
});

const SCHEDULE: Run = {
  at: Date.parse("2026-11-06T16:30:18.678Z"), trigger: "schedule", problems: 29, job: { id: "01a1b1b3-01fe-731a-910e-727e1965dd4c", name: "wiki dream AI harness developer environment 11-07 01:30" },
  cutAt: Date.parse("2026-11-06T16:35:31.305Z"), slotAt: Date.parse("2026-11-06T16:40:00Z"),
};

test("a missed duty with parts is read every PART_READ_MS beside its cut job, not hourly (Wiki dream, 11-06 16:46Z)", async () => {
  await replay(SCHEDULE, false, async ({ tick, runs, started }) => {
    await tick(SCHEDULE.at + PART_READ_MS + MIN, 31, 2);
    let read = await runs();
    assert.equal(read.length, 2, "the push run reads d4 15 min after the schedule run");
    assert.equal(read[0]!.verdict, "missed");
    assert.ok(read[0]!.summary.includes(IN_POOL_LINE), read[0]!.summary);
    await tick(SCHEDULE.at + 2 * (PART_READ_MS + MIN), 33, 1);
    read = await runs();
    assert.equal(read.length, 3, "and again PART_READ_MS later");
    assert.equal(read[0]!.metrics.wiki_problems?.value, 33);
    assert.deepEqual(started, []);
  });
});

test("a missed duty with parts is read beside a live fix step on its metric (Wiki dream, 11-07 04:00Z)", async () => {
  await replay(SCHEDULE, true, async ({ tick, runs }) => {
    await tick(SCHEDULE.at + PART_READ_MS + MIN, 43, 2);
    const read = await runs();
    assert.equal(read.length, 2, "the fix job works on the code, and the duty's own job works the pages");
    assert.equal(read[0]!.trigger, "push");
  });
});
