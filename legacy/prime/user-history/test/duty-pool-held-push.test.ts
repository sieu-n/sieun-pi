// Replays the AI harness chat's Wiki dream (d4) on 11-05. Its 14:55:41Z push run read wiki_problems_following 3 and started "wiki dream AI harness
// developer environment 23:55", whose first model call at 14:56:43Z pi-pool parked for a 17:03:30Z slot on claude8: no account vended a token
// from 14:52:12Z to 17:00:03Z. The chat's revive held the job for that slot ("waits on pi-pool for its slot"), so the push gave up beside it and
// no run read d4 until the 16:30:07Z schedule run, while 9 pages crossed their follow window from 15:25Z to 16:03Z. That run replaced the held
// job as stalled, and the new job got a later slot and its first account at 17:34:21Z. A held job now gets the push run as a read, and keeps
// the duty, like a job in pi-pool's line, until STUCK_MAX_MS.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PART_READ_MS } from "../src/duty-push.ts";
import { Duties, STUCK_MAX_MS } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { type Duty, type DutyJobRef, STILL_WORKING } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const JOB: DutyJobRef = { id: "01a1ac36-48aa-72af-9e76-bf394efe069a", name: "wiki dream AI harness developer environment 23:55" };
const RUN_AT = Date.parse("2026-11-05T14:55:41.394Z");
const HELD = "waits on pi-pool for its slot";

async function replay(body: (at: { tick: (now: number, problems: number, following: number, scheduled?: boolean) => Promise<void>; store: DutyStore;
  retired: string[]; started: string[] }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "duty-pool-held-push-"));
  try {
    const out = join(dir, "out.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE);`);
    const store = new DutyStore(dir);
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles and whcih articles exist itself should always be up to date", goal: "no page behind code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 24 * 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Rewrite each page behind code.", status: "active", createdAt: RUN_AT - 48 * 60 * MIN, updatedAt: RUN_AT - 48 * 60 * MIN, runCount: 0,
      lastRunAt: RUN_AT,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const result = (value: number) => ({ value, target: 0, op: "<=" as const, met: value <= 0 });
    await store.appendRun(CHAT, { duty: "d4", at: RUN_AT, slot: RUN_AT, trigger: "push", ms: 58_946, verdict: "met", summary: "wiki_problems 0 (on target); all 4 on target",
      metrics: { wiki_problems: result(0) }, parts: { wiki_problems_following: result(3) }, job: JOB });
    let now = RUN_AT;
    const retired: string[] = [];
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment VP", cwd: dir, board: id }),
        working: async job => job.id === JOB.id && !retired.includes(job.id),
        kept: async job => job.id === JOB.id && !retired.includes(job.id) ? HELD : null,
        reported: async () => false, repliedSince: async () => false, steer: async () => {},
        retire: async job => { retired.push(job.id); },
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    const tick = async (at: number, problems: number, following: number, scheduled = false) => {
      now = at;
      await writeFile(out, JSON.stringify({ metrics: { wiki_problems: problems, wiki_problems_following: following } }));
      if (scheduled) assert.ok(await duties.runNow(CHAT, "d4"));
      else await duties.tick();
      await duties.settled();
    };
    try { await body({ tick, store, retired, started }); } finally { duties.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a met duty with parts gets its part reads beside a job pi-pool holds for its slot (Wiki dream, 11-05 15:11Z to 16:03Z)", async () => {
  await replay(async ({ tick, store, retired, started }) => {
    await tick(RUN_AT + PART_READ_MS + MIN, 0, 6);
    let runs = (await store.runs(CHAT)).filter(run => run.duty === "d4");
    assert.equal(runs.length, 2, "the push run reads d4 beside the held job");
    assert.equal(runs[0]!.trigger, "push");
    assert.equal(runs[0]!.summary.endsWith(`${STILL_WORKING} (job ${JOB.name} ${HELD})`), true, runs[0]!.summary);
    await tick(Date.parse("2026-11-05T16:04:00Z"), 9, 0);
    runs = (await store.runs(CHAT)).filter(run => run.duty === "d4");
    assert.equal(runs[0]!.verdict, "missed", "the pages past their follow window count once they do, not at the next schedule run");
    assert.deepEqual(retired, []);
    assert.deepEqual(started, []);
  });
});

test("a job pi-pool holds for its slot is not replaced as stalled after 90 min with no reply (Wiki dream, 11-05 16:30Z)", async () => {
  await replay(async ({ tick, store, retired, started }) => {
    await tick(Date.parse("2026-11-05T16:30:07Z"), 9, 0, true);
    const latest = (await store.runs(CHAT)).find(run => run.duty === "d4")!;
    assert.ok(latest.summary.includes(`${STILL_WORKING} (job ${JOB.name} ${HELD})`), latest.summary);
    assert.deepEqual(retired, [], "a new job would queue behind the held job's 17:03:30Z slot");
    assert.deepEqual(started, []);
  });
});

test("a job pi-pool holds for its slot is replaced as stalled once STUCK_MAX_MS has passed since its run started", async () => {
  await replay(async ({ tick, retired, started }) => {
    await tick(RUN_AT + STUCK_MAX_MS + MIN, 9, 0);
    assert.deepEqual(retired, [JOB.id]);
    assert.equal(started.length, 1);
  });
});
