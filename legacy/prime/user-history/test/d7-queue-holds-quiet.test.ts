// Guards d7's runs of 11-23: one park, 01a205b5 overtaken 18 min until 06:32Z, held queue_holds_30 at 1 in the 06:50Z, 06:57Z and 07:05Z
// runs. The precheck gave no lastEventAt for it, so d9 read three misses that did not move and called p1649's fix a13be025 one that does not
// move the count, though that park ended before the fix went live at 07:08:47Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measure, owedKeys, unreadWindows, WINDOW_MS, type Smoothness } from "../scripts/duties/whole-system.ts";
import { judge, type DutyMetric, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import { metricStreaks } from "../src/shared/duty-streak.ts";

const holds: DutyMetric = { key: "queue_holds_30", label: "Turns held in the queue in the last 30 min", op: "<=", target: 0 };
const t = (iso: string): number => Date.parse(iso);
const park = (end: string): Smoothness["overtaken"][number] => ({ session: "01a205b5-d56b-72ee-84e6-3a079afac7a3", minutes: 18, end: t(end) });

function run(at: string, ends: readonly string[]): DutyRunRecord {
  const output = measure({ now: t(at), log: { holds: [] }, chats: [], watch: [], smooth: { headWaits: [], overtaken: ends.map(park) } });
  const { verdict, metrics, summary } = judge([holds], output);
  return { duty: "d7", at: t(at), trigger: "schedule", ms: 1, verdict, metrics, summary };
}

const times = ["2026-11-23T07:05:03Z", "2026-11-23T06:57:03Z", "2026-11-23T06:50:03Z"];

test("an overtaken park dates queue_holds_30 by its end, with the 30 min window", () => {
  const output = measure({ now: t(times[0]!), log: { holds: [] }, chats: [], watch: [], smooth: { headWaits: [], overtaken: [park("2026-11-23T06:32:00Z")] } });
  assert.equal(output.metrics.queue_holds_30, 1);
  assert.equal(output.lastEventAt?.queue_holds_30, t("2026-11-23T06:32:00Z"));
  assert.equal(output.windowMs?.queue_holds_30, WINDOW_MS);
  const none = measure({ now: t(times[0]!), log: { holds: [] }, chats: [], watch: [], smooth: { headWaits: [], overtaken: [] } });
  assert.equal(none.lastEventAt?.queue_holds_30, undefined);
});

test("a hold still open dates queue_holds_30 now, and a passed head by its admission", () => {
  const now = t(times[0]!);
  const open = measure({ now, log: { holds: [{ what: "job run", from: now - 20 * 60_000, to: now }] }, chats: [], watch: [] });
  assert.equal(open.lastEventAt?.queue_holds_30, now);
  const head = measure({ now, log: { holds: [] }, chats: [], watch: [],
    smooth: { headWaits: [{ session: "01a1164b", waitedS: 45, passed: true, at: t("2026-11-23T06:58:10Z") }], overtaken: [] } });
  assert.equal(head.lastEventAt?.queue_holds_30, t("2026-11-23T06:58:10Z"));
});

test("one park counted by three runs reads quiet on the later runs, not stuck", () => {
  const runs = times.map(at => run(at, ["2026-11-23T06:32:00Z"]));
  assert.deepEqual(runs.map(entry => entry.metrics.queue_holds_30!.value), [1, 1, 1]);
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.misses, 3);
  assert.equal(streak!.quietSince, t("2026-11-23T06:32:00Z"));
  assert.equal(streak!.stuck, false);
  assert.equal(metricStreaks(runs.slice(1))[0]!.quietSince, t("2026-11-23T06:32:00Z"));
  assert.deepEqual(unreadWindows(["queue_holds_30"], runs[0]!.metrics), []);
  assert.deepEqual(owedKeys(["queue_holds_30"], runs, new Set()), []);
});

test("a new park after the run before keeps three misses stuck", () => {
  const runs = times.map(at => run(at, ["2026-11-23T06:32:00Z", ...(t(at) > t("2026-11-23T07:01:00Z") ? ["2026-11-23T07:01:00Z"] : [])]));
  const [streak] = metricStreaks(runs);
  assert.equal(streak!.quietSince, undefined);
  assert.equal(streak!.stuck, true);
  assert.deepEqual(owedKeys(["queue_holds_30"], runs, new Set()), ["queue_holds_30"]);
});
