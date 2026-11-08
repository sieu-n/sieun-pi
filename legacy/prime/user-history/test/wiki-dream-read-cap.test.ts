// Guards the 2026-11-09 05:02 wiki dream run: dream writers grew curated pages toward the 65,536 B read cap, the write API warned only once
// a write crossed it, and three pages sat within 1 KB of it (census-one-profile.html at 64,564 B, outside-calls.html, serp-api/index.html at
// 65,062 B), so the run split them by hand and a writer cut a table to fit. The precheck now counts each page past NEAR_READ_CAP.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { measureDream, NEAR_READ_CAP, PAGE_READ_CAP, readPageSizes, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
const deps: DreamDeps = {
  now: Date.parse("2026-11-09T06:00:00Z"), node: "node", repos: { wiki: "/wiki", pi: "/pi" },
  files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
  readText: async path => ({ corrections: '{"corrections":[]}', harness: '{"entries":{}}', ledger: "{}" })[path]!,
  exec: async file => file === "node" ? JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } }) : "",
};

test("each current curated page at NEAR_READ_CAP bytes or more counts in wiki_problems and is handed off as near_read_cap", async () => {
  assert.equal(NEAR_READ_CAP, 63_172);
  const result = await measureDream({ ...deps, pageSizes: async () => [
    { path: "apps/crawler-v3/platforms/instagram/census-one-profile.html", bytes: 64_564, status: "current" },
    { path: "apps/crawler-v3/architecture/serp-api/index.html", bytes: 65_062, status: "living" },
    { path: "apps/search/brand-tracking.html", bytes: 65_788 },
    { path: "domains/devops/service-addresses.html", bytes: NEAR_READ_CAP - 1, status: "current" },
    { path: "apps/crawler-v3/xiaohongshu-index-gaps/index.html", bytes: 64_000, status: "archived" },
  ] }, []);
  assert.equal(result.metrics.pages_near_read_cap, 3);
  assert.equal(result.metrics.wiki_problems, 3);
  const flagged = (result.flagged ?? []).filter(slice => slice.kind === "near_read_cap");
  assert.deepEqual(flagged.map(slice => slice.item), [
    "apps/search/brand-tracking.html", "apps/crawler-v3/architecture/serp-api/index.html", "apps/crawler-v3/platforms/instagram/census-one-profile.html",
  ]);
  assert.ok(flagged.every(slice => slice.handOff));
  assert.match(flagged[0]!.excerpt, new RegExp(`65788 B, ${65_788 - PAGE_READ_CAP} B over the 65536 B read cap`));
  assert.match(flagged[2]!.excerpt, /64564 B, 972 B under the 65536 B read cap.*split it/);
});

test("page sizes that cannot be read put 999999 on wiki_problems with a source_error", async () => {
  const result = await measureDream({ ...deps, pageSizes: async () => { throw new Error("EACCES"); } }, []);
  assert.equal(result.metrics.pages_near_read_cap, 999_999);
  assert.equal(result.metrics.wiki_problems, 999_999);
  assert.deepEqual((result.flagged ?? []).filter(slice => slice.kind === "source_error").map(slice => slice.item), ["page sizes"]);
});

test("readPageSizes reads the stored bytes and status of the curated pages, skipping data, assets and dot folders", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-dream-read-cap-"));
  try {
    const page = (path: string, header: string, body = "<h1>x</h1>") => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `<!--wiki\n${header}\n-->\n${body}`);
    };
    page("index.html", '{"title": "Home"}');
    page("apps/search/a.html", '{"title": "A", "status": "current"}', "é".repeat(10));
    page("domains/b/old.html", '{"title": "B", "status": "superseded"}');
    page("apps/search/data/dump.html", "{}");
    page("apps/search/assets/x.html", "{}");
    page("apps/search/.cache/y.html", "{}");
    page("sessions/2026/11/09/z.html", "{}");
    const sizes = (await readPageSizes(root)).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(sizes.map(row => [row.path, row.status]), [["apps/search/a.html", "current"], ["domains/b/old.html", "superseded"], ["index.html", undefined]]);
    assert.equal(sizes[0]!.bytes, Buffer.byteLength('<!--wiki\n{"title": "A", "status": "current"}\n-->\n') + 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
