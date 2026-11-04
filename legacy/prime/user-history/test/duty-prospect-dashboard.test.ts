// Guards the Prospect dashboard duty of the launch VP chat: from 17:39Z on 11-03 to 01:49Z on 11-04 the PostHog prod Convex source sat
// paused with 3 failed tables during the Convex outage and no duty noticed, and the owner asked why the dashboard was so empty (msg mw08t1g0).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Deps, loadTile, report, type SchemaRow, tilesTables, UNMEASURED } from "../scripts/duties/prospect-dashboard.ts";

const NOW = Date.parse("2026-11-04T01:00:00Z");
const schema = (name: string, fields: Partial<SchemaRow>): SchemaRow =>
  ({ id: name, name, should_sync: true, status: "Completed", last_synced_at: "2026-11-04T00:30:00Z", sync_frequency: "1hour", latest_error: null, ...fields });
const fresh = { prospect_state_day: "2026-11-03T04:42:32Z", watchlist_reads_day: "2026-11-03T04:42:32Z" };

test("the outage's paused tables count as failing, a table no tile reads and nobody syncs does not, and a late sync does (11-03 outage)", () => {
  const denied = "Access denied. Check your Convex deploy key.";
  const out = report({ tiles: [], newest: fresh, required: ["orgmembers", "orgs"], schemas: [
    schema("orgs", { should_sync: false, status: "Failed", latest_error: denied }),
    schema("orgMembers", { should_sync: false, status: "Failed", latest_error: denied }),
    schema("apiPortalUsage", { last_synced_at: "2026-11-03T17:00:00Z" }),
    schema("apiPortalBalances", { should_sync: false, last_synced_at: "2026-11-03T04:36:01Z" }),
  ] }, NOW);
  assert.equal(out.metrics.source_tables_failing, 3);
  const lines = out.flagged!.filter(slice => slice.kind === "table_failing").map(slice => slice.excerpt);
  assert.match(lines[0]!, /^orgs: a tile reads it, but its sync is off \(status Failed\): Access denied/);
  assert.match(lines[2]!, /^apiPortalUsage: last sync 2026-11-03T17:00Z, 8 h ago, over twice its 1hour interval/);
});

test("a tile of zeros, nulls and labels reads empty, so the headline is the tiles that show a nonzero number (11-04: 7 of 18)", () => {
  const out = report({ schemas: [], required: [], newest: fresh, tiles: [
    { id: 1, name: "Customer orgs", rows: [[286, 52, 234]] },
    { id: 2, name: "Prospect state", rows: [[0, 0, null, "no prospect_state_day yet"]] },
    { id: 3, name: "Watchlist reads", rows: [["2026-11-01", 0, 0.0, null]] },
    { id: 4, name: "Emails sent", error: "Query timed out" },
  ] }, NOW);
  assert.equal(out.metrics.tiles_with_data_pct, 25);
  assert.equal(out.metrics.tiles_empty, 2);
  assert.equal(out.metrics.tiles_failing, 1);
  assert.deepEqual(out.flagged!.slice(1).map(slice => slice.kind), ["tile_empty", "tile_empty", "tile_failing"]);
});

test("an event prod never sent reads unmeasured and is flagged, and one from 20 h ago is on time", () => {
  const out = report({ tiles: [], schemas: [], required: [], newest: { watchlist_reads_day: "2026-11-03T05:00:00Z" } }, NOW);
  assert.equal(out.metrics.prospect_state_day_age_h, UNMEASURED);
  assert.equal(out.metrics.watchlist_reads_day_age_h, 20);
  assert.deepEqual(out.flagged!.filter(slice => slice.kind === "event_late").map(slice => slice.excerpt),
    ["prod prospect_state_day: none since 2026-11-03, due every day from pipeDays.fillDay at 04:41Z"]);
});

test("the tables to check are the source tables the tiles read", () => {
  assert.deepEqual(tilesTables(["SELECT org_id FROM prodconvex_orgs JOIN prodconvex_orgMembers m", "FROM events"]), ["orgmembers", "orgs"]);
});

test("a tile with no cached answer is polled until PostHog finishes it, and its rows come back", async () => {
  const answers = [{ query_status: { id: "q1", complete: false } }, { query_status: { id: "q1", complete: false } },
    { query_status: { id: "q1", complete: true, results: { results: [[286, 52, 234]] } } }];
  const urls: string[] = [];
  const deps: Deps = { key: "k", now: () => NOW, sleep: async () => {}, fetch: (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(answers.shift()), { status: urls.length === 1 ? 202 : 200 });
  }) as typeof fetch };
  assert.deepEqual(await loadTile(deps, { kind: "HogQLQuery" }), { rows: [[286, 52, 234]] });
  assert.equal(urls.filter(url => url.endsWith("/query/q1/")).length, 2);
});
