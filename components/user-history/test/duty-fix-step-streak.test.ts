// Guards d9's fix_not_moving on 10-23: the whole-streak count asked SEO guy to replace p90, the root-cause step it had started on the 04:07Z push,
// on the first d2 run that named p90, and the duty runs read CI and RepoOps' root-cause steps p360 and p361, which carry only a session id, as not live.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixNotMoving, type RedDuty } from "../scripts/duties/chat-system.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { dutyFixes } from "../src/shared/duty-fixes.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const metrics: DutyMetric[] = [{ key: "new_unindexed_3d", label: "New articles not indexed after 3 days", op: "<=", target: 0 }];
const t = (iso: string): number => Date.parse(iso);
const run = (at: string, value: number, step: string, extra: Partial<DutyRunRecord> = {}): DutyRunRecord => {
  const { metrics: results, verdict, summary } = judge(metrics, { metrics: { new_unindexed_3d: value } });
  return { duty: "d2", at: t(at), trigger: "schedule", ms: 1, verdict, metrics: results, summary,
    fixes: { new_unindexed_3d: { step, job: step === "p83" ? "new pages indexing" : "blog crawl root cause", live: true } }, ...extra };
};
const cut = { error: "pi-pool: this session waits for its slot", at: 0, provider: "anthropic" } as unknown as NonNullable<DutyRunRecord["cut"]>;

/** SEO guy's d2 runs at 05:06Z on 10-23, newest first: the first run that named p90, then p83's runs. */
const seo = (): DutyRunRecord[] => [
  run("2026-10-23T05:06:00Z", 151, "p90"),
  run("2026-10-23T03:24:00Z", 151, "p83"),
  run("2026-10-23T01:24:00Z", 151, "p83"),
  run("2026-10-22T12:00:00Z", 151, "p83"),
  run("2026-10-22T10:42:00Z", 148, "p83"),
];

function red(runs: readonly DutyRunRecord[], step: string): RedDuty {
  const metric = { ...metricStreaks(runs)[0]!, fix: { step, live: true } };
  return { chat: "seo", duty: "d2", name: "New articles get indexed", green: false, misses: metric.misses, stuck: false, metric, fix: step,
    underFix: fixStepStreak(runs, "new_unindexed_3d", step) };
}

test("a root-cause step is judged on the runs that named it, not on the streak before it", () => {
  assert.equal(metricStreaks(seo())[0]!.misses, 5);
  assert.deepEqual(fixStepStreak(seo(), "new_unindexed_3d", "p90"), { misses: 1, moved: false });
  assert.deepEqual(fixStepStreak(seo(), "new_unindexed_3d", "p83"), { misses: 4, moved: false });
  assert.deepEqual(fixNotMoving([red(seo(), "p90")], () => "SEO guy"), []);
  const later = [run("2026-10-23T11:06:00Z", 151, "p90"), run("2026-10-23T08:06:00Z", 151, "p90"), ...seo()];
  assert.equal(fixNotMoving([red(later, "p90")], () => "SEO guy")[0]?.duty, "d2", "3 misses under p90 with no move");
  const falling = [run("2026-10-23T11:06:00Z", 140, "p90"), run("2026-10-23T08:06:00Z", 151, "p90"), ...seo()];
  assert.deepEqual(fixNotMoving([red(falling, "p90")], () => "SEO guy"), [], "p90 moved the number from 151 to 140");
});

test("a new job on the same step keeps the count, and an older cut run does not count", () => {
  // api portal vp's p52 was its d1 fix from 10-21 06:11Z under one job, then another, while MetricStreak.stuck read only the newest job's runs.
  const runs = [
    run("2026-10-22T08:25:00Z", 151, "p83", { fixes: { new_unindexed_3d: { step: "p83", job: "newer job", live: true } } }),
    run("2026-10-22T06:59:00Z", 150, "p83", { cut, after: { at: t("2026-10-22T08:25:00Z"), ...judge(metrics, { metrics: { new_unindexed_3d: 151 } }) } }),
    run("2026-10-21T22:29:00Z", 149, "p83"),
    run("2026-10-21T20:29:00Z", 152, "p83"),
  ];
  assert.deepEqual(fixStepStreak(runs, "new_unindexed_3d", "p83"), { misses: 3, moved: true });
  assert.equal(metricStreaks(runs)[0]!.stuck, false, "stuck counts only the newest job's one run");
});

test("a run that found the fix step held by a For you todo ends the count", () => {
  // AI harness p919 10-23: held on Railway Breach's t11 at 08:37Z, then its job worked on it again by 09:11Z once t11 closed.
  const held = { step: "p83", live: false, hold: "t11 on thread 01a16213-54c6-73fa-b399-20e2713c41ba" };
  const runs = [
    run("2026-10-23T09:11:00Z", 151, "p83"),
    run("2026-10-23T08:37:00Z", 151, "p83", { fixes: { new_unindexed_3d: held } }),
    run("2026-10-23T04:38:00Z", 151, "p83"),
    run("2026-10-23T03:37:00Z", 151, "p83"),
    run("2026-10-22T19:30:00Z", 151, "p83"),
  ];
  assert.deepEqual(fixStepStreak(runs, "new_unindexed_3d", "p83"), { misses: 1, moved: false });
  assert.deepEqual(fixNotMoving([red(runs, "p83")], () => "AI harness"), []);
});

test("a fix step whose owner carries only a session id is live when its session works", async () => {
  const step = { id: "p360", text: "Find and fix why dev push results still take far over 10 min", status: "todo", duty: "d1/push_to_verdict_p90_min",
    sessionId: "01a166f2-219d-737b-affa-2c2349581de7", children: [] } as unknown as PlanItem;
  const board = { v: 2, rev: 1, updatedAt: "2026-10-23T05:00:00Z", todos: [], plan: [step] } as unknown as ChatBoard;
  const live = async (item: PlanItem) => item.sessionId === "01a166f2-219d-737b-affa-2c2349581de7";
  assert.deepEqual(await dutyFixes(board, "d1", ["push_to_verdict_p90_min"], live), { push_to_verdict_p90_min: { step: "p360", live: true } });
});
