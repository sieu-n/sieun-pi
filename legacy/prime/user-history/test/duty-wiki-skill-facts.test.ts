// Guards the Wiki and skill facts duty of 2026-11-20 (knowledge manager p3): a page or skill counts when a code fact it names held at its own
// date and is gone at HEAD, as apps/crawler-v3/architecture/media-pipeline still named TIKTOK_EMBED_READS_PER_WINDOW after 77fc4e1c26 dropped it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";
import { codeSpans, listCuratedPages, measureFacts, readFacts, runNoShell } from "../scripts/duties/wiki-skill-facts.ts";

const DUTY = JSON.parse(readFileSync(new URL("../scripts/duties/wiki-skill-facts.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] };

function world(extra: Record<string, string> = {}): { repo: string; piRepo: string; content: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wiki-skill-facts-"));
  const repo = join(root, "repo"), piRepo = join(root, "sieun-pi"), content = join(root, "content");
  const write = (base: string, path: string, text: string): void => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text); };
  const gitIn = (cwd: string) => (args: string[], at: string): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, stdio: "ignore" });
  };
  const git = gitIn(repo), piGit = gitIn(piRepo);
  mkdirSync(repo, { recursive: true }); mkdirSync(piRepo, { recursive: true });
  git(["init", "-q", "-b", "main"], "2026-11-01T00:00:00Z");
  piGit(["init", "-q", "-b", "main"], "2026-11-01T00:00:00Z");
  write(piRepo, "scripts/release-chat.mjs", "const PI_HOLD = 1;\nif (process.argv.includes('--fast')) run();\n");
  write(piRepo, "legacy/x/gone.ts", "export {};\n");
  write(piRepo, "skills/board/references/git.md", "Run `node scripts/release-chat.mjs <sha> --fast` with `PI_HOLD`, read `legacy/x/gone.ts`, and commit with `scripts/tool.mjs`.\n");
  write(piRepo, "skills/board/SKILL.md", "---\nname: board\n---\nSee `references/git.md`.\n");
  write(piRepo, "packages/pi-host/test/fixtures/prime-agent/skills/alpha/SKILL.md", "Read `legacy/x/gone.ts`.\n");
  piGit(["add", "-A"], "2026-11-01T00:00:00Z");
  piGit(["commit", "-q", "-m", "one"], "2026-11-01T00:00:00Z");
  write(piRepo, "scripts/release-chat.mjs", "if (process.argv.includes('--no-kickstart')) run();\n");
  rmSync(join(piRepo, "legacy/x/gone.ts"));
  piGit(["add", "-A"], "2026-11-05T00:00:00Z");
  piGit(["commit", "-q", "-m", "two"], "2026-11-05T00:00:00Z");
  write(repo, "scripts/tool.mjs", "const OLD_LIMIT = 1;\nif (process.argv.includes('--old')) run();\n");
  write(repo, "ops/gone.sh", "echo gone\n");
  write(repo, "package.json", JSON.stringify({ scripts: { "dev:old": "x", dev: "y" } }));
  write(repo, ".agents/skills/repo/tool/SKILL.md", "---\nname: tool\n---\nRun `node scripts/tool.mjs --old` with `OLD_LIMIT` set, then `ops/gone.sh` and `pnpm dev:old`.\nAn example path is `scripts/never-there.mjs`.\n");
  write(repo, ".agents/skills/stack/vendor/SKILL.md", "---\nname: vendor\nmetadata:\n  author: Vendor Inc\n---\nSet `OLD_LIMIT`.\n");
  for (const [path, text] of Object.entries(extra)) write(repo, path, text);
  git(["add", "-A"], "2026-11-01T00:00:00Z");
  git(["commit", "-q", "-m", "one"], "2026-11-01T00:00:00Z");
  write(repo, "scripts/tool.mjs", "if (process.argv.includes('--new')) run();\n");
  rmSync(join(repo, "ops/gone.sh"));
  write(repo, "package.json", JSON.stringify({ scripts: { dev: "y" } }));
  git(["add", "-A"], "2026-11-05T00:00:00Z");
  git(["commit", "-q", "-m", "two"], "2026-11-05T00:00:00Z");
  const page = (kind: string, updated: string) => `<!--wiki {"title":"t","kind":"${kind}","status":"current","updated":"${updated}"}-->\n<p>Set <code>OLD_LIMIT</code> and run <code>ops/gone.sh</code>.</p>\n`;
  write(content, "apps/tool/index.html", page("reference", "2026-11-03"));
  write(content, "apps/tool/fresh.html", page("reference", "2026-11-06"));
  write(content, "domains/x/incident.html", page("incident", "2026-11-03"));
  write(content, "apps/tool/history.html", '<!--wiki {"title":"t","kind":"reference","updated":"2026-11-03"}-->\n<p>The <code>OLD_LIMIT</code> knob was removed.</p>\n');
  return { repo, piRepo, content, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fact that held at the doc's date and is gone at HEAD counts its doc once, and a placeholder, a newer doc, history and vendor text do not", async () => {
  const { repo, piRepo, content, done } = world();
  try {
    const result = await measureFacts({ run: runNoShell, repo, piRepo, content, readText: path => Promise.resolve(readFileSync(path, "utf8")),
      listPages: async () => ["apps/tool/index.html", "apps/tool/fresh.html", "domains/x/incident.html", "apps/tool/history.html"] });
    assert.equal(result.metrics.source_errors, 0, JSON.stringify(result.flagged));
    assert.equal(result.metrics.skills_with_stale_facts, 1);
    assert.equal(result.metrics.pages_with_stale_facts, 1, "the page dated after the change, the incident and the history sentence do not count");
    assert.equal(result.metrics.docs_with_stale_facts, 3, "the page, the repo skill and the Prime skill");
    const skill = result.flagged!.find(slice => slice.item === ".agents/skills/repo/tool/SKILL.md")!;
    for (const part of ["scripts/tool.mjs has no --old", "OLD_LIMIT is in no code", "ops/gone.sh is gone", "pnpm dev:old is no package.json script"]) assert.match(skill.excerpt, new RegExp(part));
    assert.doesNotMatch(skill.excerpt, /never-there/);
    const page = result.flagged!.find(slice => slice.kind === "stale_page")!;
    assert.equal(page.item, "apps/tool/index.html");
    assert.match(page.excerpt, /OLD_LIMIT/);
    assert.doesNotMatch(page.excerpt, /ops\/gone\.sh/, "a page's <code> path under ops/ is the Wiki dream's to count");
    assert.equal(judge(DUTY.metrics, result).verdict, "missed");
  } finally { done(); }
});

