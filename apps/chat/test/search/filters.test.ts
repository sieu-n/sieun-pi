/**
 * The search filter state (web/src/pages/search/filters.ts) that the chips, the typed operators and the results page's address share.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dateLabel, dateRanges, filterParams, hasFilters, NO_FILTERS, readFilters, toggleFrom, toggleWhere, withoutLast, type Filters } from "../../web/src/pages/search/filters.ts";

test("From and Where are multi-select, and picking every place reads as no Where filter", () => {
  let filters = toggleFrom(toggleFrom(NO_FILTERS, "owner"), "ag_vent");
  assert.deepEqual(filters.from, ["owner", "ag_vent"]);
  assert.deepEqual(toggleFrom(filters, "owner").from, ["ag_vent"]);
  filters = toggleWhere(toggleWhere(filters, "tool"), "root");
  assert.deepEqual(filters.where, ["root", "tool"]);
  assert.deepEqual(toggleWhere(filters, "thread").where, []);
  assert.equal(hasFilters(NO_FILTERS), false);
  assert.equal(hasFilters(filters), true);
});

test("the address holds the filters as comma lists and reads back the same filters", () => {
  const filters = { from: ["owner", "ag_vent"], where: ["thread" as const, "tool" as const], in: "ch_cut", after: "2026-11-01", before: "2026-11-20" };
  const params = filterParams(filters);
  assert.deepEqual(params, { from: "owner,ag_vent", where: "thread,tool", in: "ch_cut", after: "2026-11-01", before: "2026-11-20" });
  assert.deepEqual(readFilters(params), filters);
  assert.deepEqual(readFilters({ where: "tool,nowhere,root,thread", after: "yesterday", from: "a,,a" }), { from: ["a"], where: [] });
  assert.deepEqual(filterParams(NO_FILTERS), {});
});

test("Backspace takes back the rightmost chip first: Date, Where, In, then the last person in From", () => {
  let filters: Filters = { from: ["owner", "ag_vent"], where: ["tool"], in: "c1", after: "2026-11-01" };
  const steps: string[] = [];
  while (hasFilters(filters)) {
    filters = withoutLast(filters);
    steps.push(JSON.stringify(filterParams(filters)));
  }
  assert.deepEqual(steps, [
    '{"from":"owner,ag_vent","where":"tool","in":"c1"}',
    '{"from":"owner,ag_vent","in":"c1"}',
    '{"from":"owner,ag_vent"}',
    '{"from":"owner"}',
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
