import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import {
  churn, classStates, type DreamDeps, type Exec, freshCorrections, glide, GLIDE_START, harnessSignal, lastChanged, LINT_GLIDE, measureDream, MEMORY_GLIDE,
  JUDGED_METRICS, pagesBehindCode, parseGitLog, parseStale, pickFlagged, sinceFrom, UNMEASURED, unjudgedPairs, unmeasuredReason,
} from "../scripts/duties/wiki-dream.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-14T01:30:00+09:00");
const iso = (offsetDays: number): string => new Date(NOW + offsetDays * DAY).toISOString();

const HEALTH = {
  at: iso(0), curatedPages: 257,
  facts: { hub_orphans: 10, dead_links: 4, session_links: 88, superseded_linked: 8, missing_meta: 60, stale_vs_code: 16, lint_failing_pages: 240, lint_errors: 17000, open_session_logs: 330, unread_unlinked_60d: 1 },
  items: [
    { kind: "lint_page", path: "apps/a.html", excerpt: "12 errors" },
    { kind: "dead_link", path: "apps/hub/index.html", excerpt: "links to a missing page", target: "apps/gone.html" },
    { kind: "hub_orphan", path: "apps/orphan.html" },
  ],
  dupPairs: [{ a: "apps/x.html", b: "apps/y.html", score: 0.5 }, { a: "apps/q.html", b: "apps/p.html", score: 0.4 }, { a: "apps/m.html", b: "apps/n.html", score: 0.36 }],
  signals: [{ path: "sessions/2026/10/13/0100-x/index.html", phrase: "commit.mjs refused", excerpt: "commit.mjs refused a file" }],
};
const LEDGER = {
  version: 1,
  pairs: { "apps/p.html|apps/q.html": { verdict: "distinct", at: iso(-3), job: "j1" }, "apps/m.html|apps/n.html": { verdict: "distinct", at: iso(-40), job: "j0", score: 0.35 } },
  classes: {
    git: { title: "Shared checkout git", skill: ".agents/skills/repo/git-workflow/SKILL.md", gap: "text", status: "open", firstSeen: iso(-3), sources: ["memory a", "refinement b"] },
    fresh: { title: "Found by the last run", status: "open", firstSeen: iso(-0.5) },
    mac: { title: "Heavy work on the Mac", status: "fixed", fixCommit: "abc", recurred: [iso(-2)] },
    old: { title: "Came back long ago", status: "reopened", recurred: [iso(-20)] },
    done: { title: "Fixed", status: "fixed" },
  },
  memoryMoves: { m_old: { skill: "x", commit: "c", deletedAt: iso(-1) } },
};
const CORRECTIONS = { corrections: [
  { id: "c1", at: iso(-5), rule: "Replies are plain.", words: "unslop", chat: { id: "chat1" }, repeats: [{ at: iso(-0.5), words: "unslop again", chat: { id: "chat2" } }] },
  { id: "c40", at: iso(-0.2), rule: "New rule.", words: "do this", chat: { id: "chat1" }, repeats: [] },
] };
const HARNESS = {
  entries: {
    memory: {
      m_old: { id: "m_old", title: "auto-sns-agent: moved already", path: "auto-sns-agent/git", scope: "global", created_at: iso(-30), updated_at: iso(-30) },
      m_repo: { id: "m_repo", title: "Something", path: "auto-sns-agent/ci", scope: "global", content: "see .agents/skills/repo/verify/SKILL.md", created_at: iso(-10), updated_at: iso(-9) },
      m_new: { id: "m_new", title: "auto-sns-agent: new fact", path: "general", scope: "global", created_at: iso(-0.3), updated_at: iso(-0.3) },
      m_general: { id: "m_general", title: "General", path: "general", scope: "global", created_at: iso(-0.1), updated_at: iso(-0.1) },
    },
    prompt: {},
  },
  refinements: [{ id: "refine_1", trigger: "old", changes: ["x"], created_at: iso(-3) }, { id: "refine_2", trigger: "OOM again", changes: ["update memory"], created_at: iso(-0.4) }],
};
// The engine lists 6 pages by mtime. Page a's refs changed in tip commits after its check; page b's ref last changed before its check;
// page c's ref changed after the last run started; page d cites a file git never had; page e's tracked ref only had its mtime rewritten
// (no tip commit since the oldest check); page f cites an untracked file the engine saw change.
const STALE = { checkable: 5, count: 4, stale: [
  { path: "apps/a.html", title: "A", last_verified: "2026-10-01", staleRefs: [{ ref: "convex/a.ts", modified: iso(0) }, { ref: "apps/x/src", modified: iso(0) }] },
  { path: "apps/b.html", title: "B", last_verified: "2026-10-10", staleRefs: [{ ref: "convex/b.ts", modified: iso(0) }] },
  { path: "apps/c.html", title: "C", last_verified: "2026-10-10", staleRefs: [{ ref: "convex/c.ts", modified: iso(0) }] },
  { path: "apps/d.html", title: "D", last_verified: "2026-10-10", staleRefs: [{ ref: "convex/gone.ts", modified: "missing — ref no longer exists" }] },
  { path: "apps/e.html", title: "E", last_verified: "2026-10-10", staleRefs: [{ ref: "convex/e.ts", modified: iso(0) }] },
  { path: "apps/f.html", title: "F", last_verified: "2026-10-10", staleRefs: [{ ref: "scripts/local.json", modified: iso(-0.2) }] },
] };
const TRACKED = ["convex/a.ts", "apps/x/src/deep/file.ts", "convex/b.ts", "convex/c.ts", "convex/e.ts"];
const sec = (at: number): number => Math.floor(at / 1000);
const GIT_REFS = `\x1e${sec(NOW - 0.5 * DAY)}\n\nconvex/c.ts\n\x1e${sec(NOW - 2 * DAY)}\n\nconvex/a.ts\napps/x/src/deep/file.ts\n` +
  `\x1e${sec(Date.parse("2026-10-05T00:00:00Z"))}\n\nconvex/b.ts\n`;
