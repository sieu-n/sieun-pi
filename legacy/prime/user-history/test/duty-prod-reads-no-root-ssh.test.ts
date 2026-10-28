// Owner rule c146 (2026-10-19 20:20Z): jobs make no host change on the production box us-metal01 and reach it over root ssh no more; prod reads
// go through the read-only roles. Before it, d1, d2 and the DM outreach duty read prod over `ssh root@64.34.205.243` with docker exec psql.
// Owner rule c180 (2026-10-27) took prod off us-metal02, and wg-prod stopped there at 23:13:54Z on 10-27, so the owner_ro reads to
// 10.250.12.1:5432 timed out; they go through Grafana's estate_pg_prod since.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type DsQuery, PG, frameLines, prodReader } from "../scripts/duties/estate-reads.ts";

const DUTIES = ["estate-reads", "engage-reads", "watchlist-green", "dm-outreach"];

test("the estate read prechecks open no ssh to us-metal01, no docker exec and no wg-prod psql", () => {
  for (const name of DUTIES) {
    const source = readFileSync(new URL(`../scripts/duties/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /root@|64\.34\.205\.243|spawn\("ssh"|docker exec|\bssh\(|host=10\.250\.|"psql"/, name);
  }
});

test("prodReader sends one statement to estate_pg_prod and answers psql's unaligned lines", async () => {
  const queries: Record<string, unknown>[] = [];
  const query: DsQuery = async sent => {
    queries.push(sent);
    return [{ schema: { fields: [{ name: "id" }, { name: "valid" }, { name: "reason" }, { name: "at" }] },
      data: { values: [[7, 8], [true, false], ["http_302 redirected", null], [1793139071452, 12.5]] } }];
  };
  assert.equal(await prodReader(query)("select 1"), "7\tt\thttp_302 redirected\t1793139071452\n8\tf\t\t12.5\n");
  assert.deepEqual(queries, [{ datasource: { uid: PG.prod }, rawSql: "select 1", format: "table" }]);
});

test("frameLines prints nothing for an empty frame or no frame", () => {
  assert.equal(frameLines([]), "");
  assert.equal(frameLines([{ schema: { fields: [{ name: "n" }] }, data: { values: [[]] } }]), "");
});
