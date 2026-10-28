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
  ...run("2026-10-19T16:46:00Z", [["apps/convex/index.html", CONFLICT], [SESSION, CONFLICT], ["apps/crawler-v3/youtube-index-gaps/index.html", RETIRED]]),
  ...run("2026-10-19T16:51:00Z", [["apps/convex/index.html", CONFLICT], [SESSION, CONFLICT], ["apps/crawler-v3/youtube-index-gaps/index.html", RETIRED]]),
  `${sec("2026-10-19T16:56:00Z")} us-metal02 systemd[257985]: Starting wiki-box-commit.service - still running`,
  `${sec("2026-10-19T16:56:10Z")} us-metal02 node[3]: wiki-box-commit: left out ${C}apps/still-running.html: ${RETIRED}`,
].join("\n");

function deps(journal: string, disk: Record<string, string> = {}): DreamDeps {
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }),
    harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }),
    ledger: JSON.stringify({ classes: {} }),
  };
  return {
    now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => {
      const text = files[path] ?? disk[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
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
  assert.match(unlanded[0]!.excerpt, /in 4 runs from 2026-10-19T16:00Z to 2026-10-19T16:51Z: it was edited from its copy at 075b86f2c2/);
  assert.equal(result.info.unlanded_sessions, 1);
  assert.equal(result.info.box_runs_24h, 4);
});

test("a wiki host journal with no finished run leaves wiki_problems unmeasured", async () => {
  const result = await measureDream(deps("-- No entries --"), []);
  assert.equal(result.metrics.wiki_problems, 999_999);
  assert.ok((result.flagged ?? []).some(slice => slice.kind === "source_error" && /journalctl wiki-box-commit/.test(slice.excerpt)));
});

const failedRun = (iso: string, leftOut: [string, string][]): string[] => [
  ...run(iso, leftOut).slice(0, -1),
  `${sec(iso)} us-metal02 systemd[257985]: wiki-box-commit.service: Failed with result 'exit-code'.`,
];

// The 10-28 14:34Z d4 after-measure read wiki_problems 1 from apps/search/brand-tracking.html. The batch left it out once at 10:29Z, the page
// landed four times after that, and the batch left it out again only from 14:20Z, so its streak was 15 min old, inside UNLANDED_MS.
test("a page the batch left out once hours ago and again for under 30 min now does not count", async () => {
  const AHEAD = "it cites convex/search/watches/counterFold.ts, which the tip does not have yet; the page reaches git with the code commit that adds it";
  const PAGE = "apps/search/brand-tracking.html";
  const journal = [
    ...run("2026-10-19T12:29:00Z", [[PAGE, AHEAD]]),
    ...run("2026-10-19T12:34:00Z", []),
    ...run("2026-10-19T16:20:00Z", [[PAGE, AHEAD]]),
    ...run("2026-10-19T16:25:00Z", [[PAGE, AHEAD]]),
    ...run("2026-10-19T16:30:00Z", [[PAGE, AHEAD]]),
    ...run("2026-10-19T16:35:00Z", [[PAGE, AHEAD]]),
  ].join("\n");
  const result = await measureDream(deps(journal), []);
  assert.equal(result.metrics.unlanded, 0);
  assert.equal(result.metrics.wiki_problems, 0);
});

test("a failed run that names no page keeps a 30 min left-out streak going, and a finished one ends it", async () => {
  const PAGE = "apps/convex/index.html";
  const streak = (middle: string[]): string => [
    ...run("2026-10-19T16:00:00Z", [[PAGE, CONFLICT]]),
    ...middle,
    ...run("2026-10-19T16:51:00Z", [[PAGE, CONFLICT]]),
  ].join("\n");
  const failed = await measureDream(deps(streak(failedRun("2026-10-19T16:25:00Z", []))), []);
  assert.equal(failed.metrics.unlanded, 1);
  assert.match((failed.flagged ?? []).find(slice => slice.kind === "unlanded")!.excerpt, /in 2 runs from 2026-10-19T16:00Z to 2026-10-19T16:51Z/);
  const finished = await measureDream(deps(streak(run("2026-10-19T16:25:00Z", []))), []);
  assert.equal(finished.metrics.unlanded, 0);
});

// From 14:20Z on 10-28 the batch held apps/search/brand-tracking.html until the code it cites was committed, by design (wiki-box-commit.mjs
// aheadRows), while that code sat uncommitted in the checkout, and wiki_problems read 1 and fired push runs for a page with nothing to fix.
const AHEAD_HOLD = "it cites convex/search/watches/counterFold.ts, convex/search/watches/counterFold.ts::fold, convex/search/imports/jobs.ts::pushLater, "
  + "sieun-pi:packages/pi-pool, which the tip does not have yet; the page reaches git with the code commit that adds it";
const HELD = "apps/search/brand-tracking.html";
const held = [
  ...run("2026-10-19T16:00:00Z", [[HELD, AHEAD_HOLD]]),
  ...run("2026-10-19T16:25:00Z", [[HELD, AHEAD_HOLD]]),
  ...run("2026-10-19T16:51:00Z", [[HELD, AHEAD_HOLD]]),
].join("\n");
const CODE = {
  "/wiki/convex/search/watches/counterFold.ts": "export function fold() {}",
  "/wiki/convex/search/imports/jobs.ts": "export const pushLater = 1;",
};
const folder = async (path: string): Promise<string> => {
  if (path === "/pi/packages/pi-pool") throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};

test("a page held until the code it cites is committed, with that code on disk, is info and not a wiki problem", async () => {
  const base = deps(held, CODE);
  const result = await measureDream({ ...base, readText: path => base.readText(path).catch(() => folder(path)) }, []);
  assert.equal(result.metrics.unlanded, 0);
  assert.equal(result.metrics.wiki_problems, 0);
  assert.equal(result.info.unlanded_ahead, 1);
  const slice = (result.flagged ?? []).find(item => item.item === HELD)!;
  assert.equal(slice.kind, "unlanded_ahead");
  assert.match(slice.excerpt, /every cited ref is on disk in the checkout/);
});

test("a held page counts in wiki_problems once a cited file or definition is gone from disk", async () => {
  for (const disk of [
    { "/wiki/convex/search/imports/jobs.ts": CODE["/wiki/convex/search/imports/jobs.ts"] },
    { ...CODE, "/wiki/convex/search/watches/counterFold.ts": "export function unfold() {}" },
  ]) {
    const base = deps(held, disk);
    const result = await measureDream({ ...base, readText: path => base.readText(path).catch(() => folder(path)) }, []);
    assert.equal(result.metrics.unlanded, 1);
    assert.equal(result.metrics.wiki_problems, 1);
    assert.equal(result.info.unlanded_ahead, 0);
    assert.equal((result.flagged ?? []).find(item => item.item === HELD)!.kind, "unlanded");
  }
});

test("a gate refusal counts in wiki_problems even when every path it names is on disk", async () => {
  const DEAD = "it cites convex/search/watches/counterFold.ts, which git does not have; fix the path, leave it out, or say on the same line that it was removed";
  const journal = [
    ...run("2026-10-19T16:00:00Z", [[HELD, DEAD]]),
    ...run("2026-10-19T16:51:00Z", [[HELD, DEAD]]),
  ].join("\n");
  const result = await measureDream(deps(journal, CODE), []);
  assert.equal(result.metrics.unlanded, 1);
  assert.equal(result.info.unlanded_ahead, 0);
});
