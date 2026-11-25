/**
 * The search filter state (web/src/pages/search/filters.ts) that the chips, the typed operators and the results page's address share.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hit } from "../../web/src/pages/search/hit-view.ts";
import { dateLabel, dateRanges, filterParams, hasFilters, hitPlace, NO_FILTERS, PLACES, readFilters, toggleFrom, togglePlace, withoutLast, type Filters } from "../../web/src/pages/search/filters.ts";

test("From and the place pills are multi-select, kept in the row's order, and all six stay lit", () => {
  let filters = toggleFrom(toggleFrom(NO_FILTERS, "owner"), "ag_vent");
  assert.deepEqual(filters.from, ["owner", "ag_vent"]);
  assert.deepEqual(toggleFrom(filters, "owner").from, ["ag_vent"]);
  filters = togglePlace(togglePlace(filters, "jobs"), "threads");
  assert.deepEqual(filters.place, ["threads", "jobs"]);
  assert.deepEqual(togglePlace(filters, "jobs").place, ["threads"]);
  const all = PLACES.reduce((next, place) => togglePlace(next, place.id), NO_FILTERS);
  assert.deepEqual(all.place, ["channels", "dms", "solo", "threads", "jobs", "tools"]);
  assert.deepEqual(PLACES.map(place => place.label), ["Channels", "DMs", "Solo", "Threads", "Jobs", "Tool calls"]);
  assert.equal(hasFilters(NO_FILTERS), false);
  assert.equal(hasFilters(filters), true);
});

test("each hit sits in the one place the server files it under", () => {
  const hit = (over: Partial<Hit>) => ({ where: "root", kind: "post", conversation: { id: "c", kind: "channel", name: "c" }, ...over }) as Hit;
  assert.equal(hitPlace(hit({})), "channels");
  assert.equal(hitPlace(hit({ conversation: { id: "dm_vent", kind: "dm", name: "Vent" } })), "dms");
  assert.equal(hitPlace(hit({ conversation: { id: "so_1", kind: "solo", name: "Relay" } })), "solo");
  assert.equal(hitPlace(hit({ kind: "message", conversation: { id: "t:1", kind: "solo", name: "chat" } })), "solo");
  assert.equal(hitPlace(hit({ where: "thread", conversation: { id: "dm_vent", kind: "dm", name: "Vent" } })), "threads");
  assert.equal(hitPlace(hit({ where: "tool", kind: "turn", conversation: { id: "t:4", kind: "job", name: "job" } })), "jobs");
  assert.equal(hitPlace(hit({ where: "tool", kind: "tool", conversation: { id: "t:1", kind: "solo", name: "chat" } })), "tools");
});

test("the address holds the filters as comma lists and reads back the same filters", () => {
  const filters: Filters = { from: ["owner", "ag_vent"], place: ["threads", "jobs"], in: "ch_cut", after: "2026-11-01", before: "2026-11-20", has: ["link", "saved"] };
  const params = filterParams(filters);
  assert.deepEqual(params, { from: "owner,ag_vent", place: "threads,jobs", in: "ch_cut", after: "2026-11-01", before: "2026-11-20", has: "link,saved" });
  assert.deepEqual(readFilters(params), filters);
  assert.deepEqual(readFilters({ place: "jobs,nowhere,channels", after: "yesterday", from: "a,,a", has: "saved,file,link" }), { from: ["a"], place: ["channels", "jobs"], has: ["link", "saved"] });
  assert.deepEqual(filterParams(NO_FILTERS), {});
});

test("Backspace takes back the rightmost filter first: Has, Date, In, the last person in From, then the last lit place", () => {
  let filters: Filters = { from: ["owner", "ag_vent"], place: ["threads", "jobs"], in: "c1", after: "2026-11-01", has: ["link"] };
  const steps: string[] = [];
  while (hasFilters(filters)) {
    filters = withoutLast(filters);
    steps.push(JSON.stringify(filterParams(filters)));
  }
  assert.deepEqual(steps, [
    '{"from":"owner,ag_vent","place":"threads,jobs","in":"c1","after":"2026-11-01"}',
    '{"from":"owner,ag_vent","place":"threads,jobs","in":"c1"}',
    '{"from":"owner,ag_vent","place":"threads,jobs"}',
    '{"from":"owner","place":"threads,jobs"}',
    '{"place":"threads,jobs"}',
    '{"place":"threads"}',
    "{}",
  ]);
});

test("the Date chip names a preset or the days of a custom range", () => {
  const now = new Date(2026, 10, 20, 15);
  assert.equal(dateRanges(now).find(range => range.id === "7d")!.after, "2026-11-14");
  assert.equal(dateLabel({ after: "2026-11-14" }, now), "Last 7 days");
  assert.equal(dateLabel({ after: "2026-11-19", before: "2026-11-20" }, now), "Yesterday");
  assert.equal(dateLabel({ after: "2026-11-01", before: "2026-11-05" }, now), "Nov 1 to Nov 5");
  assert.equal(dateLabel({ after: "2025-12-30" }, now), "On or after Dec 30, 2025");
  assert.equal(dateLabel({ before: "2026-11-05" }, now), "Before Nov 5");
  assert.equal(dateLabel({}, now), undefined);
});
