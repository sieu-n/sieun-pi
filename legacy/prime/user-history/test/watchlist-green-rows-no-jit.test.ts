// On 2026-11-02 the prod rows read hit the 30 s statement_timeout at 06:45Z and 07:52Z, and d2 wrote 999999 for three metrics. JIT spent
// 3.2 s of the read's 6.2 s compiling, so both rows reads turn it off. Grafana pools the connections of estate_pg_prod and estate_pg_stg, so
// only a SET LOCAL, which ends with the read's own implicit transaction, may change a setting; a plain SET would stay on the pooled
// connection for every later panel query.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_JIT, NO_SEQSCAN, PROD_ROWS_SQL, STAGING_ROWS_SQL } from "../scripts/duties/watchlist-green.ts";

// On 2026-11-08 at 09:05Z and 09:10Z the staging rows read planned a seq scan of the 1.4 GB table and hit the 30 s statement_timeout,
// so staging also turns the seq scan off for its own statement.
const READS = [["prod", PROD_ROWS_SQL, ["set local jit = off"]], ["staging", STAGING_ROWS_SQL, ["set local jit = off", "set local enable_seqscan = off"]]] as const;
for (const [name, sql, want] of READS) {
  test(`the ${name} rows read changes settings for its own statement only`, () => {
    assert.ok(sql.startsWith(name === "staging" ? NO_JIT + NO_SEQSCAN : NO_JIT));
    const sets = sql.split(";").map(part => part.trim().toLowerCase()).filter(part => part.startsWith("set "));
    assert.deepEqual(sets, [...want]);
    assert.equal(sql.split(";").length, want.length + 1, "the SET LOCALs, then the one select");
  });
}
