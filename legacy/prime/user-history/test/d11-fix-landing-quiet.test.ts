// Guards d11's runs of 11-23: ops guy's t81 resend of 15:13:36Z was labelled noise, and the d11f8252 fix for its kind landed at 21:13:15Z,
// between the 21:07Z push run and the 21:16Z verify run. noiseLastEvent dated the count by that landing, so the verify run read live, d11's
// next run was the next day's, and d9 counted d11 as a red duty with no live fix until then, though a before_fix line owes no job.
import assert from "node:assert/strict";
import { test } from "node:test";
import { owedKeys } from "../scripts/duties/whole-system.ts";
import { noiseLastEvent, splitNoise } from "../scripts/duties/noise-split.ts";
import { agedOut, agingSince } from "../src/duty-push.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const t = Date.parse;
const metric: DutyMetric = { key: "needed_pct_24h", label: "Messages to the owner in the last 24 h that he needed, in percent", op: ">=", target: 90, headline: true };
const sent = t("2026-11-23T15:13:36.030Z");
const line = { at: sent, case: "repeat of a decision already on For you (ops guy resent its t81 Vercel ask past the re-ask refusal after flipping its pick)" };
const landed: Record<string, string> = { db253d1c: "2026-10-20T04:12:14Z", c083958b: "2026-10-25T23:00:00Z" };

async function reading(fixes: Record<string, string>) {
  const split = await splitNoise([line], async hash => fixes[hash] ? t(fixes[hash]!) : undefined);
  return { split, ...judge([metric], { metrics: { needed_pct_24h: 66.7 }, lastEventAt: noiseLastEvent(split), windowMs: { needed_pct_24h: 24 * 3_600_000 } }) };
}

async function runs(): Promise<DutyRunRecord[]> {
  const before = await reading(landed);
  const after = await reading({ ...landed, d11f8252: "2026-11-23T21:13:15Z" });
  const met = judge([metric], { metrics: { needed_pct_24h: 100 } });
  const run = (at: string, trigger: DutyRunRecord["trigger"], read: Awaited<ReturnType<typeof reading>>, afterAt: string): DutyRunRecord =>
    ({ duty: "d11", at: t(at), trigger, ms: 1, verdict: read.verdict, metrics: read.metrics, summary: read.summary,
      after: { at: t(afterAt), verdict: read.verdict, metrics: read.metrics, summary: read.summary } });
  return [run("2026-11-23T21:16:48Z", "verify", after, "2026-11-23T21:18:15Z"), run("2026-11-23T21:07:40Z", "push", before, "2026-11-23T21:09:10Z"),
    { duty: "d11", at: t("2026-11-23T21:03:10Z"), trigger: "schedule", ms: 1, ...met,
      after: { at: t("2026-11-23T21:07:10Z"), verdict: before.verdict, metrics: before.metrics, summary: before.summary } }];
}

test("a fix that lands after a noise line went out does not date needed_pct_24h", async () => {
  const { split, metrics } = await reading({ ...landed, d11f8252: "2026-11-23T21:13:15Z" });
  assert.equal(split[0]!.side, "before_fix");
  assert.equal(split[0]!.fix, "d11f8252");
  assert.deepEqual(noiseLastEvent(split), { needed_pct_24h: sent });
  assert.equal(metrics.needed_pct_24h!.windowMs, 24 * 3_600_000);
});

test("the verify run after d11f8252 reads quiet, so d9 owes d11 no fix job and reads it as aging", async () => {
  const replay = await runs();
  const [streak] = metricStreaks(replay);
  assert.equal(streak!.misses, 3);
  assert.equal(streak!.quietSince, sent);
  assert.equal(streak!.stuck, false);
  assert.deepEqual(owedKeys(["needed_pct_24h"], replay, new Set()), []);
  assert.equal(agingSince(replay), sent);
});

test("the duty runner reads d11 again once the line leaves the 24 h", async () => {
  const replay = await runs();
  const counted = new Set(["needed_pct_24h"]);
  assert.equal(agedOut(replay, counted, t("2026-11-24T15:13:00Z")), undefined);
  assert.equal(agedOut(replay, counted, t("2026-11-24T15:14:00Z")), sent + 24 * 3_600_000);
});

test("a new noise line sent after the run before keeps the miss live", async () => {
  const replay = await runs();
  const fresh = await splitNoise([line, { at: t("2026-11-23T21:12:00Z"), case: "progress relay" }], async () => undefined);
  const read = judge([metric], { metrics: { needed_pct_24h: 50 }, lastEventAt: noiseLastEvent(fresh) });
  const live = [{ ...replay[0]!, metrics: read.metrics, after: { ...replay[0]!.after!, metrics: read.metrics } }, ...replay.slice(1)];
  assert.equal(metricStreaks(live)[0]!.quietSince, undefined);
  assert.deepEqual(owedKeys(["needed_pct_24h"], live, new Set()), ["needed_pct_24h"]);
});
