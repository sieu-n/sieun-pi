// Guards the wiki dream count of 2026-10-20. pages_behind_code re-dated wiki-health's stale list against the end of each
// last_verified day, so a change later on the check's own day never counted and a last_verified time read as no day at all.
// The engine now dates both sides on the tip. A page counts once it has been behind longer than one push run and one rewrite
// (FOLLOW_WINDOW_MS), and a newer one is the part wiki_problems_following, which a push run still goes after.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dateMissingRefs, FLAGGED_MAX, FOLLOW_WINDOW_MS, measureDream, parseDeletions, parseStale, piRef, pickFlagged, removableRef, removalArgs, staleExcerpt, type DreamDeps } from "../scripts/duties/wiki-dream.ts";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";

const DUTY = JSON.parse(readFileSync(new URL("../scripts/duties/wiki-dream.duty.json", import.meta.url), "utf8")) as { metrics: unknown[] };

const NOW = Date.parse("2026-10-20T03:30:00Z");
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
  assert.equal(result.metrics.wiki_problems_following, 0, "behind since 03:00Z is 30 min, so it waits");
  assert.equal(result.info.pages_waiting, 1);
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
  const capped = ["source_error", "recurred", "open_class", "dup_pair", "revert", "retouched", "correction", "signal", "refinement",
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
  assert.ok(calls[0]!.includes("--first-parent") && calls[0]!.includes(`--since-as-filter=${new Date(NOW - FOLLOW_WINDOW_MS).toISOString()}`));
  assert.equal(result.metrics.pages_behind_code, 1, "only outside-calls, behind since 02:14:30Z, counts");
  assert.equal(result.metrics.wiki_problems_following! + result.info.pages_waiting!, 2, "telemetry-map fell behind at 03:10Z, when its README changed and gone.py was deleted");
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

// On 2026-11-03 sieun-pi 187b2866 (14:47Z) removed apps/chat/server/search.ts `missingNote`, and the 15:08Z run counted
// domains/devops/sw-factory-threads/index.html at once. On 2026-11-18 the auto-sns-agent take-in 86af8e8f17 (00:04:42Z) removed
// scripts/dev/release-runner-toggle.mjs `STANDING` past the follow gate, and the 09:10 KST run counted domains/architecture/ci-deploy/runners.html at once.
test("a missing definition is followed from the commit that removed it in either repo, and one no commit explains counts at once", async () => {
  const now = Date.parse("2026-11-03T15:08:00Z");
  const missing = "missing — ref no longer exists";
  const stale = { stale: [
    { path: "domains/devops/sw-factory-threads/index.html", last_verified: "2026-11-03T14:00Z", verified_at: "2026-11-03T14:00:00.000Z",
      staleRefs: [{ ref: "sieun-pi:apps/chat/server/search.ts::run", modified: missing }, { ref: "sieun-pi:apps/chat/server/search.ts::missingNote", modified: missing }] },
    { path: "domains/architecture/ci-deploy/runners.html", last_verified: "2026-11-03T14:00Z", verified_at: "2026-11-03T14:00:00.000Z",
      staleRefs: [{ ref: "scripts/dev/release-runner-toggle.mjs::STANDING", modified: missing }] },
    { path: "apps/search/ads-library.html", last_verified: "2026-11-03T14:00Z", verified_at: "2026-11-03T14:00:00.000Z",
      staleRefs: [{ ref: "convex/search/adLibrary.ts::pruneOrphanAds", modified: missing }] },
  ] };
  const base = deps();
  const removals: string[][] = [];
  const result = await measureDream({ ...base, now, exec: async (file, args, options) => {
    if (file === "node") return JSON.stringify({ facts: { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 3, lint_failing_pages: 0 },
      items: [], errors: [], dupPairs: [], signals: [], stale });
    if (file === "git" && args.includes("-n1")) {
      removals.push([...args]);
      if (args[1] === "/pi") return `${Date.parse("2026-11-03T14:47:00Z") / 1000}\n`;
      return args.includes(":(literal)scripts/dev/release-runner-toggle.mjs") ? `${Date.parse("2026-11-03T14:50:00Z") / 1000}\n` : "";
    }
    if (file === "git" && args.includes("--diff-filter=D")) return "";
    return base.exec(file, args, options);
  } }, []);
  assert.equal(result.metrics.pages_behind_code, 1, "only the page whose definition no commit removed counts");
  assert.equal(result.metrics.source_errors, 0);
  assert.equal(removals.length, 4);
  const pi = removals.find(args => args[1] === "/pi")!;
  assert.ok(pi.includes("--first-parent") && pi.at(-1) === ":(literal)apps/chat/server/search.ts" && pi.includes("--since-as-filter=2026-11-03T14:00:00.000Z"),
    "it reads commits after the page's check, which is inside the window");
  assert.ok(removals.some(args => args.includes("-G(^|[^[:alnum:]_$])missingNote([^[:alnum:]_$]|$)")), "only a commit that changed a line naming the definition dates it");
  const runners = removals.find(args => args.includes(":(literal)scripts/dev/release-runner-toggle.mjs"))!;
  assert.deepEqual(runners.slice(0, 2), ["-C", "/wiki"]);
  assert.ok(runners.includes(":(glob)apps/*/scripts/dev/release-runner-toggle.mjs") && runners.includes("-G(^|[^[:alnum:]_$])STANDING([^[:alnum:]_$]|$)"));
  const excerpt = (path: string) => (result.flagged ?? []).find(slice => slice.item === path)!.excerpt;
  assert.match(excerpt("domains/devops/sw-factory-threads/index.html"), /behind since 14:47Z, counted from 15:57Z; code changed since: sieun-pi:apps\/chat\/server\/search\.ts::run \(missing\)/);
  assert.match(excerpt("domains/architecture/ci-deploy/runners.html"), /behind since 14:50Z, counted from 16:00Z/);
});

test("piRef reads a sieun-pi file or definition ref and drops a line suffix", () => {
  assert.deepEqual(piRef("sieun-pi:apps/chat/server/search.ts::run"), { path: "apps/chat/server/search.ts", name: "run" });
  assert.deepEqual(piRef("sieun-pi:packages/pi-pool/install.py:12-30"), { path: "packages/pi-pool/install.py" });
  assert.equal(piRef("convex/search/adLibrary.ts::pruneOrphanAds"), null);
});

// On 2026-11-04 the auto-sns-agent tip held addbbf5329 (13:12:35Z) above afc3ff7332 (13:13:02Z), and `--since=13:12:40Z` stopped at
// the first and never listed the second.
test("removalArgs finds a removal dated after the check below a commit dated before it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-dream-since-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CEILING_DIRECTORIES: dirname(dir) };
  const git = (args: string[], at?: string) => execFileSync("git", args, { cwd: dir, encoding: "utf8",
    env: at ? { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : env });
  const commit = (file: string, text: string, at: string) => {
    writeFileSync(join(dir, file), text);
    git(["add", file]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file], at);
  };
  git(["init", "-q"]);
  commit("search.ts", "export function missingNote() {}\nexport function run() {}\n", "2026-11-04T13:00:00Z");
  commit("search.ts", "export function run() {}\n", "2026-11-04T13:13:02Z");
  commit("other.ts", "x\n", "2026-11-04T13:12:35Z");
  const removedAt = git(removalArgs(dir, removableRef("sieun-pi:search.ts::missingNote")!, Date.parse("2026-11-04T13:12:40Z"))).trim();
  assert.equal(Number(removedAt) * 1000, Date.parse("2026-11-04T13:13:02Z"));
});

