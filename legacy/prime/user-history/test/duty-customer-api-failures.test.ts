// Guards the Customer API failures duty of the api portal vp chat, which keeps board goal p80 met: 0.32% customer prod 5xx on 11-01 UTC
// (5 of 1,576), after about 31% of customer calls failed from 10-13 to 10-26.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleOf, lastFullDay, report } from "../scripts/duties/customer-api-failures.ts";

test("the window is the last full UTC day", () => {
  assert.deepEqual(lastFullDay(Date.parse("2026-11-04T00:10:00Z")), { start: "2026-11-03 00:00:00", end: "2026-11-04 00:00:00" });
});

test("the share is 5xx over completed plus failed, and each 5xx is flagged with its handle and request id (11-01 UTC)", () => {
  const out = report({ completed: 1_452, failed: 124, failed5xx: 5 }, [
    { at: "2026-11-01T01:40:27.435Z", endpoint: "instagram.web_profile_info", status: 502, errorCode: "upstream_error", handle: "dinkey727",
      requestId: "req_a", orgId: "org_3KauwxlZ8kv5BKXXTtUnvw7jPLp" },
  ], { start: "2026-11-01 00:00:00" }, 151);
  assert.equal(out.metrics.customer_5xx_share_pct, 0.32);
  assert.equal(out.metrics.source_errors, 0);
  assert.match(out.flagged![0]!.excerpt, /5 customer 5xx of 1576 attempts \(0\.32%\).*151 min/);
  assert.match(out.flagged![1]!.excerpt, /@dinkey727 req_a/);
});

test("a day with no calls reads 0, not a miss", () => {
  assert.equal(report({ completed: 0, failed: 0, failed5xx: 0 }, [], { start: "2026-11-03 00:00:00" }, null).metrics.customer_5xx_share_pct, 0);
});

test("the handle comes from the crawler path", () => {
  assert.equal(handleOf("/api/live/instagram/user_feed?handle=sisterann_judy4&max_pages=1"), "sisterann_judy4");
  assert.equal(handleOf("/api/profiles/nike"), null);
});