const GIT_PI = `\x1eaaa111\x1fdocs(wiki-dream): fix skill rule\n\nskills/unslop/SKILL.md\n\x1ebbb222\x1fRevert "docs(wiki-dream): fix skill rule"\n\nskills/unslop/SKILL.md\n`;
const GIT_WIKI = `\x1eccc333\x1fdocs(wiki-dream): merge a into b\n\napps/llm-wiki/content/apps/b.html\napps/llm-wiki/content/apps/a.html\n` +
  `\x1eddd444\x1fdocs(wiki-dream): fix links in b\n\napps/llm-wiki/content/apps/b.html\n`;

function deps(over: { health?: string | Error; files?: Record<string, string | undefined>; git?: Error; stale?: unknown } = {}): DreamDeps & { calls: { file: string; args: readonly string[]; cwd: string }[] } {
  const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
  const files: Record<string, string | undefined> = { "/c.json": JSON.stringify(CORRECTIONS), "/h.json": JSON.stringify(HARNESS), "/l.json": JSON.stringify(LEDGER), ...over.files };
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/bin/node") { const health = over.health ?? JSON.stringify({ ...HEALTH, stale: over.stale ?? STALE }); if (health instanceof Error) throw health; return health; }
    if (file === "git") { if (over.git) throw over.git; if (args.includes("--format=%x1e%ct")) return GIT_REFS; if (args.includes("ls-tree")) return TRACKED.join("\0") + "\0"; return args[1] === "/wiki" ? GIT_WIKI : GIT_PI; }
    throw new Error(`unexpected ${file}`);
  };
  return { now: NOW, exec, node: "/bin/node", calls, repos: { wiki: "/wiki", pi: "/pi" }, files: { corrections: "/c.json", harness: "/h.json", ledger: "/l.json" },
    readText: async path => { const text = files[path]; if (text === undefined) throw new Error(`ENOENT ${path}`); return text; } };
}
const run = (at: number, verdict: DutyRunRecord["verdict"]): DutyRunRecord => ({ duty: "d4", at, trigger: "schedule", ms: 1, verdict, metrics: {}, summary: "" });

