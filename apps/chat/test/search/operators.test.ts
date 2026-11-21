import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_FILTERS } from "../../web/src/pages/search/filters.ts";
import { absorb, withoutPrompt, datePresets, duringRange, isDate, prompt, searchText, withOperator } from "../../web/src/pages/search/operators.ts";
import { matchName, pieces, snippetPieces } from "../../web/src/pages/search/match.ts";

test("prompt finds the operator being typed at the end only", () => {
  assert.deepEqual(prompt("deploy from:an"), { kind: "from", needle: "an", start: 7 });
  assert.deepEqual(prompt("in:"), { kind: "in", needle: "", start: 0 });
  assert.equal(prompt("built-in:react"), undefined);
  assert.equal(prompt("from:ann deploy"), undefined);
});

const resolve = (kind: "from" | "in" | "to" | "with", value: string) =>
  kind === "to" || kind === "with" ? (value.toLowerCase() === "vent" ? "dm_vent" : undefined) : value.toLowerCase() === "owner" ? "owner" : undefined;

test("a completed valid date or known name lands in the filters, and the rest stays as text", () => {
  assert.deepEqual(absorb("canary after:2026-10-01 ", NO_FILTERS, resolve), { text: "canary ", filters: { ...NO_FILTERS, after: "2026-10-01" } });
  assert.deepEqual(absorb("after:2026-02-30 x", NO_FILTERS, resolve), { text: "after:2026-02-30 x", filters: NO_FILTERS });
  assert.deepEqual(absorb("from:@owner relay", NO_FILTERS, resolve), { text: "relay", filters: { ...NO_FILTERS, from: ["owner"] } });
  assert.deepEqual(absorb("from:nobody relay", NO_FILTERS, resolve).filters, NO_FILTERS);
  assert.equal(absorb("relay from:owner", NO_FILTERS, resolve).text, "relay from:owner");
  assert.equal(withoutPrompt("relay from:ow", { kind: "from", needle: "ow", start: 6 }), "relay ");
  assert.equal(isDate("2026-02-28"), true);
  assert.equal(isDate("yesterday"), false);
});

test("a typed from: adds a person to the From chip, and in:, after: and before: replace their value", () => {
  let filters = withOperator({ ...NO_FILTERS, from: ["a"], in: "c1" }, { kind: "from", id: "b" });
  filters = withOperator(filters, { kind: "from", id: "a" });
  filters = withOperator(filters, { kind: "in", id: "c2" });
  assert.deepEqual(filters, { from: ["a", "b"], place: [], has: [], in: "c2" });
  assert.equal(searchText("rate limit from:a"), "rate limit");
  assert.equal(searchText("  two   words "), "two words");
});

test("has:, is:, on:, during:, to: and with: filter instead of matching as words", () => {
  const now = new Date(2026, 10, 20, 15);
  const read = (text: string) => absorb(text, NO_FILTERS, resolve, now);
  assert.deepEqual(read("relay has:link is:saved has:reaction "), { text: "relay ", filters: { ...NO_FILTERS, has: ["link", "reaction", "saved"] } });
  assert.deepEqual(read("is:thread relay").filters.place, ["threads"]);
  assert.deepEqual(read("has:file relay"), { text: "has:file relay", filters: NO_FILTERS });
  assert.deepEqual(read("on:2026-11-20 x").filters, { ...NO_FILTERS, after: "2026-11-20", before: "2026-11-21" });
  assert.deepEqual(read("on:yesterday x").filters, { ...NO_FILTERS, after: "2026-11-19", before: "2026-11-20" });
  assert.deepEqual(read("during:november x").filters, { ...NO_FILTERS, after: "2026-11-01", before: "2026-12-01" });
  assert.deepEqual(read("during:dec x").filters, { ...NO_FILTERS, after: "2025-12-01", before: "2026-01-01" }, "a month not yet begun is last year's");
  assert.deepEqual(read("during:2026-02 x").filters, { ...NO_FILTERS, after: "2026-02-01", before: "2026-03-01" });
  assert.deepEqual(read("during:week x").filters, { ...NO_FILTERS, after: "2026-11-16", before: "2026-11-23" });
  assert.deepEqual(read("during:someday x").text, "during:someday x");
  assert.deepEqual(read("with:vent x").filters, { ...NO_FILTERS, in: "dm_vent" });
  assert.deepEqual(read("to:@vent x").filters, { ...NO_FILTERS, in: "dm_vent", from: ["owner"] });
  assert.deepEqual(prompt("x has:li"), { kind: "has", needle: "li", start: 2 });
  assert.deepEqual(duringRange("year", now), { kind: "during", after: "2026-01-01", before: "2027-01-01" });
});

test("date presets start weeks on Monday", () => {
  const presets = datePresets(new Date(2026, 9, 28, 15));
  assert.deepEqual(presets.map(p => p.date), ["2026-10-28", "2026-10-27", "2026-10-26", "2026-10-19", "2026-10-01"]);
});

test("matchName ranks whole, prefix, word prefix and inside", () => {
  assert.equal(matchName("Vent", "vent")?.rank, 0);
  assert.equal(matchName("Venture", "ven")?.rank, 1);
  assert.equal(matchName("pi-host canary", "canary")?.rank, 2);
  assert.equal(matchName("pi-host canary", "nar")?.rank, 3);
  assert.equal(matchName("pi-host canary", "zzz"), undefined);
  assert.deepEqual(matchName("pi-host canary", "pi can")?.positions, [0, 1, 8, 9, 10]);
  assert.equal(matchName("general", "#gen")?.rank, 1);
});

test("pieces and snippetPieces mark only the matched runs and never trust markup", () => {
  assert.deepEqual(pieces("Vent", [0, 1]), [{ text: "Ve", mark: true }, { text: "nt", mark: false }]);
  assert.deepEqual(snippetPieces("a <mark>rate</mark> &lt;b&gt;"), [{ text: "a ", mark: false }, { text: "rate", mark: true }, { text: " <b>", mark: false }]);
});
