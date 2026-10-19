// Guards d1's deep walk metric. On 2026-10-19 deep_walk_ok_pct read 100% (12 walks reached their end, 0 error stops) while 32 open 365-day
// walks had sat on cursor_provenance_missing since they started on 10-12 to 10-17, because the metric counted only the walks that finished.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DutyMetric } from "../src/shared/chat-duties.ts";
import { deepWalksOf, report } from "../scripts/duties/engage-reads.ts";

const NOW = Date.parse("2026-10-19T15:30:00Z");
const METRIC: DutyMetric = { key: "deep_walk_ok_pct", label: "deep walks", op: ">=", target: 99, unit: "%" };
const PROD_1019 = "reached\t\t12\nstuck\tcursor_provenance_missing\t32\n";

test("open walks stuck past one cadence count against deep_walk_ok_pct and read as deep_walks_open_stuck", () => {
  const out = report({ now: NOW, errors: [], deepWalks: deepWalksOf(PROD_1019) }, [METRIC]);
  assert.equal(out.metrics.deep_walks_open_stuck, 32);
  assert.equal(out.metrics.deep_walk_ok_pct, 27.3);
  assert.match(out.flagged!.find(flag => flag.kind === "deep_walks")!.excerpt, /32 open walks are stuck.*cursor_provenance_missing 32/);
});

test("one stuck walk misses the target at the 10-19 walk volume", () => {
  const out = report({ now: NOW, errors: [], deepWalks: deepWalksOf("reached\t\t12\nstuck\tcursor_provenance_missing\t1\n") }, [METRIC]);
  assert.ok(out.metrics.deep_walk_ok_pct! < METRIC.target);
});

test("a retrying walk inside its first cadence and a stuck walk on a non-pagination code stay out of the metric", () => {
  const walks = deepWalksOf("reached\t\t12\nretrying\tcursor_provenance_missing\t3\nstuck\tfleet_exhausted\t2\n");
  assert.deepEqual(walks, { reached: 12, errors: {}, stuck: { fleet_exhausted: 2 }, retrying: { cursor_provenance_missing: 3 } });
  const out = report({ now: NOW, errors: [], deepWalks: walks }, [METRIC]);
  assert.equal(out.metrics.deep_walk_ok_pct, 100);
  assert.equal(out.metrics.deep_walks_open_stuck, 0);
});

test("deepWalksOf refuses a class it does not know", () => {
  assert.throws(() => deepWalksOf("reading\tpermanent_error\t4\n"), /unexpected line/);
});
