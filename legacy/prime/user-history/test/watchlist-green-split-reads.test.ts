// On 2026-11-02 at 09:55Z d2's one prod rows read hit the 30 s statement_timeout on a busy us-metal01, and prod_read_error_pct went
// unmeasured with it although it needs only the receipts. The rows read now runs as PROD_ROW_PARTS hash slices, and the receipts read is
// its own source.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROD_ROW_PARTS, READ_WINDOW_MS, RECEIPTS_SQL, measure, prodRowsSql, report } from "../scripts/duties/watchlist-green.ts";

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

test("prod_read_error_pct reports its window: lastEventAt is the end of the newest hour over 5% and windowMs 24 h (launch VP, 11-04)", async () => {
  const metrics = [{ key: "prod_read_error_pct", op: "<=", target: 5 }] as never;
  const series = [{ schema: { fields: [{ name: "time" }, { name: "value", labels: { kind: "posts", tier: "monitor" } }] }, data: { values: [[0], [30]] } }];
  const query = (async (body: { expr?: string }) => body.expr ? series : [{ schema: { fields: [{ name: "value" }] }, data: { values: [[]] } }]) as never;
  const hour = (iso: string): number => Date.parse(iso);
  // 11-04: the 03Z hour erred 705 of 2,136, and the hours after the fix 1 of 1,137.
  const receipts = [
    `receipt\tok\t1431\t${hour("2026-11-04T03:00:00Z")}`, `receipt\terror\t705\t${hour("2026-11-04T03:00:00Z")}`,
    `receipt\tok\t1136\t${hour("2026-11-04T05:00:00Z")}`, `receipt\terror\t1\t${hour("2026-11-04T05:00:00Z")}`,
  ].join("\n");
  const data = await measure({
    query, authError: null, now: hour("2026-11-04T05:30:00Z"),
    keys: async () => [], stagingKeys: async () => [], screen: async () => [],
    rows: async () => "", receipts: async () => receipts, staging: async () => "",
  });
  const out = report(data, metrics);
  assert.equal(out.metrics.prod_read_error_pct, 21.6);
  assert.equal(out.lastEventAt?.prod_read_error_pct, hour("2026-11-04T04:00:00Z"));
  assert.equal(out.windowMs?.prod_read_error_pct, READ_WINDOW_MS);
  assert.match(out.flagged!.find(flag => flag.kind === "prod_reads")!.excerpt, /newest hour over 5% ended 11-04 04:00Z and leaves the 24 h window at 11-05 04:00Z/);
});