test("a code span in a sentence that tells a removal is not read, and a fence line always is", () => {
  assert.deepEqual(codeSpans("The `A_B` knob was removed. Use `C_D`.\n```\nE_F=1 node scripts/x.mjs --go\n```\n"), ["C_D", "E_F=1 node scripts/x.mjs --go"]);
  assert.deepEqual(readFacts("skill", "```\nE_F=1 node scripts/x.mjs --go\n```\n").map(fact => fact.ref).sort(), ["E_F", "scripts/x.mjs", "scripts/x.mjs --go"]);
});

test("a name the doc also names in a history sentence is history in every sentence of that doc", () => {
  // 2026-11-21: .claude/rules/convex.md counted for `VIEW_READS = false` in a past-tense sentence, while the next one said S7b deleted it.
  const text = "Then 2613785a3e set `VIEW_READS = false` in `convex/x/viewRead.ts`. Later S7b deleted `VIEW_READS`. Keep `OTHER_NAME` on.\n";
  assert.deepEqual(readFacts("rule", text).map(fact => fact.ref).sort(), ["OTHER_NAME", "convex/x/viewRead.ts"]);
});

test("a Prime skill counts when a sieun-pi fact it names is gone at sieun-pi's HEAD, and a test fixture or an auto-sns-agent path does not", async () => {
  // p6 (2026-11-21): the knowledge manager's d1 read only auto-sns-agent's skills, so the Prime skills another job fixed could drift again unseen.
  const { repo, piRepo, content, done } = world();
  try {
    const result = await measureFacts({ run: runNoShell, repo, piRepo, content, readText: path => Promise.resolve(readFileSync(path, "utf8")), listPages: async () => [] });
    assert.equal(result.metrics.source_errors, 0, JSON.stringify(result.flagged));
    assert.equal(result.metrics.prime_skills_with_stale_facts, 1);
    assert.equal(result.info.prime_skills_read, 2, "the fixture under packages/pi-host/test is no skill");
    const skill = result.flagged!.find(slice => slice.kind === "stale_prime_skill")!;
    assert.equal(skill.item, "sieun-pi:skills/board/references/git.md");
    for (const part of ["scripts/release-chat.mjs has no --fast", "PI_HOLD is in no code", "legacy/x/gone.ts is gone"]) assert.match(skill.excerpt, new RegExp(part));
    assert.doesNotMatch(skill.excerpt, /scripts\/tool\.mjs/, "an auto-sns-agent path never held in sieun-pi");
  } finally { done(); }
});