test("wiki dream: the last measured run sets since; error and skipped runs do not; never over 7 days back", () => {
  assert.equal(sinceFrom([], NOW), NOW - DAY);
  assert.equal(sinceFrom([run(NOW - 2 * DAY, "error"), run(NOW - 3 * DAY, "missed"), run(NOW - 4 * DAY, "met")], NOW), NOW - 3 * DAY);
  assert.equal(sinceFrom([run(NOW - 20 * DAY, "met")], NOW), NOW - 7 * DAY);
});

test("wiki dream: glide plans drop by their slope per whole day from the start and stop at 0", () => {
  assert.equal(glide(LINT_GLIDE, GLIDE_START - DAY), 250);
  assert.equal(glide(LINT_GLIDE, GLIDE_START + 3 * DAY + 1000), 235);
  assert.equal(glide(MEMORY_GLIDE, GLIDE_START + 100 * DAY), 0);
});

test("wiki dream: a judged pair stays settled at any age, in either order, until its score rises past the judged score", () => {
  assert.deepEqual(unjudgedPairs(HEALTH.dupPairs, LEDGER).map(pair => pair.a), ["apps/x.html", "apps/m.html"]);
  const same = { ...LEDGER, pairs: { ...LEDGER.pairs, "apps/m.html|apps/n.html": { verdict: "distinct", at: iso(-40), job: "j0", score: 0.36 } } };
  assert.deepEqual(unjudgedPairs(HEALTH.dupPairs, same).map(pair => pair.a), ["apps/x.html"]);
});

test("wiki dream: open and reopened classes are open; only ones the last run already had are due; a recurrence in 7 days counts as back", () => {
  const states = classStates(LEDGER, NOW, NOW - DAY);
  assert.deepEqual(states.open.map(([slug]) => slug), ["git", "fresh", "old"]);
  assert.deepEqual(states.due.map(([slug]) => slug), ["git", "old"], "a class first seen after the last run started waits one run; one with no date is due");
  assert.deepEqual(states.back.map(([slug]) => slug), ["mac"]);
});

test("wiki dream: a page is behind its code for any tip commit after its check, however recent; mtime alone on a tracked file does not count", () => {
  const changed = lastChanged(GIT_REFS);
  assert.equal(changed.get("convex/a.ts"), sec(NOW - 2 * DAY) * 1000);
  const behind = pagesBehindCode(parseStale(STALE), changed, new Set(TRACKED));
  assert.deepEqual(behind.map(page => [page.path, page.refs.map(ref => ref.ref)]),
    [["apps/a.html", ["convex/a.ts", "apps/x/src"]], ["apps/c.html", ["convex/c.ts"]], ["apps/d.html", ["convex/gone.ts"]], ["apps/f.html", ["scripts/local.json"]]],
    "c changed 12 h ago and is in the brief now, so the run's re-measure counts only pages the brief listed");
  assert.throws(() => parseStale({}), /no stale list/);
});

test("wiki dream: git log parsing, reverts, and files two dream commits touched", () => {
  const commits = [...parseGitLog("sieun-pi", GIT_PI), ...parseGitLog("auto-sns-agent", GIT_WIKI)];
  assert.deepEqual(commits.map(commit => [commit.sha, commit.files.length]), [["aaa111", 1], ["bbb222", 1], ["ccc333", 2], ["ddd444", 1]]);
  const result = churn(commits);
  assert.deepEqual(result.reverts.map(commit => commit.sha), ["bbb222"]);
  assert.deepEqual(result.retouched, [{ file: "auto-sns-agent:apps/llm-wiki/content/apps/b.html", commits: 2 }], "a revert is not a second edit");
});

