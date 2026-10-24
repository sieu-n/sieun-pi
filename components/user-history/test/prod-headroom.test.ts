// Owner 10-19: problems that kept recurring become duties. These cases pin how the Prod box headroom duty turns prod Prometheus answers into
// its two numbers and how the runner judges them against the duty's targets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONVERT, headroom, reading } from "../scripts/duties/prod-headroom.ts";
import { type DutyMetric, judge } from "../src/shared/chat-duties.ts";

const duty = JSON.parse(readFileSync(new URL("../scripts/duties/prod-headroom.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[]; precheck: { cwd: string } };
const one = (value: number) => [{ labels: {}, value }];

test("raw Prometheus values convert to seconds and TB", () => {
  assert.equal(CONVERT.profiles_p95_s(5.0625000003), 5.06);
  assert.equal(CONVERT.nvme0_tb_24h(8_561_794_594_081), 8.56);
});

test("a metric needs exactly one finite series", () => {
  assert.deepEqual(reading("profiles_p95_s", one(0.31)), { value: 0.31 });
  assert.match((reading("profiles_p95_s", one(Number.NaN)) as { error: string }).error, /0 finite series/);
  assert.match((reading("nvme0_tb_24h", [...one(1), ...one(2)]) as { error: string }).error, /2 finite series/);
  assert.match((reading("nvme0_tb_24h", new Error("Grafana HTTP 401")) as { error: string }).error, /nvme0_tb_24h: Grafana HTTP 401/);
});

test("the 10-19 readings miss every target", () => {
  const output = headroom({ profiles_p95_s: one(5.06), nvme0_tb_24h: one(8.56e12) }, 1);
  assert.deepEqual(output.metrics, { profiles_p95_s: 5.06, nvme0_tb_24h: 8.56 });
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.verdict, "missed");
  assert.deepEqual(Object.values(verdict.metrics).map(result => result.met), [false, false]);
});

test("readings at the targets are met, and a failed query is not measured instead of missed", () => {
  assert.equal(judge(duty.metrics, headroom({ profiles_p95_s: one(0.4), nvme0_tb_24h: one(4e12) }, 1)).verdict, "met");
  const output = headroom({ profiles_p95_s: one(0.2), nvme0_tb_24h: new Error("timeout") }, 1);
  assert.equal(output.metrics.nvme0_tb_24h, undefined);
  assert.ok(output.flagged!.some(item => item.kind === "source_error" && item.excerpt.includes("timeout")));
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.verdict, "met");
  assert.match(verdict.summary, /not measured/);
});

test("the duty file runs from the user-history checkout like this chat's other duties", () => {
  assert.equal(duty.precheck.cwd, "../..");
});