test("a rule file or a root contract counts in skills_with_stale_facts and its rules part when a fact it names is gone at HEAD", async () => {
  // p7 (2026-11-21): d1 read only .claude/rules/app-*.md, so code-quality.md, verification.md, CLAUDE.md and AGENTS.md could drift unseen.
  const { repo, piRepo, content, done } = world({
    ".claude/rules/verification.md": "Run `node scripts/tool.mjs --old` before a commit.\n",
    "CLAUDE.md": "Set `OLD_LIMIT` and run `ops/gone.sh`.\n",
    "AGENTS.md": "Commit with `scripts/tool.mjs`.\n",
  });
  try {
    const result = await measureFacts({ run: runNoShell, repo, piRepo, content, readText: path => Promise.resolve(readFileSync(path, "utf8")), listPages: async () => [] });
    assert.equal(result.metrics.source_errors, 0, JSON.stringify(result.flagged));
    assert.equal(result.info.rules_read, 3);
    assert.equal(result.metrics.skills_with_stale_facts_rules, 2, "AGENTS.md names only a file that still exists");
    assert.equal(result.metrics.skills_with_stale_facts, 3, "the repo skill and the two rule files");
    const rules = result.flagged!.filter(slice => slice.kind === "stale_rule");
    assert.deepEqual(rules.map(slice => slice.item).sort(), [".claude/rules/verification.md", "CLAUDE.md"]);
    assert.match(rules.find(slice => slice.item === "CLAUDE.md")!.excerpt, /^rule file dated .*OLD_LIMIT is in no code.*ops\/gone\.sh is gone/);
    assert.match(rules.find(slice => slice.item === ".claude/rules/verification.md")!.excerpt, /scripts\/tool\.mjs has no --old/);
  } finally { done(); }
});

test("a name an uncommitted delete hides from the checkout still counts as present when HEAD has it", async () => {
  // p7 (2026-11-21): another job's uncommitted delete of funnelSettle.ts hid SYNC_ROWS from rg, so apps/search/campaigns/settle.html counted.
  const { repo, piRepo, content, done } = world({
    "scripts/keep.mjs": "const KEEP_ROWS = 200;\n",
    ".claude/rules/keep.md": "Runs write `KEEP_ROWS` rows at a time.\n",
  });
  try {
    rmSync(join(repo, "scripts/keep.mjs"));
    const result = await measureFacts({ run: runNoShell, repo, piRepo, content, readText: path => Promise.resolve(readFileSync(path, "utf8")), listPages: async () => [] });
    assert.equal(result.metrics.source_errors, 0, JSON.stringify(result.flagged));
    assert.equal(result.metrics.skills_with_stale_facts_rules, 0, JSON.stringify(result.flagged));
  } finally { done(); }
});

test("the curated pages include projects/ beside apps/ and domains/", async () => {
  const { content, done } = world();
  try {
    mkdirSync(join(content, "projects/p/data"), { recursive: true });
    writeFileSync(join(content, "projects/p/index.html"), "<p></p>");
    writeFileSync(join(content, "projects/p/data/x.html"), "<p></p>");
    assert.deepEqual((await listCuratedPages(content)).filter(path => path.startsWith("projects/")), ["projects/p/index.html"]);
  } finally { done(); }
});
