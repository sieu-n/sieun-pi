// Guards the wiki dream blind spot of 2026-10-19. The wiki host batch (wiki-box-commit) left the rewritten
// experiments/2026-08-19-email-finder-round4/index.html out of git for 23 h, then the page was reset on disk and the fix was lost,
// while wiki_problems read 0, because wiki-health reads HEAD and nothing read the batch's "left out" log lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureDream, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const NOW = Date.parse("2026-10-19T17:00:00Z");
const sec = (iso: string): string => (Date.parse(iso) / 1000).toFixed(6);
const C = "apps/llm-wiki/content/";
const run = (iso: string, leftOut: [string, string][]): string[] => [
  `${sec(iso)} us-metal02 systemd[257985]: Starting wiki-box-commit.service - wiki-box-commit: commit the wiki pages written on this wiki host onto its sieun/dev...`,
  ...leftOut.map(([path, reason]) => `${sec(iso)} us-metal02 node[2446902]: wiki-box-commit: left out ${C}${path}: ${reason}`),
  `${sec(iso)} us-metal02 systemd[257985]: Finished wiki-box-commit.service - wiki-box-commit: commit the wiki pages written on this wiki host onto its sieun/dev.`,
];
const CONFLICT = "it was edited from its copy at 075b86f2c2, and the edit conflicts with 7869f0b0b9; bring that change into the page";
const RETIRED = "it links the retired page apps/crawler-v3/instagram-index-gaps/index.html; link the page that replaced it, or leave the link out";
const SESSION = "sessions/2026/10/14/1256-crawler-ops-train/ledger.md";
const JOURNAL = [
  ...run("2026-10-19T16:00:00Z", [["apps/convex/index.html", CONFLICT], [SESSION, CONFLICT], ["apps/landed-later.html", RETIRED]]),
  `${sec("2026-10-19T16:20:00Z")} us-metal02 node[1]: wiki-box-commit: left out ${C}apps/outside-a-run.html: ${RETIRED}`,
  ...run("2026-10-19T16:25:00Z", [["apps/convex/index.html", CONFLICT], [SESSION, CONFLICT]]),
  ...run("2026-10-19T16:46:00Z", [["apps/crawler-v3/youtube-index-gaps/index.html", RETIRED]]),
  ...run("2026-10-19T16:51:00Z", [["apps/convex/index.html", CONFLICT], [SESSION, CONFLICT], ["apps/crawler-v3/youtube-index-gaps/index.html", RETIRED]]),
  `${sec("2026-10-19T16:56:00Z")} us-metal02 systemd[257985]: Starting wiki-box-commit.service - still running`,
  `${sec("2026-10-19T16:56:10Z")} us-metal02 node[3]: wiki-box-commit: left out ${C}apps/still-running.html: ${RETIRED}`,
].join("\n");

function deps(journal: string): DreamDeps {
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }),
    harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }),
    ledger: JSON.stringify({ classes: {} }),
  };
  return {
    now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => files[path]!,
    exec: async file => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } });
      if (file === "journalctl") return journal;
      return "";
    },
  };
}

test("a curated page the wiki host batch keeps leaving out of git for 30 min counts in wiki_problems", async () => {
  const result = await measureDream(deps(JOURNAL), []);
  assert.equal(result.metrics.unlanded, 1);
  assert.equal(result.metrics.wiki_problems, 1);
  assert.equal(result.metrics.source_errors, 0);
  const unlanded = (result.flagged ?? []).filter(slice => slice.kind.startsWith("unlanded"));
  assert.deepEqual(unlanded.map(slice => [slice.kind, slice.item]), [["unlanded", "apps/convex/index.html"], ["unlanded_session", SESSION]]);
  assert.match(unlanded[0]!.excerpt, /in 3 runs from 2026-10-19T16:00Z to 2026-10-19T16:51Z: it was edited from its copy at 075b86f2c2/);
  assert.equal(result.info.unlanded_sessions, 1);
  assert.equal(result.info.box_runs_24h, 4);
});

test("a wiki host journal with no finished run leaves wiki_problems unmeasured", async () => {
  const result = await measureDream(deps("-- No entries --"), []);
  assert.equal(result.metrics.wiki_problems, 999_999);
  assert.ok((result.flagged ?? []).some(slice => slice.kind === "source_error" && /journalctl wiki-box-commit/.test(slice.excerpt)));
});
