// Guards the Wiki and skill facts duty of 2026-11-20 (knowledge manager p3): a page or skill counts when a code fact it names held at its own
// date and is gone at HEAD, as apps/crawler-v3/architecture/media-pipeline still named TIKTOK_EMBED_READS_PER_WINDOW after 77fc4e1c26 dropped it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { judge, type DutyMetric } from "../src/shared/chat-duties.ts";
import { codeSpans, measureFacts, readFacts, runNoShell } from "../scripts/duties/wiki-skill-facts.ts";

const DUTY = JSON.parse(readFileSync(new URL("../scripts/duties/wiki-skill-facts.duty.json", import.meta.url), "utf8")) as { metrics: DutyMetric[] };

function world(): { repo: string; content: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wiki-skill-facts-"));
  const repo = join(root, "repo"), content = join(root, "content");
  const write = (base: string, path: string, text: string): void => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text); };
  const git = (args: string[], at: string): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, stdio: "ignore" });
  };
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], "2026-11-01T00:00:00Z");
  write(repo, "scripts/tool.mjs", "const OLD_LIMIT = 1;\nif (process.argv.includes('--old')) run();\n");
  write(repo, "ops/gone.sh", "echo gone\n");
  write(repo, "package.json", JSON.stringify({ scripts: { "dev:old": "x", dev: "y" } }));
  write(repo, ".agents/skills/repo/tool/SKILL.md", "---\nname: tool\n---\nRun `node scripts/tool.mjs --old` with `OLD_LIMIT` set, then `ops/gone.sh` and `pnpm dev:old`.\nAn example path is `scripts/never-there.mjs`.\n");
  write(repo, ".agents/skills/stack/vendor/SKILL.md", "---\nname: vendor\nmetadata:\n  author: Vendor Inc\n---\nSet `OLD_LIMIT`.\n");
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
  return { repo, content, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fact that held at the doc's date and is gone at HEAD counts its doc once, and a placeholder, a newer doc, history and vendor text do not", async () => {
  const { repo, content, done } = world();
  try {
    const result = await measureFacts({ run: runNoShell, repo, content, readText: path => Promise.resolve(readFileSync(path, "utf8")),
      listPages: async () => ["apps/tool/index.html", "apps/tool/fresh.html", "domains/x/incident.html", "apps/tool/history.html"] });
    assert.equal(result.metrics.source_errors, 0, JSON.stringify(result.flagged));
    assert.equal(result.metrics.skills_with_stale_facts, 1);
    assert.equal(result.metrics.pages_with_stale_facts, 1, "the page dated after the change, the incident and the history sentence do not count");
    assert.equal(result.metrics.docs_with_stale_facts, 2);
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
