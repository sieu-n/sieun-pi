import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput, type DutyRunRecord } from "../src/shared/chat-duties.ts";
import {
  churn, classStates, type DreamDeps, type Exec, freshCorrections, glide, GLIDE_START, harnessSignal, LINT_GLIDE, measureDream, MEMORY_GLIDE,
  parseGitLog, pickFlagged, sinceFrom, UNMEASURED, unjudgedPairs,
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
  pairs: { "apps/p.html|apps/q.html": { verdict: "distinct", at: iso(-3), job: "j1" }, "apps/m.html|apps/n.html": { verdict: "distinct", at: iso(-40), job: "j0" } },
  classes: {
    git: { title: "Shared checkout git", skill: ".agents/skills/repo/git-workflow/SKILL.md", gap: "text", status: "open", sources: ["memory a", "refinement b"] },
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
const GIT_PI = `\x1eaaa111\x1fdocs(wiki-dream): fix skill rule\n\nskills/unslop/SKILL.md\n\x1ebbb222\x1fRevert "docs(wiki-dream): fix skill rule"\n\nskills/unslop/SKILL.md\n`;
const GIT_WIKI = `\x1eccc333\x1fdocs(wiki-dream): merge a into b\n\napps/llm-wiki/content/apps/b.html\napps/llm-wiki/content/apps/a.html\n` +
  `\x1eddd444\x1fdocs(wiki-dream): fix links in b\n\napps/llm-wiki/content/apps/b.html\n`;

function deps(over: { health?: string | Error; files?: Record<string, string | undefined>; git?: Error } = {}): DreamDeps & { calls: { file: string; args: readonly string[]; cwd: string }[] } {
  const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
  const files: Record<string, string | undefined> = { "/c.json": JSON.stringify(CORRECTIONS), "/h.json": JSON.stringify(HARNESS), "/l.json": JSON.stringify(LEDGER), ...over.files };
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/bin/node") { const health = over.health ?? JSON.stringify(HEALTH); if (health instanceof Error) throw health; return health; }
    if (file === "git") { if (over.git) throw over.git; return args[1] === "/wiki" ? GIT_WIKI : GIT_PI; }
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

test("wiki dream: pairs judged within 30 days are settled, in either order", () => {
  assert.deepEqual(unjudgedPairs(HEALTH.dupPairs, LEDGER, NOW).map(pair => pair.a), ["apps/x.html", "apps/m.html"]);
});

test("wiki dream: open and reopened classes are open; a recurrence in 7 days counts as back", () => {
  const states = classStates(LEDGER, NOW);
  assert.deepEqual(states.open.map(([slug]) => slug), ["git", "old"]);
  assert.deepEqual(states.back.map(([slug]) => slug), ["mac"]);
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
  assert.deepEqual(d.calls.filter(call => call.file === "git").map(call => call.args[1]), ["/wiki", "/pi"]);
  const plans = { lint: glide(LINT_GLIDE, NOW), memory: glide(MEMORY_GLIDE, NOW) };
  assert.deepEqual(plans, { lint: 235, memory: 276 });
  assert.deepEqual(result.metrics, {
    hub_orphans: 10, dead_links: 4, session_links: 88, superseded_linked: 8, missing_meta: 60, stale_vs_code: 16, lint_over_glide: 240 - 235,
    dup_unjudged: 2, memory_rules_over_glide: 3 - 276, open_mistakes: 2, mistakes_back: 1, dream_reverts: 1, pages_retouched: 1, source_errors: 0,
  });
  const kinds = result.flagged!.map(slice => slice.kind);
  assert.deepEqual([...new Set(kinds)], ["recurred", "revert", "retouched", "open_class", "correction", "signal", "refinement", "memory", "dead_link", "hub_orphan", "dup_pair", "lint_page"]);
  assert.ok(result.flagged!.every(slice => slice.excerpt.length <= 240));
  assert.equal(result.info.dream_commits_7d, 3);
});

test("wiki dream: an unreadable input counts in source_errors and writes 999999 for the metrics it feeds", async () => {
  const down = await measureDream(deps({ health: new Error("exit 2: wiki API unreachable"), files: { "/l.json": undefined } }), []);
  for (const key of ["hub_orphans", "dead_links", "session_links", "superseded_linked", "missing_meta", "stale_vs_code", "lint_over_glide", "dup_unjudged", "open_mistakes", "mistakes_back"]) {
    assert.equal(down.metrics[key], UNMEASURED, key);
  }
  assert.equal(down.metrics.source_errors, 2);
  assert.notEqual(down.metrics.memory_rules_over_glide, UNMEASURED);
  assert.deepEqual(down.flagged!.slice(0, 2).map(slice => slice.item), ["wiki-health.mjs", "ledger"]);
  const noGit = await measureDream(deps({ git: new Error("not a git repository") }), []);
  assert.deepEqual([noGit.metrics.dream_reverts, noGit.metrics.pages_retouched, noGit.metrics.source_errors], [UNMEASURED, UNMEASURED, 2]);
  const partial = await measureDream(deps({ health: JSON.stringify({ ...HEALTH, facts: { dead_links: 1 } }) }), []);
  assert.deepEqual([partial.metrics.dead_links, partial.metrics.hub_orphans, partial.metrics.lint_over_glide], [1, UNMEASURED, UNMEASURED]);
  assert.equal(partial.metrics.source_errors, 6);
  const lintDown = await measureDream(deps({ health: JSON.stringify({ ...HEALTH, errors: ["prose-lint"], facts: { ...HEALTH.facts, lint_failing_pages: null, lint_errors: null } }) }), []);
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
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(result.metrics).sort());
  assert.doesNotMatch(JSON.stringify(file), /\b(words|lines)\b.*\b(skill|SKILL\.md)\b|\b(skill|SKILL\.md)\b.*\bover \d+ (words|lines)/i, "no skill size counts (owner c39)");
});
