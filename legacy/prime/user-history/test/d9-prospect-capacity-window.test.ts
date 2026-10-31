// Guards d9's read of Prospect feature bro's d1 headline, prod_capacity_pages_day: healthy accounts times a rate proven over the newest two full
// UTC days. At 02:27Z on 10-31 d9 read fix_not_moving 1 on it and asked to replace p269, while the window 10-29 and 10-30 still held 10-30, when
// persona-held canary members read 0, so the number could not move before 11-02 00:00Z. 1f0a8ce0 declared the window in engage-reads.duty.json,
// and the runs on record came before it, with no windowMs and no lastEventAt, so d9 now reads the declared window for them too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixNotMoving, fixWindowWait, precheckWindows, type RedDuty } from "../scripts/duties/chat-system.ts";
import type { DutyRunRecord, FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";

const t = (iso: string): number => Date.parse(`2026-${iso}Z`);
const KEY = "prod_capacity_pages_day";
const TWO_DAYS = 2 * 24 * 3_600_000;
const p269 = (current: number, measuredAt: string): FixLink =>
  ({ step: "p269", job: "d1 capacity root cause 10-30", live: true, target: { current, target: 100_000, direction: "up", measuredAt: `2026-${measuredAt}Z` } });

/** One d1 run as Prospect's runs file keeps it, newest first below; only the headline misses. */
const d1 = (at: string, value: number, fix: FixLink): DutyRunRecord => ({ duty: "d1", at: t(at), trigger: "schedule", ms: 1, verdict: "missed", summary: "",
  metrics: { [KEY]: { value, target: 100_000, op: ">=", met: false } }, fixes: { [KEY]: fix } });
const RECORDED = [d1("10-31T02:00:03", 65_136, p269(66_552, "10-31T00:00:29")), d1("10-31T00:00:29", 66_552, p269(75_294, "10-30T20:31:00")),
  d1("10-30T20:31:20", 75_294, p269(75_294, "10-30T02:00:00")),
  d1("10-30T00:00:21", 9_540, { step: "p238", job: "engage suspension wave 10-27", live: true })];
const PRECHECK = { command: ["node", "--import", "tsx", "scripts/duties/engage-reads.ts"], cwd: new URL("..", import.meta.url).pathname, timeoutMs: 1 };

async function red(runs: readonly DutyRunRecord[]): Promise<RedDuty> {
  const streak = metricStreaks(runs).find(entry => entry.key === KEY)!;
  assert.equal(streak.windowMs, undefined, "no run on record carries windowMs");
  const windowMs = (await precheckWindows(PRECHECK))[KEY];
  assert.equal(windowMs, TWO_DAYS, "engage-reads.duty.json declares the two-day window");
  const metric = { ...streak, windowMs: windowMs! };
  return { chat: "prospect", duty: "d1", name: "Engage reads working", green: false, misses: metric.misses, stuck: false, metric, fix: "p269",
    underFix: fixStepStreak(runs, KEY, "p269", [], { windowMs: windowMs! }) };
}

test("at 02:27Z on 10-31 p269 waits inside d1's two-day window, so d9 asks for no replacement", async () => {
  const now = t("10-31T02:27:00");
  const plain = fixStepStreak(RECORDED, KEY, "p269");
  assert.deepEqual([plain.misses, plain.moved], [3, false]);
  const duty = await red(RECORDED);
  assert.equal(fixNotMoving([{ ...duty, underFix: plain }], () => "Prospect feature bro").length, 1, "the 02:27Z read with no window");
  assert.equal(duty.underFix!.misses, 0, "no run lies a window past p269's first run yet");
  assert.equal(duty.underFix!.judgedFrom, t("10-30T20:31:20") + TWO_DAYS);
  assert.deepEqual(fixNotMoving([duty], () => "Prospect feature bro"), []);
  const wait = fixWindowWait(duty.metric, { waitUntil: "2026-11-02T00:00:00Z" }, [], now);
  assert.equal(wait, t("11-02T00:00:00"), "p269's waitUntil, when 10-30 leaves the window");
  assert.deepEqual(fixNotMoving([{ ...duty, underFix: plain, windowWait: wait! }], () => "Prospect feature bro"), []);
});

test("once 10-30 has left the window and d1 still reads 65,136, d9 asks to replace p269", async () => {
  const now = t("11-02T04:05:00");
  const after = [d1("11-02T04:00:00", 65_136, p269(65_136, "11-02T02:00:00")), d1("11-02T02:00:00", 65_136, p269(65_136, "11-02T00:00:00")),
    d1("11-02T00:00:00", 65_136, p269(65_136, "10-31T02:00:03")), ...RECORDED];
  const duty = await red(after);
  assert.equal(fixWindowWait(duty.metric, { waitUntil: "2026-11-02T00:00:00Z" }, [], now), undefined, "the waitUntil has passed");
  assert.equal(duty.underFix!.misses, 3);
  assert.equal(duty.underFix!.moved, false);
  const [found] = fixNotMoving([duty], () => "Prospect feature bro");
  assert.match(found!.line, /^Prospect feature bro: Engage reads working \(d1\) missed prod_capacity_pages_day 7 runs in a row, 3 of them under its fix step p269, /);
});
