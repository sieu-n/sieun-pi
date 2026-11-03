// On 10-30 and 10-31 (KST) the Wiki dream started 25 and 26 jobs, 84 of the week's 105 for followed pages alone, because a push run started a
// job for any page in its 70 min follow window, so each burst of code commits made its own job. A followed page now waits until it is within
// 40 min (FOLLOW_LEAD_MS) of its window end, flagged with no handOff, and the job a due page starts takes the waiting pages too
// (~/work/wiki-checks-batch/measure.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureDream, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const NOW = Date.parse("2026-10-31T22:00:00Z");
const MIN = 60_000;
const ago = (min: number): string => new Date(NOW - min * MIN).toISOString();
const page = (path: string, behindMin: number) => ({ path, title: path, last_verified: ago(200), verified_at: ago(200),
  staleRefs: [{ ref: `apps/x/${path}.ts`, modified: ago(behindMin), since: ago(behindMin) }] });

function deps(stale: object[]): DreamDeps {
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: stale.length, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }), harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }), ledger: JSON.stringify({ classes: {} }),
  };
  return {
    now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => files[path]!,
    exec: async file => file === "node" ? JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale } }) : "",
  };
}

test("followed pages with more than the lead left wait with no handOff, so a push run starts no job for them", async () => {
  const result = await measureDream(deps([page("a", 5), page("b", 20), page("c", 30)]), []);
  assert.equal(result.metrics.wiki_problems, 0);
  assert.equal(result.metrics.wiki_problems_following, 0, "the oldest page is 30 min behind, 40 min before its window end");
  assert.equal(result.info.pages_waiting, 3);
  const stale = (result.flagged ?? []).filter(slice => slice.kind === "stale_vs_code");
  assert.deepEqual(stale.map(slice => slice.item), ["c", "b", "a"], "the waiting pages stay in the job's list");
  assert.ok(stale.every(slice => slice.handOff === undefined), "no waiting page is work a push run acts on");
});

test("one page near its window end is the part a push run acts on, and the job it starts lists the waiting pages too", async () => {
  const result = await measureDream(deps([page("a", 5), page("b", 20), page("c", 31)]), []);
  assert.equal(result.metrics.wiki_problems, 0);
  assert.equal(result.metrics.wiki_problems_following, 1);
  assert.equal(result.info.pages_waiting, 2);
  const stale = (result.flagged ?? []).filter(slice => slice.kind === "stale_vs_code");
  assert.deepEqual(stale.map(slice => [slice.item, slice.handOff]), [["c", true], ["b", undefined], ["a", undefined]]);
});

test("a page past its window counts in wiki_problems and keeps its handOff", async () => {
  const result = await measureDream(deps([page("a", 5), page("old", 75)]), []);
  assert.equal(result.metrics.wiki_problems, 1);
  assert.equal(result.metrics.wiki_problems_following, 0);
  const stale = (result.flagged ?? []).filter(slice => slice.kind === "stale_vs_code");
  assert.deepEqual(stale.map(slice => [slice.item, slice.handOff]), [["old", true], ["a", undefined]]);
});
