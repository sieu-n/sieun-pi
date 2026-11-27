// d1's three prod reads run side by side through estate_pg_prod; step never rejects, so a failed one does not stop the others.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEEP_WALKS_SQL, LAPSED_SQL, measure, report } from "../scripts/duties/engage-reads.ts";
import { judge, PLACEHOLDER } from "../src/shared/chat-duties.ts";

test("a failed prod read does not stop the other prod reads", async () => {
  const prodRead = async (sql: string): Promise<string> => {
    if (sql === DEEP_WALKS_SQL) throw new Error("permission denied for table watch_targets");
    return sql === LAPSED_SQL ? "0\t0\t0\n" : "";
  };
  const data = await measure(null, "no Grafana login", Date.now(), prodRead);
  assert.deepEqual(data.lapsed, { waiting: 0, blocked: 0, oldestAt: null });
  assert.deepEqual(data.stuck, []);
  assert.ok(data.errors.some(error => error.source === "prod deep walks"));
});

test("a timed-out prod source leaves capacity and the walk metric unmeasured, never 0 (d1 at 00:00Z 11-27)", async () => {
  const timeout = async (): Promise<string> => { throw new Error("The operation was aborted due to timeout"); };
  const metrics = [
    { key: "prod_capacity_pages_day", op: ">=" as const, target: 100_000, headline: true },
    { key: "fleet_ig_killed_pct", op: "<=" as const, target: 2 },
    { key: "deep_walk_ok_pct", op: ">=" as const, target: 99 },
  ];
  const output = report(await measure(null, "The operation was aborted due to timeout", Date.now(), timeout), metrics as never);
  assert.equal(output.metrics.prod_capacity_pages_day, -PLACEHOLDER);
  assert.equal(output.metrics.deep_walk_ok_pct, -PLACEHOLDER);
  const verdict = judge(metrics as never, output);
  assert.equal(verdict.verdict, "error");
  assert.match(verdict.summary, /placeholder/);
});
