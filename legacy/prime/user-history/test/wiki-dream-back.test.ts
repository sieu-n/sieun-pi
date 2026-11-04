// Guards the wiki dream mistakes_back miscount of 2026-10-18. slop_in_replies_and_pages recurred at 05:39Z and 06:55Z and got a new fix at
// 07:01:16Z, and owner_mac_and_machines recurred at 05:20Z and got a new fix at 06:39:51Z. The metric counted both for 7 days whatever the new
// fixes did, so only a recurrence after the current fix counts as back, and recurred_7d keeps the churn visible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classStates, measureDream, type DreamDeps, type Ledger } from "../scripts/duties/wiki-dream.ts";

test("a class is back only when it recurred after its current fix, or has no fix date", () => {
  const ledger: Ledger = {
    classes: {
      slop_in_replies_and_pages: {
        status: "fixed", fixCommit: "sieun-pi 08cb72ba4", fixedAt: "2026-10-18T07:01:16Z",
        recurred: ["2026-10-18T03:19:26Z", "2026-10-18T05:39:20Z", "2026-10-18T06:55:04Z"],
      },
      owner_mac_and_machines: { status: "fixed", fixCommit: "sieun-pi 1880d471c", fixedAt: "2026-10-18T06:39:51Z", recurred: ["2026-10-18T05:20:25Z"] },
      fix_failed_again: { status: "fixed", fixedAt: "2026-10-18T06:00:00Z", recurred: ["2026-10-18T05:00:00Z", "2026-10-18T07:30:00Z"] },
      no_fix_date: { status: "fixed", recurred: ["2026-10-18T05:00:00Z"] },
      old_churn: { status: "fixed", recurred: ["2026-10-09T05:00:00Z"] },
    },
  };
  const states = classStates(ledger, Date.parse("2026-10-18T07:46:00Z"));
  assert.deepEqual(states.back.map(([slug]) => slug), ["fix_failed_again", "no_fix_date"]);
  assert.deepEqual(states.recurred.map(([slug]) => slug), ["slop_in_replies_and_pages", "owner_mac_and_machines", "fix_failed_again", "no_fix_date"]);
});

// On 2026-10-21 every run still flagged these classes as "came back before its current fix", though mistakes_back read 0.
test("the flagged list names a class back after its current fix and leaves out one that came back before it", async () => {
  const ledger: Ledger = {
    classes: {
      slop_in_replies_and_pages: {
        status: "fixed", fixCommit: "sieun-pi 08cb72ba4", fixedAt: "2026-10-18T07:01:16Z",
        recurred: ["2026-10-18T05:39:20Z", "2026-10-18T06:55:04Z"],
      },
      fix_failed_again: { status: "fixed", fixedAt: "2026-10-18T06:00:00Z", recurred: ["2026-10-18T05:00:00Z", "2026-10-18T07:30:00Z"] },
    },
  };
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }),
    harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }),
    ledger: JSON.stringify(ledger),
  };
  const deps: DreamDeps = {
    now: Date.parse("2026-10-19T07:46:00Z"), node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => files[path]!,
    exec: async file => file === "node" ? JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } }) : "",
  };
  const result = await measureDream(deps, []);
  const recurred = (result.flagged ?? []).filter(slice => slice.kind === "recurred");
  assert.deepEqual(recurred.map(slice => slice.item), ["fix_failed_again"]);
  assert.match(recurred[0]!.excerpt, /came back on 2026-10-18T07:30:00Z, after its current fix \(2026-10-18T06:00:00Z\)/);
  assert.equal(result.metrics.mistakes_back, 1);
  assert.equal(result.info.recurred_7d, 2);
});

// On 2026-11-04 dream_second_writes recurred at 18:06Z and sieun-pi 76bd7a2f fixed it at 18:16:18Z, but the ledger still named eaca53de at
// 12:13Z, so mistakes_back read 1 for 3 runs. A `Dream-class` trailer commit now moves the fix time up with no ledger write.
test("a Dream-class trailer commit newer than the ledger's fix is the class's current fix", async () => {
  const ledger: Ledger = {
    classes: {
      dream_second_writes: { status: "fixing", fixCommit: "sieun-pi eaca53de", fixedAt: "2026-11-04T12:13:00Z", recurred: ["2026-11-04T18:06:00Z"] },
      back_after_trailer: { status: "fixed", fixedAt: "2026-11-04T10:00:00Z", recurred: ["2026-11-04T19:00:00Z"] },
    },
  };
  const at = (iso: string): number => Date.parse(iso) / 1000;
  const logs: Record<string, string> = {
    "sieun-pi": `\x1e76bd7a2f9e75dc222681143548dfe0f34020e57a\x1f${at("2026-11-04T18:16:18Z")}\x1fdream_second_writes\n`
      + `\x1eeaca53de00000000000000000000000000000000\x1f${at("2026-11-04T12:13:00Z")}\x1fdream_second_writes\n`,
    "auto-sns-agent": `\x1eabc1230000000000000000000000000000000000\x1f${at("2026-11-04T18:30:00Z")}\x1fback_after_trailer\x1dother_class\n`,
  };
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }),
    harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }),
    ledger: JSON.stringify(ledger),
  };
  const deps: DreamDeps = {
    now: Date.parse("2026-11-04T19:18:00Z"), node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => files[path]!,
    exec: async (file, args) => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } });
      if (!args.includes("--grep=Dream-class:")) return "";
      assert.ok(args.includes("--first-parent"));
      return args[1] === "/pi" ? (assert.ok(args.includes("origin/main")), logs["sieun-pi"]!) : logs["auto-sns-agent"]!;
    },
  };
  const result = await measureDream(deps, []);
  const recurred = (result.flagged ?? []).filter(slice => slice.kind === "recurred");
  assert.deepEqual(recurred.map(slice => slice.item), ["back_after_trailer"]);
  assert.match(recurred[0]!.excerpt, /came back on 2026-11-04T19:00:00Z, after its current fix \(2026-11-04T18:30:00Z\) auto-sns-agent abc1230000/);
  assert.equal(result.metrics.mistakes_back, 1);
  assert.equal(result.metrics.source_errors, 0);
  assert.equal(result.info.recurred_7d, 2);
});

test("a failed Dream-class read leaves mistakes_back unmeasured", async () => {
  const facts = { hub_orphans: 0, dead_links: 0, session_links: 0, superseded_linked: 0, missing_meta: 0, stale_vs_code: 0, lint_failing_pages: 0 };
  const files: Record<string, string> = {
    corrections: JSON.stringify({ corrections: [] }), harness: JSON.stringify({ entries: { memory: {} }, refinements: [] }), ledger: JSON.stringify({ classes: {} }),
  };
  const deps: DreamDeps = {
    now: Date.parse("2026-11-04T19:18:00Z"), node: "node", repos: { wiki: "/wiki", pi: "/pi" },
    files: { corrections: "corrections", harness: "harness", ledger: "ledger", agentDir: "/nonexistent-agent-dir" },
    readText: async path => files[path]!,
    exec: async (file, args) => {
      if (file === "node") return JSON.stringify({ facts, items: [], errors: [], dupPairs: [], signals: [], stale: { stale: [] } });
      if (args.includes("--grep=Dream-class:") && args[1] === "/pi") throw new Error("timed out after 60 s");
      return "";
    },
  };
  const result = await measureDream(deps, []);
  assert.equal(result.metrics.mistakes_back, 999_999);
  assert.ok((result.flagged ?? []).some(slice => slice.kind === "source_error" && slice.item === "git log sieun-pi Dream-class"));
});
