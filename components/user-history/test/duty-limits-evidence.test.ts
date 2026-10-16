import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { appOf, definedElsewhere, dropLeftovers, drops, findLeftovers, type Ledger, leftovers, measureLimits, ownDefinitions, parseGrep, parseLedger, PATTERNS, scan, withKeys }
  from "../scripts/duties/limits-evidence.ts";

const NOW = Date.parse("2026-10-12T18:30:00Z");
const grepRow = (path: string, line: number, text: string) => `dev:${path}\0${line}\0${text}`;
const hit = (file: string, line: number, match: string, kind: "const" | "literal" | "comment" = "const") => ({ file, line, kind, match, text: match });

test("limits evidence: git grep rows become keyed candidates; layout sizes drop and a repeated match gets its occurrence number", () => {
  const rows = [grepRow("apps/search/a.ts", 3, "const FETCH_TIMEOUT_MS = 30_000;"), grepRow("apps/search/a.ts", 9, "const PANEL_MAX_HEIGHT = 460;")].join("\n");
  assert.deepEqual(parseGrep("const", "dev", rows).map(found => [found.file, found.line, found.match]), [["apps/search/a.ts", 3, "FETCH_TIMEOUT_MS"]]);
  const literals = parseGrep("literal", "dev", [grepRow("convex/x.ts", 1, "f({ timeout: 60 })"), grepRow("convex/x.ts", 7, "g({ timeout:60 })"),
    grepRow("convex/x.ts", 8, "{ maxHeight: 280 }")].join("\n"));
  assert.deepEqual(withKeys(literals).map(found => found.key), ["convex/x.ts#timeout:60", "convex/x.ts#timeout:60#2"]);
  assert.deepEqual(parseGrep("comment", "dev", grepRow("ops/a.sh", 2, "sleep 5  # To Be Safe")).map(found => found.match), ["# To Be Safe"]);
  assert.deepEqual(["apps/crawler-v3/src/x.py", "packages/ui/a.ts", "convex/a.ts", "scripts/dev/b.mjs"].map(appOf), ["crawler-v3", "ui", "convex", "scripts"]);
});

test("limits evidence: a request, socket or signal timer set to a number is a candidate, and a bare setTimeout is not", () => {
  const rows = [grepRow("scripts/skills/o.mjs", 149, "req.setTimeout(3_000, () => req.destroy(new Error('timed out')));"),
    grepRow("scripts/x.mjs", 4, "socket.setTimeout( 5000 );"), grepRow("convex/c.ts", 9, "signal: AbortSignal.timeout(10_000),"),
    grepRow("convex/c.ts", 12, "signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),"), grepRow("scripts/y.mjs", 2, "const t = setTimeout(() => done(), 3_000);"),
    grepRow("scripts/y.mjs", 5, "req.setTimeout(0);")].join("\n");
  const pattern = new RegExp(PATTERNS.timer);
  const lines = rows.split("\n").map(row => row.split("\0")[2]!).filter(text => pattern.test(text));
  assert.equal(lines.length, 4, "the named-constant AbortSignal line is the const pattern's, and a bare setTimeout schedules work");
  assert.deepEqual(withKeys(parseGrep("timer", "dev", rows)).map(found => found.key),
    ["convex/c.ts#AbortSignal.timeout(10_000)", "scripts/skills/o.mjs#req.setTimeout(3_000)", "scripts/x.mjs#socket.setTimeout(5000)", "scripts/y.mjs#req.setTimeout(0)"]);
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
      "convex/a.ts#BARE_CAP": { verdict: "kept", evidence: " " },
      "convex/a.ts#GONE_LIMIT": { verdict: "unbacked" },
      "apps/crawler-v3/t.py#RETRY_BACKOFF": { verdict: "owner" },
    },
    runs: [{ at: "2026-10-12T03:30:00+09:00", found: 5, removed: 3, kept: 1 }],
  };
  const next = measureLimits([...found, hit("convex/a.ts", 12, "BARE_CAP"), hit("convex/b.ts", 2, "NEW_LIMIT")], first.state, ledger, NOW);
  assert.deepEqual(next.output.metrics, { unbacked_left: 2, unjudged: 2, removed_back: 1, leftover_refs: 0 },
    "an owner verdict counts as unbacked, a kept one with no evidence as unjudged, and a ledger key gone from the code counts nowhere");
  assert.deepEqual(next.output.flagged?.filter(item => !["app", "detail"].includes(item.kind)).map(item => item.kind), ["new", "new", "back", "unbacked", "unbacked"]);
  assert.match(next.output.flagged?.find(item => item.kind === "detail")?.excerpt ?? "", /^6 candidates on sieun\/dev: 1 kept, 0 not limits, 1 unbacked, 1 owner; ledger has 6 keys; its last run .* found 5, removed 3, kept 1$/);
  assert.equal(next.output.candidates[0]!.key, "convex/a.ts#BARE_CAP", "new candidates come first");
  assert.ok(next.output.flagged?.some(item => item.kind === "app" && item.item === "convex" && item.excerpt.startsWith("4 candidates, 2 new, 2 unjudged, 1 kept")));
});

