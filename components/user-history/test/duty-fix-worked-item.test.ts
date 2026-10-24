// Guards d9's fix_not_moving on 10-24: Crawler VP's d9 read throughput_goals_missed 3 then 4 under p942, a count of goals missed, so d9 asked
// to replace p942 while p850, the goal p942 works, went from 135 to 159 walks a minute against 252; and d5's crawler_risks_firing, a 0-or-1
// count, read 1 under p952 while p952's own number, us-metal01 nvme0n1 writes, went from 6.48 to 4.35 TB a day against 4.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixNotMoving, itemsAbove, type RedDuty } from "../scripts/duties/chat-system.ts";
import { report } from "../scripts/duties/throughput-goal.ts";
import { judge, type DutyMetric, type DutyRunRecord, type FixLink, type PrecheckOutput } from "../src/shared/chat-duties.ts";
import { dutyFixes } from "../src/shared/duty-fixes.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const t = (iso: string): number => Date.parse(iso);
const goals: DutyMetric[] = [{ key: "throughput_goals_missed", label: "Throughput goals on the board that prod misses", op: "<=", target: 0, headline: true }];
const p942: FixLink = { step: "p942", job: "meta ads walk backlog 10-24", live: true };

/** One d9 run of Crawler VP: the count of goals missed and p850's walks a minute against its goal, or no items as before this change. */
const d9 = (at: string, missed: number, walks: number | null, target: number, fix: FixLink | null = p942): DutyRunRecord => {
  const output: PrecheckOutput = { metrics: { throughput_goals_missed: missed }, ...walks === null ? {} : { items: { p850: { value: walks, target, op: ">=" } } } };
  return { duty: "d9", at: t(at), trigger: "verify", ms: 1, ...judge(goals, output), ...fix ? { fixes: { throughput_goals_missed: fix } } : {} };
};
/** Crawler VP's d9 runs from 03:29Z to 16:29Z on 10-24, newest first, with p850's walks from each run's precheck output. */
const crawler = (walks: readonly number[] = [159, 157, 150, 135]): DutyRunRecord[] => [
  d9("2026-10-24T16:29:00Z", 4, walks[0]!, 252),
  d9("2026-10-24T15:58:00Z", 4, walks[1]!, 252),
  d9("2026-10-24T12:12:00Z", 3, walks[2]!, 256, null),
  d9("2026-10-24T03:29:00Z", 3, walks[3]!, 261),
];
const step = (id: string, children: PlanItem[] = [], extra: Partial<PlanItem> = {}): PlanItem =>
  ({ id, text: id, status: "doing", children, ...extra }) as unknown as PlanItem;
const board = { v: 2, rev: 1, updatedAt: "2026-10-24T16:30:00Z", todos: [],
  plan: [step("p850", [step("p942", [], { duty: "d9/throughput_goals_missed", job: "meta ads walk backlog 10-24" })])] } as unknown as ChatBoard;

function red(runs: readonly DutyRunRecord[], key: string, fix: string, above: readonly string[]): RedDuty {
  const metric = { ...metricStreaks(runs).find(streak => streak.key === key)!, fix: { step: fix, live: true } };
  return { chat: "crawler", duty: runs[0]!.duty, name: "Throughput goal achieved", green: false, misses: metric.misses, stuck: false, metric, fix,
    underFix: fixStepStreak(runs, key, fix, above) };
}

test("a fix of one goal is judged on that goal's number, not on the count of goals missed", () => {
  assert.deepEqual(itemsAbove(board, "p942"), ["p850"]);
  assert.deepEqual(fixStepStreak(crawler(), "throughput_goals_missed", "p942"), { misses: 3, moved: false }, "the count went 3 to 4");
  assert.deepEqual(fixStepStreak(crawler(), "throughput_goals_missed", "p942", ["p850"]),
    { misses: 3, moved: true, worked: { item: "p850", from: 135, to: 159, target: 252 } });
  assert.deepEqual(fixNotMoving([red(crawler(), "throughput_goals_missed", "p942", ["p850"])], () => "Crawler VP"), []);
});

