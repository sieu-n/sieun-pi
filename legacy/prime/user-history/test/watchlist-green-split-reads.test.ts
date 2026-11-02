// On 2026-11-02 at 09:55Z d2's one prod rows read hit the 30 s statement_timeout on a busy us-metal01, and prod_read_error_pct went
// unmeasured with it although it needs only the receipts. The rows read now runs as PROD_ROW_PARTS hash slices, and the receipts read is
// its own source.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROD_ROW_PARTS, RECEIPTS_SQL, measure, prodRowsSql, report } from "../scripts/duties/watchlist-green.ts";

test("the prod rows slices cover every hash value once", () => {
  const slices = Array.from({ length: PROD_ROW_PARTS }, (_, part) => / and \(hashtext\(w\.target\) & (\d+)\) = (\d+)$/.exec(prodRowsSql(part))!);
  for (const [part, slice] of slices.entries()) {
    assert.equal(Number(slice[1]) + 1, PROD_ROW_PARTS);
    assert.equal(Number(slice[2]), part);
  }
  assert.ok(Number.isInteger(Math.log2(PROD_ROW_PARTS)), "a bit mask splits evenly only by a power of two");
});

test("a rows read that times out leaves prod_read_error_pct measured from the receipts", async () => {
  const metrics = [
    { key: "owner_green_pct", op: ">=", target: 100 },
    { key: "prod_read_error_pct", op: "<=", target: 5 },
  ] as never;
  // Each Prometheus series answers 30 (a loop age in seconds, a row count) and each SQL read the empty pause.watch value.
  const series = [{ schema: { fields: [{ name: "time" }, { name: "value", labels: { kind: "posts", tier: "monitor" } }] }, data: { values: [[0], [30]] } }];
  const query = (async (body: { expr?: string }) => body.expr ? series : [{ schema: { fields: [{ name: "value" }] }, data: { values: [[]] } }]) as never;
  const data = await measure({
    query, authError: null, now: Date.parse("2026-11-02T10:00:00Z"),
    keys: async () => ["instagram:account:a"], stagingKeys: async () => [], screen: async () => [],
    rows: async () => { throw new Error("Grafana HTTP 400: canceling statement due to statement timeout"); },
    receipts: async () => { assert.ok(RECEIPTS_SQL.includes("watch_target_claims")); return "receipt\tok\t95\nreceipt\terror\t5\n"; },
    staging: async () => "",
  });
  const out = report(data, metrics);
  assert.equal(out.metrics.prod_read_error_pct, 5);
  assert.equal(out.metrics.owner_green_pct, -999_999);
  assert.ok(out.flagged!.some(flag => flag.kind === "source_error" && flag.excerpt.startsWith("prod rows: ")));
});
