// 2026-11-25: the move API took wiki pages into folders between 20:31Z and 20:36Z, and dup_unjudged went from 0 to 9. A ledger
// verdict keyed by a page's old path has to count for the page it moved to, or every move reopens the pairs the dream judged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHealth, unjudgedPairs, type Ledger } from "../scripts/duties/wiki-dream.ts";

const OLD = "domains/devops/ci-cd-pipeline/land-and-promote-pick.html";
const NEW = "domains/devops/ci-cd-pipeline/land-and-promote/pick.html";
const OTHER = "domains/devops/ci-time/changes-since-10-19-land-pick.html";

test("a verdict keyed by a page's path from before its move still judges the pair", () => {
  const ledger: Ledger = { pairs: { [`${OLD}|${OTHER}`]: { verdict: "distinct", at: "2026-11-20T10:00:00Z", score: 0.44 } } };
  const health = parseHealth(JSON.stringify({ facts: {}, dupPairs: [{ a: NEW, b: OTHER, score: 0.44 }], moved: { [OLD]: NEW } }));
  assert.deepEqual(unjudgedPairs(health.dupPairs, ledger, health.moved), []);
  assert.deepEqual(unjudgedPairs([{ a: NEW, b: OTHER, score: 0.5 }], ledger, health.moved), [{ a: NEW, b: OTHER, score: 0.5 }]);
});

test("a verdict on the pair's own paths wins over one carried through a move", () => {
  const ledger: Ledger = {
    pairs: {
      [`${NEW}|${OTHER}`]: { verdict: "distinct", score: 0.3 },
      [`${OLD}|${OTHER}`]: { verdict: "distinct", score: 0.9 },
    },
  };
  assert.equal(unjudgedPairs([{ a: NEW, b: OTHER, score: 0.44 }], ledger, { [OLD]: NEW }).length, 1);
});
