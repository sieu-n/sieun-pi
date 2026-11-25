/**
 * `from` keeps an agent name that holds a comma whole (search.ts `wholeNames`): "Search product, misc." split by `listValues` resolves as
 * one name, a plain comma list stays a list, and a piece no run of pieces resolves stays alone so its error names it.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/search-from-names.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { listValues, wholeNames } from "../../server/search.ts";

const names = new Set(["owner", "vent", "search product, misc.", "a, b, c"]);
const resolves = (value: string) => names.has(value.toLowerCase());

test("comma pieces of one agent name join back, the longest run that names an agent wins, and other values stay apart", () => {
  assert.deepEqual(wholeNames(listValues(["Search product, misc."]), resolves), ["Search product, misc."]);
  assert.deepEqual(wholeNames(listValues(["owner,Search product, misc.,vent"]), resolves), ["owner", "Search product, misc.", "vent"]);
  assert.deepEqual(wholeNames(listValues(["a, b, c"]), resolves), ["a, b, c"]);
  assert.deepEqual(wholeNames(listValues(["owner, vent"]), resolves), ["owner", "vent"]);
  assert.deepEqual(wholeNames(listValues(["nobody, vent"]), resolves), ["nobody", "vent"], "an unknown piece stays alone, so its error names it");
});