test("limits evidence: a missing ledger is empty, and a broken one throws so the run fails", () => {
  assert.deepEqual(parseLedger(undefined), { limits: {}, runs: [] });
  assert.throws(() => parseLedger("[]"), /not a ledger/);
});

test("limits evidence: git grep finds caps, numeric settings and hedging comments in the committed source roots, and skips tests, strings, the wiki content and unsaved files", async () => {
  const repo = await mkdtemp(join(tmpdir(), "limits-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  try {
    const files: Record<string, string> = {
      "apps/crawler-v3/src/tuning.py": "CENSUS_WRITE_CAP_MB_S = 75  # to be safe\nRATE_LIMITED = \"rate_limited_share\"\nclient = httpx.Client(timeout=30)\n",
      "convex/search/a.ts": "const DRAIN_BATCH = 200;\nawait run({ concurrency: 4 });\nconst panel = { maxHeight: 280 };\n",
      "apps/search/src/a.test.ts": "const MAX_ROWS = 5;\n",
      "apps/llm-wiki/content/sessions/x.ts": "const MAX_ROWS = 5;\n",
      "docs/b.ts": "const MAX_ROWS = 5;\n",
    };
    const write = async (set: Record<string, string>) => {
      for (const [path, text] of Object.entries(set)) { await mkdir(join(repo, path, ".."), { recursive: true }); await writeFile(join(repo, path), text); }
    };
    git("init", "-q", "-b", "dev");
    await write(files);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    await write({ "apps/virev-demo/overlay/x.ts": "const SEND_CAP = 3;\n", "convex/search/a.ts": "const DRAIN_BATCH = 200;\nconst UNSAVED_MAX = 9;\n" });
    const keys = withKeys(await scan(repo, "dev")).map(found => found.key).sort();
    assert.deepEqual(keys, ["apps/crawler-v3/src/tuning.py## to be safe", "apps/crawler-v3/src/tuning.py#CENSUS_WRITE_CAP_MB_S", "apps/crawler-v3/src/tuning.py#timeout=30",
      "convex/search/a.ts#DRAIN_BATCH", "convex/search/a.ts#concurrency:4"], "another job's unsaved edit or untracked file is not the code");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("limits evidence duty file parses, runs daily, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "limits-evidence.duty.json"), "utf8")), "d", NOW);
  assert.equal(duty.name, "Limits rest on evidence");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "03:30" });
  assert.equal(duty.metrics[0]?.key, "unbacked_left");
  assert.equal(duty.metrics[0]?.headline, true);
  assert.ok(duty.metrics.length <= 4, "one headline and at most 3 supporting metrics (c75)");
  const { output } = measureLimits([], undefined, { limits: {}, runs: [] }, NOW);
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
});

test("limits evidence: a drop commit that leaves a reference to the dropped name fails the stack check and shows in the precheck", async () => {
  const repo = await mkdtemp(join(tmpdir(), "limits-drop-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) { await mkdir(join(repo, path, ".."), { recursive: true }); await writeFile(join(repo, path), text); }
    git("add", "-A");
  };
  try {
    git("init", "-q", "-b", "dev");
    await write({
      "apps/search/src/lib/clickhouse.ts": "export const CH_INSERT_TIMEOUT_MS = 30_000;\nexport const chInsert = () => fetch(url, { signal: AbortSignal.timeout(CH_INSERT_TIMEOUT_MS) });\n",
      "apps/search/src/routes/deliver.ts": "import { chInsert, CH_INSERT_TIMEOUT_MS } from '$lib/clickhouse';\nconst WORST_BATCH_MS = 2 * CH_INSERT_TIMEOUT_MS;\n",
      "apps/admin/src/other.ts": "const CH_INSERT_TIMEOUT_MS = 5_000;\nawait run(CH_INSERT_TIMEOUT_MS);\n",
      "apps/llm-wiki/content/domains/devops/limits-ledger.json": "{\"note\": \"CH_INSERT_TIMEOUT_MS\"}\n",
    });
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    await write({ "apps/search/src/lib/clickhouse.ts": "export const chInsert = () => fetch(url);\n" });
    git("commit", "-q", "-m", "chore(search): drop unbacked limit CH_INSERT_TIMEOUT_MS");
    const stack = await drops(repo, base, "HEAD");
    assert.deepEqual(stack.map(drop => [drop.name, [...drop.files]]), [["CH_INSERT_TIMEOUT_MS", ["apps/search/src/lib/clickhouse.ts"]]]);
    const hits = await leftovers(repo, "HEAD", ["CH_INSERT_TIMEOUT_MS"]);
    assert.ok(!hits.some(hit => hit.file.startsWith("apps/llm-wiki/content/")), "the wiki content is never searched");
    assert.deepEqual([...ownDefinitions(hits)], ["apps/admin/src/other.ts#CH_INSERT_TIMEOUT_MS"]);
    const left = dropLeftovers(hits, "CH_INSERT_TIMEOUT_MS", stack[0]!.files, ownDefinitions(hits));
    assert.deepEqual(left.map(hit => `${hit.file}:${hit.line}`), ["apps/search/src/routes/deliver.ts:1", "apps/search/src/routes/deliver.ts:2"],
      "the route still imports the dropped name; the admin file's own limit of that name does not count");

    assert.ok(definedElsewhere(ownDefinitions(hits), "CH_INSERT_TIMEOUT_MS", stack[0]!.files), "the admin file still defines the name");
    const ledger: Ledger = { limits: { "apps/search/src/lib/clickhouse.ts#CH_INSERT_TIMEOUT_MS": { verdict: "removed" } }, runs: [] };
    assert.deepEqual(await findLeftovers(repo, ledger, new Set(), "dev"), [], "a name another file still defines is checked by hand");
    git("rm", "-q", "apps/admin/src/other.ts");
    git("commit", "-q", "-m", "chore(admin): drop the other file");
    const found = await findLeftovers(repo, ledger, new Set(), "dev");
    assert.deepEqual(found.map(finding => [finding.key, finding.rev, finding.hits.length]), [["apps/search/src/lib/clickhouse.ts#CH_INSERT_TIMEOUT_MS", "dev", 2]]);
    const { output } = measureLimits([], { keys: [] }, ledger, NOW, found);
    assert.equal(output.metrics.leftover_refs, 1);
    assert.match(output.flagged?.find(item => item.kind === "leftover")?.excerpt ?? "", /dropped CH_INSERT_TIMEOUT_MS .* dev still names it in apps\/search\/src\/routes\/deliver\.ts:1/);

    await write({ "apps/search/src/routes/deliver.ts": "import { chInsert } from '$lib/clickhouse';\n" });
    git("commit", "-q", "-m", "chore(search): the deliver route stops reading CH_INSERT_TIMEOUT_MS");
    const after = await leftovers(repo, "HEAD", ["CH_INSERT_TIMEOUT_MS"]);
    assert.deepEqual(dropLeftovers(after, "CH_INSERT_TIMEOUT_MS", stack[0]!.files, ownDefinitions(after)), []);
    assert.deepEqual(await findLeftovers(repo, ledger, new Set(), "dev"), []);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
