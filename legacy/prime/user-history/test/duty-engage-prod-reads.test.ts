// d1's three prod reads run side by side through estate_pg_prod; step never rejects, so a failed one does not stop the others.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEEP_WALKS_SQL, LAPSED_SQL, measure } from "../scripts/duties/engage-reads.ts";

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
