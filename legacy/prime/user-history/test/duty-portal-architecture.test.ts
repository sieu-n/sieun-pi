// Guards the api-portal agent's Portal architecture duty, which redoes the owner's daily review of the portal's tables and architecture
// (#dev-api-portal p23, mwwhn4a3 and mwwk8mcw): 18 open problems, 6 of them high, on 2026-11-25.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastVerified, parseStatus, report, UNMEASURED } from "../scripts/duties/portal-architecture.ts";

const status = (checkedAt: string) => parseStatus(JSON.stringify({ checkedAt, problems: [
  { id: "alert-quiet-hours", severity: "high", status: "fixing", step: "p36", title: "alert blind under 20 calls" },
  { id: "live-reads-no-timeout", severity: "high", status: "open", title: "hung-up client still charged" },
  { id: "old-high", severity: "high", status: "fixed", title: "fixed on prod" },
  { id: "two-landings", severity: "low", status: "open", title: "two landings ship" },
] }));

test("a fixing problem stays open until fixed, and the age reads the older of the file and the page", () => {
  const out = report(status("2026-11-25T19:18:05Z"), Date.parse("2026-11-25T10:00:00Z"), Date.parse("2026-11-26T08:00:00Z"));
  assert.deepEqual(out.metrics, { high_problems_open: 2, review_age_h: 22, problems_open: 3 });
  assert.deepEqual(out.flagged!.map(slice => slice.kind), ["high_fixing", "high_unowned", "review_due", "summary"]);
  assert.equal(out.flagged![0]!.item, "p36");
});

test("a fresh review owes no rerun, and a page with no last_verified reads unmeasured", () => {
  const fresh = report(status("2026-11-25T19:18:05Z"), Date.parse("2026-11-25T19:18:05Z"), Date.parse("2026-11-25T21:18:05Z"));
  assert.equal(fresh.metrics.review_age_h, 2);
  assert.ok(!fresh.flagged!.some(slice => slice.kind === "review_due"));
  const missing = report(status("2026-11-25T19:18:05Z"), lastVerified("---\ntitle: x\n---"), Date.parse("2026-11-25T21:18:05Z"));
  assert.equal(missing.metrics.review_age_h, UNMEASURED);
  assert.ok(missing.flagged!.some(slice => slice.kind === "review_stale"));
});

test("the page's last_verified line is read with or without quotes, and a bad severity is refused", () => {
  assert.equal(lastVerified('---\nlast_verified: "2026-11-25T19:18:05Z"\n---'), Date.parse("2026-11-25T19:18:05Z"));
  assert.equal(lastVerified("---\nlast_verified: 2026-11-25T19:18:05Z\n---"), Date.parse("2026-11-25T19:18:05Z"));
  assert.throws(() => parseStatus(JSON.stringify({ checkedAt: "2026-11-25T19:18:05Z", problems: [{ id: "x", title: "y", severity: "urgent", status: "open" }] })),
    /severity urgent/);
});
