import assert from "node:assert/strict";
import { test } from "node:test";
import { absorb, withoutPrompt, chipLabel, datePresets, filters, isDate, prompt, searchText, withOperator } from "../../web/src/pages/search/operators.ts";
import { matchName, pieces, snippetPieces } from "../../web/src/pages/search/match.ts";

test("prompt finds the operator being typed at the end only", () => {
  assert.deepEqual(prompt("deploy from:an"), { kind: "from", needle: "an", start: 7 });
  assert.deepEqual(prompt("in:"), { kind: "in", needle: "", start: 0 });
  assert.equal(prompt("built-in:react"), undefined);
  assert.equal(prompt("from:ann deploy"), undefined);
});

const resolve = (kind: "from" | "in", value: string) =>
  value.toLowerCase() === "owner" ? { kind, id: "owner", label: "Sieun" } : undefined;

test("a completed valid date or known name becomes a chip, and the rest stays as text", () => {
  assert.deepEqual(absorb("canary after:2026-10-01 ", [], resolve), { text: "canary ", operators: [{ kind: "after", date: "2026-10-01" }] });
  assert.deepEqual(absorb("after:2026-02-30 x", [], resolve), { text: "after:2026-02-30 x", operators: [] });
  assert.deepEqual(absorb("from:@owner relay", [], resolve), { text: "relay", operators: [{ kind: "from", id: "owner", label: "Sieun" }] });
  assert.deepEqual(absorb("from:nobody relay", [], resolve).operators, []);
  assert.equal(absorb("relay from:owner", [], resolve).text, "relay from:owner");
  assert.equal(withoutPrompt("relay from:ow", { kind: "from", needle: "ow", start: 6 }), "relay ");
  assert.equal(isDate("2026-02-28"), true);
  assert.equal(isDate("yesterday"), false);
});

test("a later operator of one kind replaces the earlier one", () => {
  const ops = withOperator([{ kind: "from", id: "a", label: "Ann" }, { kind: "after", date: "2026-01-01" }], { kind: "from", id: "b", label: "Bo" });
  assert.deepEqual(ops.map(chipLabel), ["after:2026-01-01", "from:@Bo"]);
});

test("filters send ids and dates, and leave an unfinished prompt out of q", () => {
  assert.deepEqual(filters("rate limit from:a", [{ kind: "in", id: "c1", label: "general" }, { kind: "before", date: "2026-10-20" }]), {
    q: "rate limit", in: "c1", before: "2026-10-20",
  });
  assert.equal(searchText("  two   words "), "two words");
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