// The runners.html case: the file stays and only its `STANDING` definition goes, in a commit after the page's check.
test("removalArgs dates an auto-sns-agent definition taken off a file that stays, under the root or an app folder, and leaves an unexplained one undated", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-dream-def-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CEILING_DIRECTORIES: dirname(dir) };
  const git = (args: string[], at?: string) => execFileSync("git", args, { cwd: dir, encoding: "utf8",
    env: at ? { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : env });
  const commit = (file: string, text: string, at: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(["add", file]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file], at);
  };
  git(["init", "-q"]);
  commit("scripts/dev/release-runner-toggle.mjs", "const STANDING = 1;\nconst STANDINGS = 2;\nrun();\n", "2026-11-17T20:00:00Z");
  commit("apps/web/src/lib/tick.ts", "export const tock = 1;\n", "2026-11-17T20:00:00Z");
  commit("scripts/dev/release-runner-toggle.mjs", "const STANDINGS = 2;\nrun();\n", "2026-11-18T00:04:42Z");
  commit("apps/web/src/lib/tick.ts", "export const other = 1;\n", "2026-11-18T00:05:00Z");
  const after = Date.parse("2026-11-17T23:00:00Z");
  const at = (ref: string) => git(removalArgs(dir, removableRef(ref)!, after)).trim();
  assert.equal(Number(at("scripts/dev/release-runner-toggle.mjs::STANDING")) * 1000, Date.parse("2026-11-18T00:04:42Z"));
  assert.equal(Number(at("src/lib/tick.ts::tock")) * 1000, Date.parse("2026-11-18T00:05:00Z"));
  assert.equal(at("scripts/dev/release-runner-toggle.mjs::NEVER"), "");
  assert.equal(removableRef("scripts/dev/release-runner-toggle.mjs"), null);
});
