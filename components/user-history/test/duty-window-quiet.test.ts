// Guards frontend bro's d1 runs of 10-18: restarts_24h read 4 from 5180 stops at 02:17, 04:46, 05:55 and 06:53Z, the fix 6ed4d88146 landed at
// 08:24Z and pm2.log showed no stop after 06:53Z, yet from 10:46Z every run called the metric stuck and ordered a new root-cause job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { missLine } from "../src/chat-duty-job.ts";
import { judge, type DutyMetric, type DutyRunRecord, type FixLink } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const restarts: DutyMetric = { key: "restarts_24h", label: "Times the 5180 dev server went down and restarted in 24 h", op: "<=", target: 1 };
const t = (iso: string): number => Date.parse(iso);
const p160: FixLink = { step: "p160", live: false };
const p204: FixLink = { step: "p204", job: "5180 box restarts fix", live: false };

function run(at: string, value: number, lastEventAt: string, fix: FixLink): DutyRunRecord {
  const { verdict, metrics, summary } = judge([restarts], { metrics: { restarts_24h: value }, lastEventAt: { restarts_24h: t(lastEventAt) } });
  return { duty: "d1", at: t(at), trigger: "verify", ms: 1, verdict, metrics, summary, fixes: { restarts_24h: fix } };
}

const runs1018 = (): DutyRunRecord[] => [
  run("2026-10-18T11:01:00Z", 4, "2026-10-18T06:53:01Z", p204),
  run("2026-10-18T10:46:00Z", 4, "2026-10-18T06:53:01Z", p204),
  run("2026-10-18T09:20:00Z", 4, "2026-10-18T06:53:01Z", p204),
  run("2026-10-18T08:25:00Z", 4, "2026-10-18T06:53:01Z", p204),
  run("2026-10-18T06:36:00Z", 3, "2026-10-18T05:55:38Z", p160),
];

test("the precheck's newest event time reaches the run's metric result", () => {
  assert.equal(runs1018()[0]!.metrics.restarts_24h!.lastEventAt, t("2026-10-18T06:53:01Z"));
});

test("a windowed count with no new event since the last run is not stuck and gets no job", () => {
  const [streak] = metricStreaks(runs1018());
  assert.equal(streak!.misses, 5);
  assert.equal(streak!.moved, false);
  assert.equal(streak!.stuck, false);
  assert.equal(streak!.quietSince, t("2026-10-18T06:53:01Z"));
  const line = missLine("d1", streak!, restarts.label);
  assert.doesNotMatch(line, /Change approach|rlm\.create_session/);
  assert.match(line, /Start no new job for it and leave p204 as it is/);
});

test("a new stop after the last run keeps the same streak stuck", () => {
  const runs = runs1018();
  runs[0] = run("2026-10-18T11:01:00Z", 5, "2026-10-18T10:50:00Z", p204);
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.stuck, true);
  assert.equal(streak!.quietSince, undefined);
  assert.match(missLine("d1", streak!, restarts.label), /Change approach: the fix p204/);
});
