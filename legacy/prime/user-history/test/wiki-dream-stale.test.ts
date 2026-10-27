// Guards the wiki dream count of 2026-10-20. pages_behind_code re-dated wiki-health's stale list against the end of each
// last_verified day, so a change later on the check's own day never counted and a last_verified time read as no day at all.
// The engine now dates both sides on the tip. A page counts once it has been behind longer than one push run and one rewrite
// (FOLLOW_WINDOW_MS), and a newer one is the part wiki_problems_following, which a push run still goes after.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dateMissingRefs, FLAGGED_MAX, FOLLOW_WINDOW_MS, measureDream, parseDeletions, parseStale, pickFlagged, staleExcerpt, type DreamDeps } from "../scripts/duties/wiki-dream.ts";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";

const DUTY = JSON.parse(readFileSync(new URL("../scripts/duties/wiki-dream.duty.json", import.meta.url), "utf8")) as { metrics: unknown[] };

const NOW = Date.parse("2026-10-20T03:30:00Z");
const sec = (iso: string): string => (Date.parse(iso) / 1000).toFixed(6);
const JOURNAL = [
  `${sec("2026-10-20T02:55:00Z")} us-metal02 systemd[1]: Starting wiki-box-commit.service - wiki-box-commit`,
  `${sec("2026-10-20T02:55:10Z")} us-metal02 systemd[1]: Finished wiki-box-commit.service - wiki-box-commit`,
].join("\n");
const STALE = {
  checkable: 4, count: 3,
  stale: [
    { path: "domains/architecture/outside-calls.html", title: "Outside calls", last_verified: "2026-10-20", verified_at: "2026-10-20T01:12:38.000Z",
      staleRefs: [{ ref: "apps/vent/src/vent/tables.py", modified: "2026-10-20T03:20:00.000Z", since: "2026-10-20T02:14:30.000Z" }] },
    { path: "domains/architecture/telemetry-map.html", title: "Telemetry map", last_verified: "2026-10-20T01:00Z", verified_at: "2026-10-20T01:00:00.000Z",
      staleRefs: [{ ref: "apps/vent/README.md", modified: "2026-10-20T03:10:00.000Z", since: "2026-10-20T03:10:00.000Z" }, { ref: "apps/vent/gone.py", modified: "missing — ref no longer exists" }] },
    { path: "domains/devops/ci-time/index.html", title: "CI time", last_verified: "2026-10-20T02:50Z", verified_at: "2026-10-20T02:50:00.000Z",
      staleRefs: [{ ref: ".github/workflows/verify-dev.yml", modified: "2026-10-20T03:20:00.000Z", since: "2026-10-20T03:00:00.000Z" }] },
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
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
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

test("a page behind for longer than the follow window counts, a missing ref at once, and a newer one is a followed part that is still flagged", async () => {
  const result = await measureDream(deps(), []);
  assert.equal(FOLLOW_WINDOW_MS, 70 * 60_000);
  assert.equal(result.metrics.pages_behind_code, 2, "behind since 02:14:30Z is 75.5 min, and a missing ref counts at once");
  assert.equal(result.metrics.wiki_problems, 2);
  assert.equal(result.metrics.wiki_problems_following, 1, "behind since 03:00Z is 30 min");
  assert.equal(result.metrics.source_errors, 0);
  const stale = (result.flagged ?? []).filter(slice => slice.kind === "stale_vs_code");
  assert.deepEqual(stale.map(slice => slice.item), ["domains/architecture/telemetry-map.html", "domains/architecture/outside-calls.html", "domains/devops/ci-time/index.html"],
    "the counted pages come first, the missing ref and then the longest behind, and the followed page last");
  assert.equal(stale[1]!.excerpt, "checked 2026-10-20T01:12Z (last_verified 2026-10-20); code changed since: apps/vent/src/vent/tables.py (2026-10-20T03:20Z)");
  assert.equal(stale[2]!.excerpt, "checked 2026-10-20T02:50Z (last_verified 2026-10-20T02:50Z); behind since 03:00Z, counted from 04:10Z; code changed since: .github/workflows/verify-dev.yml (2026-10-20T03:20Z)");
});

test("the duty records the followed pages as a part of wiki_problems, which the verdict leaves out", () => {
  const output = { metrics: { wiki_problems: 0, open_mistakes: 0, mistakes_back: 0, dup_unjudged: 0, wiki_problems_following: 3 } };
  const judged = judge(DUTY.metrics as DutyMetric[], output);
  assert.equal(judged.verdict, "met");
  assert.deepEqual(judged.parts, { wiki_problems_following: { value: 3, target: 0, op: "<=", met: false } });
});

test("a stale row with no verified_at, from a cited path git lacks, names its last_verified and the missing ref", () => {
  const [page] = parseStale({ stale: [{ path: "a.html", last_verified: "1970-01-01", staleRefs: [{ ref: "scripts/deploy.sh", modified: "missing — ref no longer exists" }] }] });
  assert.equal(staleExcerpt(page!), "checked 1970-01-01 (last_verified 1970-01-01); code changed since: scripts/deploy.sh (missing)");
});

// At 07:28Z on 10-22, 51 pages sat behind their code and the brief listed 30, by path, so every projects/ page and most domains/ pages went
// unnamed while the duty counted them. A replay of the stale check over 10-20 07:51Z to 10-22 07:51Z put 424 of 1,221 counted page-hours past the 30th.
test("every page behind code is flagged, past the old cap of 30 and past FLAGGED_MAX, and the capped kinds still stop at FLAGGED_MAX", () => {
  const many = (kind: string, count: number) => Array.from({ length: count }, (_, index) => ({ kind, item: `${kind}-${index}`, excerpt: kind }));
  const capped = ["source_error", "unlanded_session", "recurred", "open_class", "dup_pair", "revert", "retouched", "correction", "signal", "refinement",
    "trial_memory", "memory", "lint_page", "archive_candidate"].flatMap(kind => many(kind, 20));
  const stale = many("stale_vs_code", 95);
  const dead = many("dead_link", 12);
  const picked = pickFlagged([...capped, ...stale, ...dead]);
  assert.deepEqual(picked.filter(slice => slice.kind === "stale_vs_code").map(slice => slice.item), stale.map(slice => slice.item));
  assert.equal(picked.filter(slice => slice.kind === "dead_link").length, 12);
  assert.equal(picked.filter(slice => slice.kind !== "stale_vs_code" && slice.kind !== "dead_link").length, FLAGGED_MAX);
});

test("a missing ref whose file a commit in the follow window deleted is followed, and one no deletion dates still counts at once", async () => {
  const base = deps();
  const calls: string[][] = [];
  const dated: DreamDeps = { ...base, exec: async (file, args, options) => {
    if (file === "git" && args.includes("--diff-filter=D")) { calls.push([...args]); return `\x1e${Date.parse("2026-10-20T03:10:00Z") / 1000}\napps/vent/gone.py\nconvex/other.ts\n`; }
    return base.exec(file, args, options);
  } };
  const result = await measureDream(dated, []);
  assert.equal(calls.length, 1, "one git log reads every deletion of the follow window");
  assert.ok(calls[0]!.includes("--first-parent") && calls[0]!.includes(`--since=${new Date(NOW - FOLLOW_WINDOW_MS).toISOString()}`));
  assert.equal(result.metrics.pages_behind_code, 1, "only outside-calls, behind since 02:14:30Z, counts");
  assert.equal(result.metrics.wiki_problems_following, 2, "telemetry-map fell behind at 03:10Z, when its README changed and gone.py was deleted");
  const telemetry = (result.flagged ?? []).find(slice => slice.item === "domains/architecture/telemetry-map.html");
  assert.match(telemetry!.excerpt, /behind since 03:10Z, counted from 04:20Z; .*apps\/vent\/gone\.py \(missing\)/);
});

test("dateMissingRefs matches a deleted file by its path, an app-relative or folder ref, and leaves a dated or unmatched ref alone", () => {
  const deleted = parseDeletions(`\x1e1793090170\napps/search/src/routes/api/ads/lookup/+server.ts\nconvex/search/adLibrary.ts\n\x1e1793086429\nconvex/search/adLibrary.ts\n`);
  assert.equal(deleted.get("convex/search/adLibrary.ts"), 1793090170_000, "the newest deletion wins");
  const [page] = dateMissingRefs([{ path: "apps/search/ads-library.html", last_verified: "2026-10-20", staleRefs: [
    { ref: "convex/search/adLibrary.ts::pruneOrphanAds", modified: "missing — ref no longer exists" },
    { ref: "src/routes/api/ads/", modified: "missing — ref no longer exists" },
    { ref: "convex/never.ts", modified: "missing — ref no longer exists" },
    { ref: "convex/crons.ts", modified: "2026-10-27T04:51:00.000Z" },
  ] }], deleted);
  assert.deepEqual(page!.staleRefs.map(ref => ref.since), ["2026-10-27T08:36:10.000Z", "2026-10-27T08:36:10.000Z", undefined, undefined]);
});
