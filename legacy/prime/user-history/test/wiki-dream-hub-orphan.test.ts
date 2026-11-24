// Guards the d4 run of 2026-11-21 23:00:16Z: agent-factory created domains/devops/sw-factory-threads/architecture.html at 22:59:41Z and
// its hub row 39 s later, because the page API refuses a hub row written before its page exists, and that run read wiki_problems 1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FOLLOW_WINDOW_MS, measureDream, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const page = "domains/devops/sw-factory-threads/architecture.html";
const old = "domains/devops/old-orphan.html";
const facts = { hub_orphans: 3, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0, over_core_length: 0 };
const items = [page, old, "domains/devops/hand-made.html"].map(path => ({ kind: "hub_orphan", path, excerpt: "no ancestor hub lists it (nearest hub domains/devops/index.html)" }));
const deps: DreamDeps = {
  now: 0, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
  files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
  readText: async path => ({ corrections: '{"corrections":[]}', harness: '{"entries":{}}', ledger: "{}" })[path]!,
  exec: async file => file === "node" ? JSON.stringify({ facts, items, errors: [], dupPairs: [], signals: [], stale: { stale: [] } }) : "",
  // The new page's first revision, an edit of an older orphan whose version 1 the rows do not hold, and no row for the hand-made page.
  revisions: async () => [
    { path: page, version: 1, author: "agent-factory", summary: "", ts: "2026-11-21T22:59:41.238Z", bytesBefore: 0, bytesAfter: 28_493 },
    { path: old, version: 7, author: "prime", summary: "", ts: "2026-11-21T22:50:00.000Z", bytesBefore: 4_000, bytesAfter: 4_100 },
  ],
};

test("a hub orphan created within FOLLOW_WINDOW_MS is followed, and counts in wiki_problems once the window ends", async () => {
  const early = await measureDream({ ...deps, now: Date.parse("2026-11-21T23:00:16Z") }, []);
  assert.equal(early.metrics.hub_orphans, 2);
  assert.equal(early.metrics.wiki_problems, 2);
  assert.equal(early.metrics.wiki_problems_following, 1);
  const flagged = (early.flagged ?? []).filter(slice => slice.kind === "hub_orphan");
  assert.equal(flagged.length, 3);
  assert.match(flagged.find(slice => slice.item === page)!.excerpt, /; created at 22:59Z, counts in wiki_problems at 00:09Z$/);
  assert.doesNotMatch(flagged.find(slice => slice.item === old)!.excerpt, /counts in wiki_problems/);

  const late = await measureDream({ ...deps, now: Date.parse("2026-11-21T22:59:41.238Z") + FOLLOW_WINDOW_MS + 1 }, []);
  assert.equal(late.metrics.hub_orphans, 3);
  assert.equal(late.metrics.wiki_problems, 3);
  assert.equal(late.metrics.wiki_problems_following, 0);
});
