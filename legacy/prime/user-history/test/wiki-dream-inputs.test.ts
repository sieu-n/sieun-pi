// Guards a wiki dream precheck crash found on 2026-10-19: measureDream read each input with `.then(parse, fail)`, so when wiki-health
// printed no facts object, or a ledger, corrections.json or harness_state.json file had the wrong shape, the parse threw past `fail`
// and the whole precheck died with no output file instead of recording a source_error and 999999 for that input's metrics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureDream, UNMEASURED, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const NOW = Date.parse("2026-10-19T17:00:00Z");

const deps: DreamDeps = {
  now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
  files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
  readText: async path => ({ corrections: "{}", harness: "[]", ledger: "[]" })[path]!,
  exec: async file => {
    if (file === "node") return JSON.stringify({ items: [] });
    return "";
  },
};

test("an input that reads but does not parse records a source_error instead of crashing the precheck", async () => {
  const result = await measureDream(deps, []);
  const sources = (result.flagged ?? []).filter(slice => slice.kind === "source_error").map(slice => slice.item).sort();
  assert.deepEqual(sources, ["corrections.json", "harness_state.json", "ledger", "wiki-health.mjs"]);
  assert.equal(result.metrics.source_errors, 4);
  assert.equal(result.metrics.wiki_problems, UNMEASURED);
  assert.equal(result.metrics.open_mistakes, UNMEASURED);
  assert.equal(result.metrics.memory_rules_over_glide, UNMEASURED);
});

// Guards the 16:09Z d4 run on 2026-11-03: its retouched items still counted (wiki-dream) git commits and named pages
// auto-sns-agent:apps/llm-wiki/content/<path>, though the pages left git in b767305544, so writers copied a commit.mjs brief.
test("retouched counts a page's dream revisions in wiki.db by its wiki path, and drops old content paths from git", async () => {
  const log = (sha: string, files: string[]) => `\x1e${sha}\x1fdocs(wiki-dream): refresh\n${files.join("\n")}\n`;
  const result = await measureDream({
    ...deps,
    exec: async (file, _args, options) => {
      if (file === "node") return JSON.stringify({ items: [] });
      return options.cwd === "/pi" ? log("a1", ["skills/wiki/SKILL.md", "apps/llm-wiki/content/apps/search/x.html"]) + log("b2", ["skills/wiki/SKILL.md", "apps/llm-wiki/content/apps/search/x.html"]) : "";
    },
    revisions: async () => [
      { path: "apps/search/onboarding-orgs.html", author: "agent", summary: "wiki dream: names the 12-pack" },
      { path: "apps/search/onboarding-orgs.html", author: "wiki-dream-1508", summary: "" },
      { path: "apps/search/onboarding-orgs.html", author: "search-product", summary: "a product edit" },
      { path: "apps/search/campaigns.html", author: "agent", summary: "wiki-dream: one pass" },
    ],
  }, []);
  const retouched = (result.flagged ?? []).filter(slice => slice.kind === "retouched");
  assert.deepEqual(retouched.map(slice => slice.item), ["apps/search/onboarding-orgs.html", "sieun-pi:skills/wiki/SKILL.md"]);
  assert.match(retouched[0]!.excerpt, /changed by 2 wiki-dream page revisions in 7 days/);
  assert.equal(result.metrics.pages_retouched, 2);
});
