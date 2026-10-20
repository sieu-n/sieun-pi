// Guards the wiki dream count of 2026-10-20. pages_behind_code re-dated wiki-health's stale list against the end of each
// last_verified day, so a change later on the check's own day never counted and a last_verified time read as no day at all.
// The engine now dates both sides on the tip, and the precheck counts its list as given, whatever git says of the refs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureDream, parseStale, staleExcerpt, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const NOW = Date.parse("2026-10-20T03:00:00Z");
const sec = (iso: string): string => (Date.parse(iso) / 1000).toFixed(6);
const JOURNAL = [
  `${sec("2026-10-20T02:55:00Z")} us-metal02 systemd[1]: Starting wiki-box-commit.service - wiki-box-commit`,
  `${sec("2026-10-20T02:55:10Z")} us-metal02 systemd[1]: Finished wiki-box-commit.service - wiki-box-commit`,
].join("\n");
const STALE = {
  checkable: 3, count: 2,
  stale: [
    { path: "domains/architecture/outside-calls.html", title: "Outside calls", last_verified: "2026-10-20", verified_at: "2026-10-20T01:12:38.000Z",
      staleRefs: [{ ref: "apps/vent/src/vent/tables.py", modified: "2026-10-20T02:14:30.000Z" }] },
    { path: "domains/architecture/telemetry-map.html", title: "Telemetry map", last_verified: "2026-10-20T01:00Z", verified_at: "2026-10-20T01:00:00.000Z",
      staleRefs: [{ ref: "apps/vent/README.md", modified: "2026-10-20T02:14:30.000Z" }, { ref: "apps/vent/gone.py", modified: "missing — ref no longer exists" }] },
  ],
};

function deps(): DreamDeps {
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 2, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }),
    harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }),
    ledger: JSON.stringify({ classes: {} }),
  };
  return {
    now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger" },
    readText: async path => files[path]!,
    exec: async (file, args) => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: STALE });
      if (file === "journalctl") return JOURNAL;
      if (args.includes("--first-parent")) return `\x1e${Date.parse("2026-10-20T02:14:30Z") / 1000}\napps/vent/src/vent/tables.py\napps/vent/README.md\n`;
      if (args.includes("ls-tree")) return "apps/vent/src/vent/tables.py\0apps/vent/README.md\0";
      return "";
    },
  };
}

test("every page of the engine's stale list counts, a change on the check's own day and a last_verified time included", async () => {
  const result = await measureDream(deps(), []);
  assert.equal(result.metrics.pages_behind_code, 2);
  assert.equal(result.metrics.wiki_problems, 2);
  assert.equal(result.metrics.source_errors, 0);
  const stale = (result.flagged ?? []).filter(slice => slice.kind === "stale_vs_code");
  assert.deepEqual(stale.map(slice => slice.item), ["domains/architecture/outside-calls.html", "domains/architecture/telemetry-map.html"]);
  assert.equal(stale[0]!.excerpt, "checked 2026-10-20T01:12Z (last_verified 2026-10-20); code changed since: apps/vent/src/vent/tables.py (2026-10-20T02:14Z)");
});

test("a stale row with no verified_at, from a cited path git lacks, names its last_verified and the missing ref", () => {
  const [page] = parseStale({ stale: [{ path: "a.html", last_verified: "1970-01-01", staleRefs: [{ ref: "scripts/deploy.sh", modified: "missing — ref no longer exists" }] }] });
  assert.equal(staleExcerpt(page!), "checked 1970-01-01 (last_verified 1970-01-01); code changed since: scripts/deploy.sh (missing)");
});
