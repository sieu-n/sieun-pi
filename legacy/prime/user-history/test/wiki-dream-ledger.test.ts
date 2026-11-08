// Guards the wiki dream ledger rows nobody closed after their fix landed. page_states_unlanded_commit kept open_mistakes at 1 at
// 2026-11-08T17:00Z though its fix, sieun-pi bddf1d97, landed at 16:34:16Z, and dream_write_clobber sat at "fixing" from 11-05 to 11-09,
// which open_mistakes did not count, though 76bd7a2f fixed it on 11-04.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classStates, measureDream, type DreamDeps, type Ledger, type TrailerFix } from "../scripts/duties/wiki-dream.ts";

const at = (iso: string): number => Date.parse(iso);

test("any class status but fixed counts as open", () => {
  const ledger: Ledger = {
    classes: {
      dream_write_clobber: { status: "fixing", firstSeen: "2026-11-04T10:00Z" },
      done: { status: "fixed", firstSeen: "2026-11-01T10:00Z" },
      reopened_one: { status: "reopened", firstSeen: "2026-11-02T10:00Z" },
    },
  };
  const states = classStates(ledger, at("2026-11-09T02:00:00Z"), at("2026-11-08T02:00:00Z"));
  assert.deepEqual(states.open.map(([slug]) => slug), ["dream_write_clobber", "reopened_one"]);
  assert.deepEqual(states.due.map(([slug]) => slug), ["dream_write_clobber", "reopened_one"]);
});

test("a trailer commit newer than the class's last opening reads as fixed, an older one does not", () => {
  const ledger: Ledger = {
    classes: {
      page_states_unlanded_commit: { status: "open", firstSeen: "2026-11-08T16:33Z", recurred: [] },
      fix_before_found: { status: "open", firstSeen: "2026-11-08T12:00Z" },
      back_after_old_fix: { status: "reopened", firstSeen: "2026-11-01T10:00Z", recurred: ["2026-11-08T09:00:00Z"] },
    },
  };
  const fixes = new Map<string, TrailerFix>([
    ["page_states_unlanded_commit", { repo: "sieun-pi", sha: "bddf1d97aa00000000000000000000000000000", at: at("2026-11-08T16:34:16Z") }],
    ["fix_before_found", { repo: "sieun-pi", sha: "1111111111", at: at("2026-11-08T11:00:00Z") }],
    ["back_after_old_fix", { repo: "auto-sns-agent", sha: "2222222222", at: at("2026-11-02T10:00:00Z") }],
  ]);
  const states = classStates(ledger, at("2026-11-08T17:00:00Z"), at("2026-11-08T16:40:00Z"), fixes);
  assert.deepEqual(states.landed.map(([slug]) => slug), ["page_states_unlanded_commit"]);
  assert.deepEqual(states.due.map(([slug]) => slug), ["fix_before_found", "back_after_old_fix"]);
  assert.equal(states.open.length, 3);
});

test("open_mistakes leaves out a landed fix and the flagged list names it once for the next run to copy in", async () => {
  const ledger: Ledger = {
    classes: {
      page_states_unlanded_commit: { status: "open", title: "Pages say a commit is not on staging yet", firstSeen: "2026-11-08T16:33Z" },
      dream_write_clobber: { status: "fixing", title: "A dream write clobbers a page", firstSeen: "2026-11-05T10:00Z" },
    },
  };
  const secs = (iso: string): number => at(iso) / 1000;
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }), harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }), ledger: JSON.stringify(ledger),
  };
  const deps: DreamDeps = {
    now: at("2026-11-08T17:00:00Z"), node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => files[path]!,
    exec: async (file, args) => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } });
      if (!args.includes("--grep=Dream-class:") || args[1] !== "/pi") return "";
      return `\x1ebddf1d97aa00000000000000000000000000000000\x1f${secs("2026-11-08T16:34:16Z")}\x1fpage_states_unlanded_commit\n`;
    },
  };
  const result = await measureDream(deps, [{ at: at("2026-11-08T16:40:00Z"), verdict: "met" }] as never);
  assert.equal(result.metrics.open_mistakes, 1);
  assert.equal(result.info.open_classes, 2);
  const open = (result.flagged ?? []).filter(slice => slice.kind === "open_class");
  assert.deepEqual(open.map(slice => slice.item), ["page_states_unlanded_commit", "dream_write_clobber"]);
  assert.match(open[0]!.excerpt, /^fixed by sieun-pi bddf1d97aa, ledger row still open: Pages say/);
  assert.match(open[1]!.excerpt, /^fixing: A dream write clobbers a page/);
});
