// Guards d9's read of Crawler VP's d9 when only the census writer row misses (p895, under p1022). The row counts the worst five-minute slot
// of 24 h, and the precheck dates the miss at the newest counted slot over 5,000. On 10-27 at 00:25Z d9 read fix_not_moving 1 on it, because
// the headline carried no lastEventAt; 07e5b4d4 added it. The key throughput_goals_missed names no window, so d9 still printed no clear time
// and no push read the duty when that slot left the window, until the precheck named the window too (windowMs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, agingUntil, fixNotMoving, type RedDuty } from "../scripts/duties/chat-system.ts";
import { agedOut } from "../src/duty-push.ts";
import { judge, type DutyMetric, type DutyRunRecord, type FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";

const t = (iso: string): number => Date.parse(`2026-${iso}Z`);
const DAY = 24 * 3_600_000;
const goals: DutyMetric[] = [{ key: "throughput_goals_missed", label: "Throughput goals on the board that prod misses", op: "<=", target: 0, headline: true }];
const p1022: FixLink = { step: "p1022", job: "census pg writer root cause", live: true };

/** One d9 run: one goal missed, p895 at 214,542, and the newest counted slot over 5,000 with the window the precheck names. */
const d9 = (at: string, newestOver: string): DutyRunRecord => ({ duty: "d9", at: t(at), trigger: "verify", ms: 1, fixes: { throughput_goals_missed: p1022 },
  ...judge(goals, { metrics: { throughput_goals_missed: 1 }, items: { p895: { value: 214_542, target: 5_000, op: "<=" } },
    lastEventAt: { throughput_goals_missed: t(newestOver) }, windowMs: { throughput_goals_missed: DAY } }) });
const older = [d9("10-27T01:15:00", "10-27T00:35:00"), d9("10-26T22:47:00", "10-26T22:05:00"), d9("10-26T19:55:00", "10-26T13:00:00")];

function red(runs: readonly DutyRunRecord[]): RedDuty {
  const metric = { ...metricStreaks(runs).find(streak => streak.key === "throughput_goals_missed")!, fix: { step: "p1022", live: true } };
  const since = agingSince(runs);
  const until = agingUntil(runs);
  return { chat: "crawler", duty: "d9", name: "Throughput goal achieved", green: false, misses: metric.misses, stuck: false, metric, fix: "p1022",
    underFix: fixStepStreak(runs, "throughput_goals_missed", "p1022", ["p895"]), ...since === undefined ? {} : { agingSince: since },
    ...until === undefined ? {} : { agingUntil: until } };
}

test("the run copies the window the precheck names onto the metric", () => {
  assert.equal(older[0]!.metrics.throughput_goals_missed!.windowMs, DAY);
  assert.equal(judge(goals, { metrics: { throughput_goals_missed: 1 }, windowMs: { throughput_goals_missed: -1 } }).metrics.throughput_goals_missed!.windowMs, undefined);
});

test("only the writer row misses and its newest slot over 5,000 came before the previous run: d9 reads it aging, with a clear time, not fix_not_moving", () => {
  const runs = [d9("10-27T22:47:00", "10-27T00:35:00"), ...older];
  const duty = red(runs);
  assert.equal(duty.agingSince, t("10-27T00:35:00"));
  assert.equal(duty.agingUntil, t("10-28T00:35:00"));
  assert.deepEqual(fixNotMoving([duty], () => "Crawler VP"), []);
  const counted = new Set(["throughput_goals_missed"]);
  assert.equal(agedOut(runs, counted, t("10-28T00:34:59")), undefined, "the 00:35Z slot still counts");
  assert.equal(agedOut(runs, counted, t("10-28T00:35:00")), t("10-28T00:35:00"), "the duty gets its push once the slot leaves the 24 h");
});

test("a slot over 5,000 after the previous run keeps the miss live, so d9 still asks to replace the fix", () => {
  const runs = [d9("10-27T22:47:00", "10-27T22:30:00"), ...older];
  const duty = red(runs);
  assert.equal(duty.agingSince, undefined);
  const [found] = fixNotMoving([duty], () => "Crawler VP");
  assert.match(found!.line, /^Crawler VP: Throughput goal achieved \(d9\) missed throughput_goals_missed 4 runs in a row, 4 of them under its fix step p1022, p895/);
});