test("wiki dream: corrections and repeats since the last run, newest first", () => {
  const slices = freshCorrections(CORRECTIONS, NOW - DAY);
  assert.deepEqual(slices.map(slice => [slice.item, slice.chat, slice.excerpt.slice(0, 12)]), [["c40", "chat1", "new c40: New"], ["c1", "chat2", "repeat of c1"]]);
  assert.throws(() => freshCorrections({}, 0), /no corrections list/);
});

test("wiki dream: repo-fact memories by path or title, new entries since the last run, move candidates skip moved ones", () => {
  const signal = harnessSignal(HARNESS, LEDGER, NOW - DAY);
  assert.equal(signal.repoFacts, 3);
  assert.deepEqual(signal.fresh.map(entry => entry.id), ["m_new", "m_general"], "repo facts first");
  assert.deepEqual(signal.refinements.map(row => row.id), ["refine_2"]);
  assert.deepEqual(signal.moves.map(entry => entry.id), ["m_repo", "m_new"], "oldest kept first, the moved memory left out");
});

test("wiki dream: flagged items keep the kind order, a cap per kind and 80 in all", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ kind: ["lint_page", "correction", "memory", "weird"][index % 4]!, excerpt: `${index}` }));
  const picked = pickFlagged([{ kind: "source_error", excerpt: "x" }, ...many]);
  assert.equal(picked[0]!.kind, "source_error");
  assert.deepEqual([...new Set(picked.map(slice => slice.kind))], ["source_error", "correction", "memory", "lint_page", "weird"]);
  assert.equal(picked.filter(slice => slice.kind === "correction").length, 10);
  assert.ok(picked.length <= 80);
});

test("wiki dream: measures every contract metric from the inputs", async () => {
  const d = deps();
  const result = await measureDream(d, [run(NOW - DAY, "missed")]);
  const health = d.calls.find(call => call.file === "/bin/node")!;
  assert.deepEqual([health.cwd, health.args], ["/wiki", ["apps/llm-wiki/scripts/wiki-health.mjs", "--since", new Date(NOW - DAY).toISOString()]]);
  assert.deepEqual(d.calls.filter(call => call.file === "git").map(call => call.args[1]), ["/wiki", "/pi", "/wiki", "/wiki"]);
  const refsLog = d.calls.find(call => call.args.includes("--format=%x1e%ct"))!;
  assert.ok(refsLog.args.includes("--first-parent") && refsLog.args.includes("--diff-merges=first-parent"), "a merged side commit dates from its merge onto the tip");
  const plans = { lint: glide(LINT_GLIDE, NOW), memory: glide(MEMORY_GLIDE, NOW) };
  assert.deepEqual(plans, { lint: 235, memory: 276 });
  assert.deepEqual(result.metrics, {
    hub_orphans: 10, dead_links: 4, session_links: 88, superseded_linked: 8, missing_meta: 60, stale_vs_code: 16, pages_behind_code: 4,
    wiki_problems: 10 + 4 + 88 + 8 + 60 + 4, lint_over_glide: 240 - 235,
    dup_unjudged: 2, memory_rules_over_glide: 3 - 276, open_mistakes: 2, mistakes_back: 1, dream_reverts: 1, pages_retouched: 1, source_errors: 0,
  });
  const kinds = result.flagged!.map(slice => slice.kind);
  assert.deepEqual([...new Set(kinds)], ["recurred", "open_class", "hub_orphan", "dead_link", "stale_vs_code", "dup_pair", "revert", "retouched", "correction", "signal", "refinement", "memory", "lint_page"]);
  assert.match(result.flagged!.find(slice => slice.kind === "stale_vs_code")!.excerpt, /convex\/a\.ts \(2026-10-1\d\)/);
  assert.equal(result.info.open_classes, 3);
  assert.ok(result.flagged!.every(slice => slice.excerpt.length <= 240));
  assert.equal(result.info.dream_commits_7d, 3);
});

