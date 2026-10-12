import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { appOf, type Ledger, measureLimits, parseLedger, parseRg, scan, withKeys } from "../scripts/duties/limits-evidence.ts";

const NOW = Date.parse("2026-10-12T18:30:00Z");
const rgMatch = (path: string, line: number, text: string, match: string) =>
  JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: line, submatches: [{ match: { text: match }, start: 0, end: 1 }] } });
const hit = (file: string, line: number, match: string, kind: "const" | "literal" | "comment" = "const") => ({ file, line, kind, match, text: match });

test("limits evidence: rg json becomes keyed candidates; layout sizes drop and a repeated match gets its occurrence number", () => {
  const json = [
    JSON.stringify({ type: "begin", data: { path: { text: "apps/search/a.ts" } } }),
    rgMatch("apps/search/a.ts", 3, "const FETCH_TIMEOUT_MS = 30_000;", "FETCH_TIMEOUT_MS = 3"),
    rgMatch("apps/search/a.ts", 9, "const PANEL_MAX_HEIGHT = 460;", "PANEL_MAX_HEIGHT = 4"),
  ].join("\n");
  assert.deepEqual(parseRg("const", json).map(found => found.match), ["FETCH_TIMEOUT_MS"]);
  const literals = parseRg("literal", [rgMatch("convex/x.ts", 1, "f({ timeout: 60 })", "timeout: 60"), rgMatch("convex/x.ts", 7, "g({ timeout:60 })", "timeout:60"),
    rgMatch("convex/x.ts", 8, "{ maxHeight: 280 }", "maxHeight: 280")].join("\n"));
  assert.deepEqual(withKeys(literals).map(found => found.key), ["convex/x.ts#timeout:60", "convex/x.ts#timeout:60#2"]);
  assert.deepEqual(["apps/crawler-v3/src/x.py", "packages/ui/a.ts", "convex/a.ts", "scripts/dev/b.mjs"].map(appOf), ["crawler-v3", "ui", "convex", "scripts"]);
});

test("limits evidence: the first run saves a baseline, the next flags only new candidates, and the metrics count verdicts from the ledger", () => {
  const found = [hit("apps/crawler-v3/t.py", 1, "WRITE_CAP"), hit("apps/crawler-v3/t.py", 2, "RETRY_BACKOFF"), hit("convex/a.ts", 4, "DRAIN_BATCH"), hit("convex/a.ts", 9, "OLD_MAX")];
  const first = measureLimits(found, undefined, { limits: {}, runs: [] }, NOW);
  assert.equal(first.output.metrics.unjudged, 4);
  assert.deepEqual(first.output.flagged?.filter(item => item.kind === "new"), []);
  assert.ok(first.output.flagged?.some(item => item.kind === "baseline"));
  const ledger: Ledger = {
    limits: {
      "apps/crawler-v3/t.py#WRITE_CAP": { verdict: "unbacked", commit: "abc on ci/limits-crawler-v3-261013" },
      "convex/a.ts#DRAIN_BATCH": { verdict: "kept", evidence: "Convex read limit, https://docs.convex.dev/production/state/limits" },
      "convex/a.ts#OLD_MAX": { verdict: "removed" },
      "convex/a.ts#GONE_LIMIT": { verdict: "kept", evidence: " " },
      "apps/crawler-v3/t.py#RETRY_BACKOFF": { verdict: "owner" },
    },
    runs: [{ at: "2026-10-12T03:30:00+09:00", found: 5, removed: 3, kept: 1 }],
  };
  const next = measureLimits([...found, hit("convex/b.ts", 2, "NEW_LIMIT")], first.state, ledger, NOW);
  assert.deepEqual(next.output.metrics, { unjudged: 1, unbacked_left: 1, removed_back: 1, kept_no_evidence: 1, owner_calls: 1, unbacked_found: 5, unbacked_removed: 3, ledger_errors: 0 });
  assert.deepEqual(next.output.flagged?.filter(item => item.kind !== "app").map(item => item.kind), ["new", "back", "unbacked", "no_evidence", "owner"]);
  assert.equal(next.output.candidates[0]!.key, "convex/b.ts#NEW_LIMIT", "new candidates come first");
  assert.ok(next.output.flagged?.some(item => item.kind === "app" && item.item === "convex" && item.excerpt.startsWith("3 candidates, 1 new, 1 unjudged, 1 kept")));
});

test("limits evidence: a missing ledger is empty, a broken one is one flagged error with every metric still written", () => {
  assert.deepEqual(parseLedger(undefined), { limits: {}, runs: [] });
  assert.throws(() => parseLedger("[]"), /not a ledger/);
  const { output } = measureLimits([hit("ops/a.mjs", 1, "MAX_X")], { keys: [] }, { error: "not a ledger" }, NOW);
  assert.equal(output.metrics.ledger_errors, 1);
  assert.equal(output.metrics.unjudged, 1);
  assert.equal(output.flagged?.[0]?.kind, "ledger");
});

test("limits evidence: rg finds caps, numeric settings and hedging comments in source roots, and skips tests, strings and the wiki content", async () => {
  const repo = await mkdtemp(join(tmpdir(), "limits-repo-"));
  try {
    const files: Record<string, string> = {
      "apps/crawler-v3/src/tuning.py": "CENSUS_WRITE_CAP_MB_S = 75  # to be safe\nRATE_LIMITED = \"rate_limited_share\"\nclient = httpx.Client(timeout=30)\n",
      "convex/search/a.ts": "const DRAIN_BATCH = 200;\nawait run({ concurrency: 4 });\nconst panel = { maxHeight: 280 };\n",
      "apps/search/src/a.test.ts": "const MAX_ROWS = 5;\n",
      "apps/llm-wiki/content/sessions/x.ts": "const MAX_ROWS = 5;\n",
      "docs/b.ts": "const MAX_ROWS = 5;\n",
    };
    for (const [path, text] of Object.entries(files)) { await mkdir(join(repo, path, ".."), { recursive: true }); await writeFile(join(repo, path), text); }
    const keys = withKeys(await scan(repo)).map(found => found.key).sort();
    assert.deepEqual(keys, ["apps/crawler-v3/src/tuning.py## to be safe", "apps/crawler-v3/src/tuning.py#CENSUS_WRITE_CAP_MB_S", "apps/crawler-v3/src/tuning.py#timeout=30",
      "convex/search/a.ts#DRAIN_BATCH", "convex/search/a.ts#concurrency:4"]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("limits evidence duty file parses, runs daily, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "limits-evidence.duty.json"), "utf8")), "d", NOW);
  assert.equal(duty.name, "Limits rest on evidence");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "03:30" });
  const { output } = measureLimits([], undefined, { limits: {}, runs: [] }, NOW);
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
});
