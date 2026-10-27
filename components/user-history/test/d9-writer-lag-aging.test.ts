// Guards d9's read of Crawler VP's d9 when only the census writer row misses (p895, under p1022). The row counts the worst five-minute slot
// of 24 h, and the precheck dates the miss at the newest counted slot over 5,000. On 10-27 at 00:25Z d9 read fix_not_moving 1 on it, because
// the headline carried no lastEventAt; 07e5b4d4 added it. The key throughput_goals_missed names no window, so d9 still printed no clear time
// and no push read the duty when that slot left the window, until the precheck named the window too (windowMs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agingSince, agingUntil, fixNotMoving, fixWindowWait, type RedDuty } from "../scripts/duties/chat-system.ts";
import { agedOut } from "../src/duty-push.ts";
import { judge, type DutyMetric, type DutyRunRecord, type FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";
import type { Wake } from "../src/wakes.ts";

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

// d9 at 02:25Z on 10-27 asked Crawler VP to replace p1022, while p1022's job (crawler ops train) had committed 86f9c09f2c and slept on run
// 40444358343 to ship it. Its other wake, at 06:00Z on 10-29 about snapshot parts, lies past one window and says nothing about this fix.
test("a fix whose job sleeps on a ship run inside the count's window waits on the window, so d9 asks for no replacement", () => {
  const runs = [d9("10-27T02:20:00", "10-27T01:20:00"), ...older];
  const now = t("10-27T02:25:00");
  const train = "01a15984-a584-7668-aaec-d5a67c824796";
  const ship: Wake = { session: train, on: { kind: "run", run: 40444358343 }, note: "ship 86f9c09f2c", since: t("10-27T02:12:00") };
  const parts: Wake = { session: train, on: { kind: "time", at: t("10-29T06:00:00") }, note: "snapshot parts", since: t("10-26T05:25:00") };
  const step = { sessionId: train };
  const duty = red(runs);
  assert.equal(fixNotMoving([duty], () => "Crawler VP").length, 1, "the old read asks to replace p1022");
  const wait = fixWindowWait(duty.metric, step, [ship, parts], now);
  assert.equal(wait, now + DAY);
  assert.deepEqual(fixNotMoving([{ ...duty, windowWait: wait! }], () => "Crawler VP"), []);
  assert.equal(fixWindowWait(duty.metric, step, [parts], now), undefined, "a wake past one window is no wait on this fix");
  assert.equal(fixWindowWait(duty.metric, { sessionId: "01a17851-b190-72ec-8cdf-83180c1c649c" }, [ship, parts], now), undefined, "another session's wake");
  assert.equal(fixWindowWait(duty.metric, { waitUntil: "2026-10-27T08:00:00Z" }, [], now), t("10-27T08:00:00"));
  assert.equal(fixWindowWait({ key: "throughput_goals_missed" }, step, [ship], now), undefined, "a count with no window has no window to wait on");
});
