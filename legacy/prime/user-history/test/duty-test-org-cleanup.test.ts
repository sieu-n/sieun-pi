// 10-28: a code-cut sweep removed staging /api/test/cleanup, and portal-parity and portal-billing never read its answer, so their seeded
// test orgs would have stayed on staging with nothing flagged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SEEDED_ROWS, checkCleanup } from "../scripts/duties/test-org-cleanup.ts";
import { parityMetrics } from "../scripts/duties/portal-parity.ts";

const answer = (status: number, body: string) => Promise.resolve(new Response(body, { status }));
const counts = (keys: number, balances: number) => JSON.stringify({ ok: true, counts: { keys, balances, usage: 0, credits: 0, stripeRows: 0, playgroundRuns: { before: 0, after: 0 } } });

test("a cleanup that deleted the seeded key and balance passes, and so does one with a balance shard per charge", async () => {
  await checkCleanup(answer(200, counts(SEEDED_ROWS.keys, SEEDED_ROWS.balances)), "org_x");
  await checkCleanup(answer(200, counts(1, 17)), "org_x");
});

test("a cleanup answer with no counts fails", async () => {
  await assert.rejects(checkCleanup(answer(200, JSON.stringify({ ok: true })), "org_f"), /org_f: deleted keys undefined/);
});

test("a 404 from a removed route fails and names the org", async () => {
  await assert.rejects(checkCleanup(answer(404, "No matching routes found"), "org_duty_parity_1_0"), /org_duty_parity_1_0: HTTP 404/);
});

test("a body that is not ok fails and names the org", async () => {
  await assert.rejects(checkCleanup(answer(200, JSON.stringify({ ok: false, error: "internal" })), "org_b"), /org_b: ok is not true/);
  await assert.rejects(checkCleanup(answer(200, "<html>"), "org_b"), /org_b: not JSON/);
});

test("a cleanup that deleted nothing fails, because the seeded rows are still somewhere", async () => {
  await assert.rejects(checkCleanup(answer(200, counts(0, 0)), "org_c"), /org_c: deleted keys 0 \(expected at least 1\), balances 0 \(expected at least 1\)/);
});

test("a cleanup call with no answer fails and names the org", async () => {
  await assert.rejects(checkCleanup(Promise.reject(new TypeError("fetch failed")), "org_d"), /org_d: no answer: fetch failed/);
});

test("d2 with a failed cleanup never passes: staging is unmeasured and the error is flagged", () => {
  const { output } = parityMetrics({ routes: [], crawler: { prod: null, staging: null }, docs: { prod: null, staging: null }, probes: { prod: [], staging: [] },
    sourceErrors: [], at: 1, cleanupErrors: ["staging /api/test/cleanup left test org org_e: HTTP 404: No matching routes found"] });
  assert.equal(output.metrics.staging_working_pct, -1);
  assert.equal(output.metrics.source_errors, 1);
  assert.ok((output.flagged ?? []).some(slice => slice.kind === "source_error" && slice.excerpt.includes("org_e")));
});
