// Guards the Portal billing duty (d4 of the api portal vp chat). On 2026-10-18 prod's intelligence.profile served bundles with no charge
// (0982ee03ca), 2,702 prod calls answered 200 after rate_check_failed in the 24 h to 2026-10-19 15:50Z at a8f85b4206, and prod charged
// $0.0005 for a missing Hacker News user and a zero-hit search (a07e3b3337). The duty counts all three.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DutyMetric } from "../src/shared/chat-duties.ts";
import { type BillingData, type Operation, type RequestLine, type UsageRow, expectedCharge, micros, PROBES, reconcile, report } from "../scripts/duties/portal-billing.ts";

const NOW = Date.parse("2026-10-19T16:00:00Z");
const AT = NOW - 6 * 3_600_000;
const OPERATIONS: Operation[] = [
  { id: "intelligence.profile", path: "/v1/intelligence/profile", method: "GET", costMicros: 50_000 },
  { id: "live.youtube.channel_shorts", path: "/v1/youtube/live/channel/shorts", method: "GET", costMicros: 500 },
  { id: "jobs.status", path: "/v1/jobs/{job_id}", method: "GET", costMicros: 0 },
];
const METRICS: DutyMetric[] = [
  { key: "billing_mismatches_24h", label: "", op: "<=", target: 0, headline: true },
  { key: "uncounted_calls_24h", label: "", op: "<=", target: 0 },
  { key: "empty_charged_probe", label: "", op: "<=", target: 0 },
];
const line = (rid: string, path: string, status: number, start: number, durationMs = 3_000): RequestLine => ({ rid, method: "GET", path, status, start, durationMs });
const row = (requestId: string, operation: string, createdAt: number, costMicros = 500): UsageRow => ({ requestId, operation, createdAt, costMicros });

test("a priced 2xx with no ledger row is served free, and a free route or a 202 job answer is not", () => {
  const result = reconcile(OPERATIONS, [
    line("a", "/v1/intelligence/profile", 200, AT),
    line("b", "/v1/jobs/j1", 200, AT),
    line("c", "/v1/youtube/live/channel/shorts", 202, AT),
  ], [], NOW);
  assert.deepEqual(result.servedFree.map(entry => entry.line.rid), ["a"]);
});

test("a 202 job answer that ends first does not take the row of the 200 beside it (10-19 channel_shorts page 2)", () => {
  const result = reconcile(OPERATIONS, [
    line("page2", "/v1/youtube/live/channel/shorts", 200, AT, 2_902),
    line("job", "/v1/youtube/live/channel/shorts", 202, AT + 1_060, 287),
  ], [row("r1", "live.youtube.channel_shorts", AT + 3_045)], NOW);
  assert.equal(result.servedFree.length, 0);
});

test("a charge that pairs only with a 404 is a charge for an error, and a voided one is not", () => {
  const result = reconcile(OPERATIONS, [line("x", "/v1/youtube/live/channel/shorts", 404, AT), line("y", "/v1/youtube/live/channel/shorts", 404, AT + 60_000)], [
    row("r1", "live.youtube.channel_shorts", AT + 1_000),
    row("r2", "live.youtube.channel_shorts", AT + 61_000),
    { ...row("r2", "live.youtube.channel_shorts", AT + 62_000, 0), source: { kind: "void" } },
  ], NOW);
  assert.deepEqual(result.chargedOnError.map(entry => entry.row.requestId), ["r1"]);
});

test("the report counts uncounted 2xx calls and probe charges, and a failed source never reads green", () => {
  const empty = PROBES.find(probe => probe.empty)!;
  const good = PROBES.find(probe => !probe.empty)!;
  assert.equal(micros("$0.0005"), 500);
  assert.equal(expectedCharge(empty, 200, 500), 0);
  assert.equal(expectedCharge(good, 200, 500), 500);
  assert.equal(expectedCharge(good, 502, 500), 0);
  const data: BillingData = {
    now: NOW, operations: OPERATIONS, requests: [line("a", "/v1/intelligence/profile", 200, AT)], ledger: [row("r", "intelligence.profile", AT + 1_000, 50_000)],
    uncounted: [{ kind: "rate_check_failed", status: "200", path: "/v1/tiktok/live/mentions", calls: 2_702, lastAt: AT }, { kind: "deduct_failed", status: "", path: "", calls: 4, lastAt: AT + 5_000 }],
    probes: [
      { env: "prod", probe: "hn missing user", status: 200, requestId: "q1", expected: 0, charged: 500 },
      { env: "staging", probe: "hn missing user", status: 200, requestId: "q2", expected: 0, charged: 0 },
    ],
    errors: [],
  };
  assert.deepEqual(report(data, METRICS).metrics, { billing_mismatches_24h: 0, uncounted_calls_24h: 2_702, empty_charged_probe: 1 });
  const broken = report({ ...data, errors: [{ source: "prod ledger", message: "HTTP 500" }] }, METRICS);
  assert.ok(broken.metrics.billing_mismatches_24h! > 0);
  assert.ok(broken.flagged!.some(slice => slice.kind === "source_error"));
});

test("each 24 h count gives the time of its newest counted call, and a zero count gives none (10-20 d9: uncounted calls stayed red after the fix)", () => {
  const data: BillingData = {
    now: NOW, operations: OPERATIONS,
    requests: [line("a", "/v1/intelligence/profile", 200, AT), line("b", "/v1/intelligence/profile", 200, AT + 60_000), line("x", "/v1/youtube/live/channel/shorts", 404, AT + 120_000),
      ...Array.from({ length: 20 }, (_, i) => line(`ok${i}`, "/v1/intelligence/profile", 200, AT - 3_600_000 + i * 60_000))],
    ledger: [row("r1", "live.youtube.channel_shorts", AT + 121_000), ...Array.from({ length: 20 }, (_, i) => row(`ok${i}`, "intelligence.profile", AT - 3_599_000 + i * 60_000, 50_000))],
    uncounted: [
      { kind: "rate_check_failed", status: "200", path: "/v1/tiktok/live/mentions", calls: 2_702, lastAt: AT - 7_200_000 },
      { kind: "rate_check_failed", status: "200", path: "/v1/youtube/live/channel/shorts", calls: 3, lastAt: AT - 3_600_000 },
      { kind: "deduct_failed", status: "503", path: "/v1/x", calls: 9, lastAt: AT },
    ],
    probes: [], errors: [],
  };
  const live = report(data, METRICS);
  assert.equal(live.metrics.billing_mismatches_24h, 3);
  assert.deepEqual(live.lastEventAt, { billing_mismatches_24h: AT + 121_000, uncounted_calls_24h: AT - 3_600_000 });
  const quiet = report({ ...data, requests: [line("a", "/v1/intelligence/profile", 200, AT)], ledger: [row("r", "intelligence.profile", AT + 1_000, 50_000)], uncounted: [] }, METRICS);
  assert.equal(quiet.metrics.billing_mismatches_24h, 0);
  assert.equal(quiet.metrics.uncounted_calls_24h, 0);
  assert.equal(quiet.lastEventAt, undefined);
  const { uncounted: _, ...unread } = data;
  const broken = report({ ...unread, errors: [{ source: "gateway failures", message: "HTTP 500" }] }, METRICS);
  assert.equal(broken.lastEventAt?.uncounted_calls_24h, undefined);
});
