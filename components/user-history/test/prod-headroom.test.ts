// Owner 10-19: problems that kept recurring become duties. These cases pin how the Prod box headroom duty turns prod Prometheus answers into
// its three numbers and how the runner judges them against the duty's targets. us-metal01's RAID10 ran 11 days degraded with no duty seeing it,
// so the disk health alerts Grafana fires for either box are the third number.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { FiringAlert } from "../src/alert-bridge.ts";
import { CONVERT, diskAlerts, headroom, reading } from "../scripts/duties/prod-headroom.ts";
import { type DutyMetric, judge } from "../src/shared/chat-duties.ts";

const duty = JSON.parse(readFileSync(new URL("../scripts/duties/prod-headroom.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[]; precheck: { cwd: string } };
const one = (value: number) => [{ labels: {}, value }];
const alert = (uid: string, box: string, startsAt = "2026-10-25T13:03:40.000Z"): FiringAlert =>
  ({ fingerprint: `${uid}-${box}`, startsAt, alertname: uid, labels: { __alert_rule_uid__: uid, box }, summary: "", url: "" });

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
  const output = headroom({ profiles_p95_s: one(5.06), nvme0_tb_24h: one(8.56e12) }, [alert("metal-disk-raid-vd-not-optimal", "us-metal01")], 1);
  assert.deepEqual(output.metrics, { profiles_p95_s: 5.06, nvme0_tb_24h: 8.56, disk_health_alerts_firing: 1 });
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.verdict, "missed");
  assert.deepEqual(Object.values(verdict.metrics).map(result => result.met), [false, false, false]);
});

test("readings at the targets are met, and a failed query is not measured instead of missed", () => {
  assert.equal(judge(duty.metrics, headroom({ profiles_p95_s: one(0.4), nvme0_tb_24h: one(4e12) }, [], 1)).verdict, "met");
  const output = headroom({ profiles_p95_s: one(0.2), nvme0_tb_24h: new Error("timeout") }, new Error("Grafana answered 502 for the alert list"), 1);
  assert.equal(output.metrics.nvme0_tb_24h, undefined);
  assert.equal(output.metrics.disk_health_alerts_firing, undefined);
  assert.ok(output.flagged!.some(item => item.kind === "source_error" && item.excerpt === "disk_health_alerts_firing: Grafana answered 502 for the alert list"));
  assert.ok(output.flagged!.some(item => item.kind === "source_error" && item.excerpt.includes("timeout")));
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.verdict, "met");
  assert.match(verdict.summary, /not measured/);
});

test("only metal-disk rules on us-metal01 and us-metal02 count, oldest first, each named in a flagged item", () => {
  const firing = [
    alert("metal-disk-raid-pd-failed", "us-metal02", "2026-10-25T14:00:00.000Z"),
    alert("metal-host-disk-fill-30d", "us-metal01"),
    alert("metal-disk-raid-unused-pd-bad", "us-metal01", "2026-10-25T13:03:40.000Z"),
    alert("metal-disk-smart-failing", "us-vps01"),
    { ...alert("metal-disk-health-stale", "us-metal01"), labels: { box: "us-metal01" } },
  ];
  assert.deepEqual(diskAlerts(firing).map(item => item.alertname), ["metal-disk-raid-unused-pd-bad", "metal-disk-raid-pd-failed"]);
  const output = headroom({ profiles_p95_s: one(0.2), nvme0_tb_24h: one(1e12) }, firing, 1);
  assert.equal(output.metrics.disk_health_alerts_firing, 2);
  assert.deepEqual(output.flagged!.filter(item => item.kind === "alert_firing").map(item => item.excerpt),
    ["us-metal01: metal-disk-raid-unused-pd-bad (metal-disk-raid-unused-pd-bad) since 2026-10-25T13:03:40.000Z", "us-metal02: metal-disk-raid-pd-failed (metal-disk-raid-pd-failed) since 2026-10-25T14:00:00.000Z"]);
  assert.equal(judge(duty.metrics, output).verdict, "missed");
});

test("the duty file runs from the user-history checkout like this chat's other duties", () => {
  assert.equal(duty.precheck.cwd, "../..");
});
