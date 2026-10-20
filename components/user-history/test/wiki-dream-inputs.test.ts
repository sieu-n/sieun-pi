// Guards a wiki dream precheck crash found on 2026-10-19: measureDream read each input with `.then(parse, fail)`, so when wiki-health
// printed no facts object, or a ledger, corrections.json or harness_state.json file had the wrong shape, the parse threw past `fail`
// and the whole precheck died with no output file instead of recording a source_error and 999999 for that input's metrics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureDream, UNMEASURED, type DreamDeps } from "../scripts/duties/wiki-dream.ts";

const NOW = Date.parse("2026-10-19T17:00:00Z");
const JOURNAL = [
  `${NOW / 1000 - 60} us-metal02 systemd[1]: Starting wiki-box-commit.service - wiki-box-commit...`,
  `${NOW / 1000 - 30} us-metal02 systemd[1]: Finished wiki-box-commit.service - wiki-box-commit.`,
].join("\n");

const deps: DreamDeps = {
  now: NOW, node: "node", repos: { wiki: "/wiki", pi: "/pi" },
  files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
  readText: async path => ({ corrections: "{}", harness: "[]", ledger: "[]" })[path]!,
  exec: async file => {
    if (file === "node") return JSON.stringify({ items: [] });
    if (file === "journalctl") return JOURNAL;
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
