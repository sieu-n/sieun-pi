// Owner, 2026-11-24 (#dev-crawler p23, c243): an apps/ or domains/ page holds only the layers a reader can check, near 800 words, and 391
// of 548 such pages were over that line that day. wiki-health counts the live ones in over_core_length, and the precheck adds them to
// wiki_problems as pages_over_core_length and hands each page off, so a rewritten page that grows long again counts at once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveClaims, measureDream, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
const deps = (health: object, claims?: object): DreamDeps => ({
  now: Date.parse("2026-11-24T06:00:00Z"), node: "node", repos: { wiki: "/wiki", pi: "/pi" },
  files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir", claims: "claims" },
  readText: async path => {
    if (path === "claims") {
      if (!claims) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      return JSON.stringify(claims);
    }
    return ({ corrections: '{"corrections":[]}', harness: '{"entries":{}}', ledger: "{}" })[path]!;
  },
  exec: async file => file === "node" ? JSON.stringify({ items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] }, ...health }) : "",
});

test("each live apps/ or domains/ page over the core-length line counts in wiki_problems and is handed off", async () => {
  const items = [
    { kind: "over_core_length", path: "apps/admin/index.html", excerpt: "1840 words, target 800, 40 views in 30 days" },
    { kind: "over_core_length", path: "domains/devops/deploy-runbook.html", excerpt: "1201 words, target 800, 3 views in 30 days" },
  ];
  const result = await measureDream(deps({ facts: { ...facts, over_core_length: 2 }, items }), []);
  assert.equal(result.metrics.pages_over_core_length, 2);
  assert.equal(result.metrics.wiki_problems, 2);
  const flagged = (result.flagged ?? []).filter(slice => slice.kind === "over_core_length");
  assert.deepEqual(flagged.map(slice => slice.item), ["apps/admin/index.html", "domains/devops/deploy-runbook.html"]);
  assert.ok(flagged.every(slice => slice.handOff));
});

test("a wiki-health run with no over_core_length fact leaves wiki_problems unmeasured with a source_error", async () => {
  const result = await measureDream(deps({ facts }), []);
  assert.equal(result.metrics.pages_over_core_length, 999_999);
  assert.equal(result.metrics.wiki_problems, 999_999);
  assert.ok((result.flagged ?? []).some(slice => slice.kind === "source_error" && /no fact over_core_length/.test(slice.excerpt)));
});

test("a page another session claims until a later time still counts but is not flagged, and an expired claim lets it back", async () => {
  const items = [
    { kind: "over_core_length", path: "apps/admin/index.html", excerpt: "1840 words, target 800, 40 views in 30 days" },
    { kind: "over_core_length", path: "apps/blog/index.html", excerpt: "2022 words, target 800, 60 views in 30 days" },
    { kind: "over_core_length", path: "apps/vent/index.html", excerpt: "4090 words, target 800, 100 views in 30 days" },
  ];
  const claims = { claims: [
    { key: "over_core_length|apps/admin/index.html", by: "wiki pages to the core", until: "2026-11-24T12:00:00Z" },
    { key: "over_core_length|apps/blog/index.html", by: "wiki pages to the core", until: "2026-11-24T05:00:00Z" },
  ] };
  const result = await measureDream(deps({ facts: { ...facts, over_core_length: 3 }, items }, claims), []);
  assert.equal(result.metrics.pages_over_core_length, 3);
  assert.equal(result.metrics.wiki_problems, 3);
  assert.equal(result.info.claimed_items, 1);
  assert.deepEqual((result.flagged ?? []).filter(slice => slice.kind === "over_core_length").map(slice => slice.item), ["apps/blog/index.html", "apps/vent/index.html"]);
});

test("liveClaims keeps unexpired rows with a key and a holder, and a file with no claims list fails the input", () => {
  const now = Date.parse("2026-11-24T06:00:00Z");
  assert.deepEqual([...liveClaims({ claims: [
    { key: "over_core_length|a.html", by: "x", until: "2026-11-25T00:00:00Z" },
    { key: "over_core_length|b.html", until: "2026-11-25T00:00:00Z" },
    { key: "over_core_length|c.html", by: "x", until: "not a date" },
  ] }, now)], ["over_core_length|a.html"]);
  assert.throws(() => liveClaims([], now), /no claims list/);
});

test("a claims file that does not parse is a source_error, and no claim holds", async () => {
  const result = await measureDream({ ...deps({ facts: { ...facts, over_core_length: 0 } }), readText: async path => path === "claims" ? "{" : ({ corrections: '{"corrections":[]}', harness: '{"entries":{}}', ledger: "{}" })[path]! }, []);
  assert.ok((result.flagged ?? []).some(slice => slice.kind === "source_error" && slice.item === "claims"));
});