test("wiki dream: an unreadable input counts in source_errors and writes 999999 for the metrics it feeds", async () => {
  const down = await measureDream(deps({ health: new Error("exit 2: wiki API unreachable"), files: { "/l.json": undefined } }), []);
  for (const key of ["hub_orphans", "dead_links", "session_links", "superseded_linked", "missing_meta", "stale_vs_code", "wiki_problems", "lint_over_glide", "dup_unjudged", "open_mistakes", "mistakes_back"]) {
    assert.equal(down.metrics[key], UNMEASURED, key);
  }
  assert.equal(down.metrics.source_errors, 2);
  assert.notEqual(down.metrics.memory_rules_over_glide, UNMEASURED);
  assert.deepEqual(down.flagged!.slice(0, 2).map(slice => slice.item), ["wiki-health.mjs", "ledger"]);
  const noGit = await measureDream(deps({ git: new Error("not a git repository") }), []);
  assert.deepEqual([noGit.metrics.dream_reverts, noGit.metrics.pages_retouched, noGit.metrics.pages_behind_code, noGit.metrics.wiki_problems, noGit.metrics.source_errors],
    [UNMEASURED, UNMEASURED, UNMEASURED, UNMEASURED, 3]);
  const noStale = await measureDream(deps({ stale: {} }), []);
  assert.deepEqual([noStale.metrics.pages_behind_code, noStale.metrics.wiki_problems, noStale.metrics.dead_links, noStale.metrics.source_errors], [UNMEASURED, UNMEASURED, 4, 1]);
  const partial = await measureDream(deps({ health: JSON.stringify({ ...HEALTH, stale: STALE, facts: { dead_links: 1 } }) }), []);
  assert.deepEqual([partial.metrics.dead_links, partial.metrics.hub_orphans, partial.metrics.lint_over_glide], [1, UNMEASURED, UNMEASURED]);
  assert.equal(partial.metrics.source_errors, 6);
  const lintDown = await measureDream(deps({ health: JSON.stringify({ ...HEALTH, stale: STALE, errors: ["prose-lint"], facts: { ...HEALTH.facts, lint_failing_pages: null, lint_errors: null } }) }), []);
  assert.deepEqual([lintDown.metrics.lint_over_glide, lintDown.metrics.dead_links, lintDown.metrics.source_errors], [UNMEASURED, 4, 1], "a null fact is unmeasured; the named input is the one error");
  assert.match(lintDown.flagged![0]!.excerpt, /could not read prose-lint/);
});

test("wiki dream: the checked-in duty file parses, and its metrics are the ones the precheck writes", async () => {
  const file = JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/wiki-dream.duty.json"), "utf8")) as Record<string, unknown>;
  const duty = parseDutyInput(file, "d9", NOW);
  assert.equal(duty.name, "Wiki dream");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "01:30" });
  assert.equal(duty.boardGoal, "p249");
  const result = await measureDream(deps(), []);
  assert.ok(duty.metrics.every(metric => metric.key in result.metrics), "every declared metric is one the precheck writes");
  assert.deepEqual(duty.metrics.filter(metric => metric.headline).map(metric => metric.key), ["wiki_problems"]);
  assert.ok(duty.metrics.length <= 4, "one headline and at most 3 supporting metrics");
  assert.doesNotMatch(JSON.stringify(file), /\b(words|lines)\b.*\b(skill|SKILL\.md)\b|\b(skill|SKILL\.md)\b.*\bover \d+ (words|lines)/i, "no skill size counts (owner c39)");
});

test("wiki dream: a judged metric left unmeasured fails the run with the inputs that failed; the duty judges exactly JUDGED_METRICS", async () => {
  const ok = await measureDream(deps(), []);
  assert.equal(unmeasuredReason(ok), null);
  const down = await measureDream(deps({ health: new Error("timed out after 100 s") }), []);
  assert.equal(down.metrics.wiki_problems, UNMEASURED);
  assert.match(unmeasuredReason(down) ?? "", /^could not measure wiki_problems, dup_unjudged: wiki-health\.mjs: timed out after 100 s$/);
  const file = JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/wiki-dream.duty.json"), "utf8")) as { metrics: { key: string }[] };
  assert.deepEqual(file.metrics.map(metric => metric.key).sort(), [...JUDGED_METRICS].sort());
});
