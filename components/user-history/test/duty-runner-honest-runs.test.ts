// Guards four duty runner faults found by the duty failures page on 2026-10-18. Whole system (AI harness chat) got 30 skipped records in 72
// runs from 10-15 to 10-18, one per slot that came while a run's job start waited up to 2 h. GeoNode proxy use read working_exits_dropped
// 999999 in every run and counted it as a miss. Wiki dream's 10-18 04:23Z run on us-metal02 failed git log on ~/Documents/Github/sieun-pi, a Mac path. At 05:20Z
// 8 red duties had no live fix job and nothing ran them until their next daily slot, so a red duty now gets a push run.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dailySlot, type Duty, type DutyMetric, judge } from "../src/shared/chat-duties.ts";
import type { ChatBoard, CheckInView, PlanItem } from "../src/shared/types.ts";
import { piCheckout } from "../scripts/duties/wiki-dream.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;

test("a slot that comes while the last run is starting its job gets no skipped record and moves the schedule on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-start-wait-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { clean_min_30: 2 } }));`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-16T14:23:00Z");
    const duty: Duty = {
      id: "d7", name: "Whole system", ownerWords: "reorganize duties have a 30 minute trigger that checks all this", goal: "clean minutes",
      metrics: [{ key: "clean_min_30", label: "Clean minutes", op: ">=", target: 30, headline: true }], schedule: { kind: "every", minutes: 30 },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active",
      createdAt: now - 31 * MIN, updatedAt: now - 31 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    let startCalled!: () => void;
    const called = new Promise<void>(done => { startCalled = done; });
    let finishStart!: () => void;
    const finished = new Promise<void>(done => { finishStart = done; });
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { startCalled(); await finished; return { id: "job-1", name }; },
      },
    });
    await duties.tick();
    await called;
    for (const step of [30, 60, 90]) {
      now = Date.parse("2026-10-16T14:23:00Z") + step * MIN + 1000;
      await duties.tick();
    }
    finishStart();
    await duties.settled();
    const runs = await store.runs(CHAT);
    assert.deepEqual(runs.map(run => run.verdict), ["missed"]);
    assert.equal(runs[0]!.job?.id, "job-1");
    const [after] = await store.list(CHAT);
    assert.equal(after!.lastRunAt, now);
    assert.equal(after!.lastSkippedAt, undefined);
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const GEONODE: DutyMetric[] = [
  { key: "retry_extra_s", label: "Worst delay", op: "<=", target: 5, unit: " s", headline: true },
  { key: "supply_hold_minutes", label: "Supply hold minutes", op: "<=", target: 0, unit: " min" },
  { key: "working_exits_dropped", label: "Census exits dropped", op: "<=", target: 0 },
];
const GAP = { kind: "gap", excerpt: "working_exits_dropped: prod ClickHouse has no crawler.sticky_walks table yet" };

test("a placeholder 999999 is not measured, never a missed metric, and the summary says why", () => {
  const judged = judge(GEONODE, { metrics: { retry_extra_s: 9.3, supply_hold_minutes: 0, working_exits_dropped: 999_999 }, flagged: [GAP] });
  assert.equal(judged.verdict, "missed");
  assert.deepEqual(Object.keys(judged.metrics).sort(), ["retry_extra_s", "supply_hold_minutes"]);
  assert.doesNotMatch(judged.summary, /working_exits_dropped 999999/);
  assert.match(judged.summary, /not measured: the precheck wrote the placeholder 999999 for working_exits_dropped \(working_exits_dropped: prod ClickHouse has no crawler\.sticky_walks table yet\)/);
  assert.equal(judge(GEONODE, { metrics: { retry_extra_s: 1, supply_hold_minutes: 0, working_exits_dropped: 999_999 }, flagged: [GAP] }).verdict, "met");
});

test("a run whose counted metrics are all placeholders is an error that names the source errors", () => {
  const judged = judge(GEONODE, { metrics: { retry_extra_s: 999_999, supply_hold_minutes: 999_999, working_exits_dropped: -999_999 },
    flagged: [{ kind: "source_error", excerpt: "census reads: fetch failed" }, { kind: "source_error", excerpt: "supply holds: fetch failed" }, { kind: "detail", excerpt: "no target" }] });
  assert.equal(judged.verdict, "error");
  assert.equal(judged.summary, "the precheck wrote the placeholder 999999 for retry_extra_s, supply_hold_minutes, working_exits_dropped (census reads: fetch failed; supply holds: fetch failed)");
});

