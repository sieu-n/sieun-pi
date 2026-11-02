// On 2026-11-02 the prod rows read hit the 30 s statement_timeout at 06:45Z and 07:52Z, and d2 wrote 999999 for three metrics. JIT spent
// 3.2 s of the read's 6.2 s compiling, so both rows reads turn it off. Grafana pools the connections of estate_pg_prod and estate_pg_stg, so
// only a SET LOCAL, which ends with the read's own implicit transaction, may change a setting; a plain SET would stay on the pooled
// connection for every later panel query.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_JIT, PROD_ROWS_SQL, STAGING_ROWS_SQL } from "../scripts/duties/watchlist-green.ts";

for (const [name, sql] of [["prod", PROD_ROWS_SQL], ["staging", STAGING_ROWS_SQL]] as const) {
  test(`the ${name} rows read turns JIT off for its own statement only`, () => {
    assert.ok(sql.startsWith(NO_JIT));
    const sets = sql.split(";").map(part => part.trim().toLowerCase()).filter(part => part.startsWith("set "));
    assert.deepEqual(sets, ["set local jit = off"]);
    assert.equal(sql.split(";").length, 2, "one SET LOCAL, then the one select");
  });
}