test("a fix whose own goal does not move stays counted, and the line names that goal", () => {
  const stalled = [d9("2026-10-24T16:29:00Z", 4, 135, 252), d9("2026-10-24T15:58:00Z", 4, 135, 252), d9("2026-10-24T03:29:00Z", 3, 135, 252)];
  const [found] = fixNotMoving([red(stalled, "throughput_goals_missed", "p942", ["p850"])], () => "Crawler VP");
  assert.match(found?.line ?? "", /p850, the item p942 works, read 135 against 252, no closer than its 135/);
});

test("runs with no item reading judge the lead metric as before", () => {
  const old = crawler().map(run => { const { items: _items, ...rest } = run; return rest; });
  assert.deepEqual(fixStepStreak(old, "throughput_goals_missed", "p942", ["p850"]), { misses: 3, moved: false });
  assert.equal(fixNotMoving([red(old, "throughput_goals_missed", "p942", ["p850"])], () => "Crawler VP").length, 1);
});

test("a fix with its own measured target is judged on that target's history in the runs", () => {
  const risks: DutyMetric[] = [{ key: "crawler_risks_firing", label: "Risks whose alert fires now", op: "<=", target: 0 }];
  const d5 = (at: string, writes: number): DutyRunRecord => ({ duty: "d5", at: t(at), trigger: "owner", ms: 1, ...judge(risks, { metrics: { crawler_risks_firing: 1 } }),
    fixes: { crawler_risks_firing: { step: "p952", job: "nvme0 and root disk writes root cause", live: true, target: { current: writes, target: 4, direction: "down" } } } });
  const falling = [d5("2026-10-24T16:52:00Z", 4.35), d5("2026-10-24T16:25:00Z", 3.9), d5("2026-10-24T14:33:00Z", 6.48)];
  assert.deepEqual(fixStepStreak(falling, "crawler_risks_firing", "p952"), { misses: 3, moved: true, worked: { item: "p952", from: 6.48, to: 4.35, target: 4 } });
  const flat = [d5("2026-10-24T16:52:00Z", 6.48), d5("2026-10-24T16:25:00Z", 6.5), d5("2026-10-24T14:33:00Z", 6.48)];
  assert.equal(fixStepStreak(flat, "crawler_risks_firing", "p952").moved, false);
  const under = [d5("2026-10-24T19:03:00Z", 2.0), d5("2026-10-24T18:20:00Z", 3.86), d5("2026-10-24T14:33:00Z", 4.5)];
  assert.equal(fixStepStreak(under, "crawler_risks_firing", "p952").moved, true, "a number past its own target counts as moved, though it lies further from 4 than 4.5 did");
});

test("the duty records each goal's number, and a run records its fix step's measured target", async () => {
  const judged = judge(goals, { metrics: { throughput_goals_missed: 1 }, items: { p850: { value: 159, target: 252, op: ">=" }, p826: { value: Number.NaN, target: 1, op: ">=" } } });
  assert.deepEqual(judged.items, { p850: { value: 159, target: 252, op: ">=", met: false } });
  const out = report({ now: t("2026-10-24T16:29:00Z"), errors: [], geoFrom: 0, geoTo: 0, board: [{ id: "p850", text: "Meta Ads", target: { target: 7 } }] as never,
    meta: { due: 2_537_866, finished24h: 159 * 1440 } } as never, goals);
  assert.equal(out.items?.p850?.value, 159);
  assert.equal(Math.round(out.items?.p850?.target ?? 0), 252);
  const target = { metric: "nvme0n1 writes, 1 h rate", target: 4, unit: "TB/day", current: 4.35, measuredAt: "2026-10-24T16:52:00.000Z", direction: "down" };
  const fixBoard = { ...board, plan: [step("p952", [], { duty: "d5/crawler_risks_firing", job: "nvme0 root cause", target } as Partial<PlanItem>)] } as unknown as ChatBoard;
  assert.deepEqual(await dutyFixes(fixBoard, "d5", ["crawler_risks_firing"], async () => true),
    { crawler_risks_firing: { step: "p952", job: "nvme0 root cause", live: true, target: { current: 4.35, target: 4, direction: "down", measuredAt: "2026-10-24T16:52:00.000Z" } } });
});