test("wiki-dream finds the sieun-pi checkout from a release folder on any box", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "pi-checkout-")));
  try {
    const checkout = join(dir, "src/sieun-pi");
    const release = join(dir, ".local/share/sieun-pi-chat/release-082cdd4");
    await mkdir(join(checkout, ".git"), { recursive: true });
    await mkdir(join(checkout, "node_modules"), { recursive: true });
    await mkdir(join(release, "components/user-history/scripts/duties"), { recursive: true });
    await symlink(join(checkout, "node_modules"), join(release, "node_modules"));
    await mkdir(join(checkout, "components/user-history/scripts/duties"), { recursive: true });
    assert.equal(piCheckout(join(release, "components/user-history/scripts/duties"), undefined), checkout);
    assert.equal(piCheckout(join(checkout, "components/user-history/scripts/duties"), undefined), checkout);
    assert.equal(piCheckout(join(release, "components/user-history/scripts/duties"), "/elsewhere/sieun-pi"), "/elsewhere/sieun-pi");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const PUSH_NOW = Date.parse("2026-10-18T05:20:00Z");
const RED = { clean_min_30: { value: 2, target: 30, op: ">=" as const, met: false } };

/** A daily duty that is not due, one missed run 3 h old with an ended job, and the chat's check-in every 2 h; `change` sets up each case. */
async function pushCase(change: { after?: "met"; working?: boolean; liveFix?: boolean; lastAgoMin?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "duty-push-"));
  const precheck = join(dir, "precheck.mjs");
  await writeFile(precheck, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { clean_min_30: 2 } }));`);
  const store = new DutyStore(dir);
  const lastSlotAt = dailySlot("07:00", PUSH_NOW);
  const duty: Duty = {
    id: "d1", name: "Portal stays up", ownerWords: "keep the portal up", goal: "clean minutes",
    metrics: [{ key: "clean_min_30", label: "Clean minutes", op: ">=", target: 30, headline: true }], schedule: { kind: "daily", at: "07:00" },
    precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active",
    createdAt: PUSH_NOW - 3 * 24 * 60 * MIN, updatedAt: PUSH_NOW - 3 * 24 * 60 * MIN, runCount: 1, lastSlotAt, lastRunAt: lastSlotAt,
  };
  await store.update(CHAT, duties => { duties.push(duty); });
  const at = PUSH_NOW - (change.lastAgoMin ?? 180) * MIN;
  await store.appendRun(CHAT, { duty: "d1", at, slot: at, trigger: "schedule", ms: 1000, verdict: "missed", metrics: RED, summary: "clean_min_30 2 < 30",
    job: { id: "job-0", name: "Portal stays up 1" },
    ...change.after ? { after: { at: at + 30 * MIN, verdict: "met" as const, metrics: { clean_min_30: { ...RED.clean_min_30, value: 31, met: true } }, summary: "met" } } : {} });
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [],
    plan: [{ id: "p7", text: "Fix the portal", status: "doing", job: "fix-job", duty: "d1/clean_min_30", children: [] } as PlanItem] };
  const started: string[] = [];
  const lines: string[] = [];
  const duties = new Duties(store, {
    isChat: async () => true, now: () => PUSH_NOW, tickMs: 0, node: process.execPath, log: line => lines.push(line),
    jobs: {
      chat: async id => ({ id, name: "Ops", cwd: dir, board: id }),
      working: async () => change.working ?? false,
      retire: async () => {},
      start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
    },
    checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    board: async () => board,
    fixLive: async () => change.liveFix ?? false,
  });
  await duties.tick();
  await duties.settled();
  const runs = await store.runs(CHAT);
  const [after] = await store.list(CHAT);
  duties.close();
  await rm(dir, { recursive: true, force: true });
  return { runs, after: after!, started, lines, lastSlotAt };
}

test("a red daily duty with no job at work gets a push run at the check-in interval, and its schedule stays", async () => {
  const { runs, after, started, lines, lastSlotAt } = await pushCase();
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.trigger, "push");
  assert.equal(runs[0]!.verdict, "missed");
  assert.equal(runs[0]!.slot, PUSH_NOW);
  assert.equal(runs[0]!.job?.id, "job-1");
  assert.equal(started.length, 1);
  assert.equal(after.lastSlotAt, lastSlotAt);
  assert.equal(after.lastRunAt, lastSlotAt);
  assert.ok(lines.some(line => line.includes("red on clean_min_30") && line.includes("a push run starts")));
});

test("no push run when the after-job measure is met, a fix job is live, the last job works, or the newest run is younger than the interval", async () => {
  for (const change of [{ after: "met" as const }, { liveFix: true }, { working: true }, { lastAgoMin: 60 }]) {
    const { runs, started } = await pushCase(change);
    assert.equal(runs.length, 1, JSON.stringify(change));
    assert.equal(started.length, 0, JSON.stringify(change));
  }
});
