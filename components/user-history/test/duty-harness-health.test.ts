import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { description, measureHarness, overlaps, SKILL_SMOKE_FILE, type Skill, type SkillRoot, type View } from "../scripts/duties/harness-health.ts";
import { measureCache, MIN_CALLS, readTranscript, type Call, type SessionCalls } from "../scripts/duties/cache-ratio.ts";

const NOW = Date.parse("2026-10-10T04:00:00Z");
const DAY = 24 * 60 * 60_000;
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const skillMd = (name: string, about: string) => `---\nname: ${name}\ndescription: "${about}"\n---\n\n# ${name}\n`;
const chat = (id: string) => ({ id, name: `chat ${id}` });
const TARGETS = { cache_read_ratio_1h: 90, cache_read_ratio_24h: 94 };
const noCache = { sessions: async () => [], cacheTargets: TARGETS };

async function tree(): Promise<{ dir: string; roots: SkillRoot[]; dataDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "harness-health-"));
  const repo = join(dir, "repo"), prime = join(dir, "prime"), source = join(dir, "source"), dataDir = join(dir, "data");
  const write = async (path: string, text: string) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); };
  await write(join(repo, "apps/search/SKILL.md"), skillMd("search", "When changing the search app routes, billing, credits and landing pages."));
  await write(join(repo, "apps/search-chat/SKILL.md"), skillMd("search-chat", "When changing the search app chat, billing, credits and landing pages dock."));
  await write(join(repo, "stack/stale/SKILL.md"), skillMd("stale", "When writing ClickHouse queries."));
  await write(join(source, "why/SKILL.md"), skillMd("why", "Use for design rationale questions."));
  await mkdir(prime, { recursive: true });
  await symlink(join(source, "why"), join(prime, "why"));
  await symlink(join(repo, "apps/search"), join(prime, "search-link"));
  const entry = (id: string, at: string, repeats: { at: string; chat: { id: string; name: string }; words: string }[]) => ({ id, at, chat: chat("a"), words: "first",
    rule: `rule ${id}`, enforcedBy: "brief", ref: "brief bullet", status: "active", theme: ["x"], repeats });
  await write(join(dataDir, "corrections.json"), JSON.stringify({ corrections: [
    entry("c1", iso(20 * DAY), [{ at: iso(10 * DAY), chat: chat("b"), words: "too old" }, { at: iso(2 * DAY), chat: chat("c"), words: "again, the same thing" }]),
    entry("c2", iso(3 * DAY), []),
  ] }));
  return { dir, dataDir, roots: [{ name: "repo", dir: repo, views: "@code/.agents/skills/" }, { name: "prime", dir: prime }] };
}

test("harness health: frontmatter descriptions in one line, quoted, or folded", () => {
  assert.equal(description("---\nname: a\ndescription: plain words here\n---\n"), "plain words here");
  assert.equal(description("---\nname: a\ndescription: \"quoted: words\"\n---\n"), "quoted: words");
  assert.equal(description("---\nname: a\ndescription: >-\n  folded line one\n  line two\nmetadata: x\n---\n"), "folded line one line two");
  assert.equal(description("# no frontmatter\n"), "");
});

test("harness health: outcomes only; repeat corrections in 7 days, skills read in 14 days, overlapping descriptions, and no smoke file yet", async () => {
  const { dir, roots, dataDir } = await tree();
  try {
    const views: View[] = [
      { path: "@code/.agents/skills/apps/search/references/routes.md", ts: iso(2 * DAY) },
      { path: "@code/.agents/skills/apps/search-chat/SKILL.md", ts: iso(DAY) },
      { path: "@code/.agents/skills/apps/search-chat/SKILL.md", ts: iso(3 * DAY) },
    ];
    let askedSince = "";
    const result = await measureHarness({ roots, dataDir, now: NOW, views: async since => { askedSince = since; return views; }, ...noCache });
    assert.equal(askedSince, iso(14 * DAY));
    const byId = new Map(result.skills.map(skill => [skill.id, skill]));
    assert.deepEqual(result.skills.map(skill => skill.id), ["prime:why", "repo:apps/search", "repo:apps/search-chat", "repo:stack/stale"], "the symlinked repo skill counts once");
    assert.equal(byId.get("repo:apps/search-chat")!.lastRead, iso(DAY));
    assert.equal(byId.get("repo:stack/stale")!.lastRead, null);
    assert.equal(byId.get("prime:why")!.lastRead, undefined, "a root with no view events is untracked, not unread");
    assert.equal(byId.get("prime:why")!.dir.endsWith("/source/why"), true);

    assert.deepEqual(result.metrics, { skill_smoke_failures: 0, repeat_corrections_7d: 1, unread_14d: 1, overlapping_pairs: 1, cache_read_ratio_1h: 100, cache_read_ratio_24h: 100 },
      "no size counts");
    const kinds = result.flagged!.map(slice => slice.kind);
    assert.deepEqual([...new Set(kinds)], ["cache_read_ratio_1h", "cache_read_ratio_24h", "skill_smoke_failures", "repeat_corrections_7d", "unread_14d", "overlap", "untracked"]);
    assert.match(result.flagged!.find(slice => slice.kind === "skill_smoke_failures")!.excerpt, /no .*skill-smoke\.json yet: no skill smoke duty has run, so skill_smoke_failures is 0/);
    const repeat = result.flagged!.find(slice => slice.kind === "repeat_corrections_7d")!;
    assert.equal(repeat.chat, "c");
    assert.equal(repeat.excerpt, "c1 \"rule c1\" (enforced by brief: brief bullet) given again in chat c: again, the same thing");
    assert.match(result.flagged!.find(slice => slice.kind === "overlap")!.excerpt, /repo:apps\/search and repo:apps\/search-chat share \d+% of description words: .*billing/);
    assert.equal(result.flagged!.find(slice => slice.kind === "unread_14d")!.excerpt, `repo:stack/stale (${byId.get("repo:stack/stale")!.dir}) has no view event since 2026-09-26`);
    assert.doesNotMatch(JSON.stringify(result), /\d+ (?:words|lines)\b/, "no word or line counts anywhere in the output");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("harness health: skill smoke results count each failing skill; a file that is not the shape is an error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "harness-smoke-"));
  try {
    await writeFile(join(dataDir, SKILL_SMOKE_FILE), JSON.stringify({ results: [{ skill: "websearch", pass: true }, { skill: "aside-browser", pass: false, detail: "screenshot timed out" },
      { skill: "why", pass: false }] }));
    const result = await measureHarness({ roots: [], views: async () => [], dataDir, now: NOW, ...noCache });
    assert.equal(result.metrics.skill_smoke_failures, 2);
    assert.deepEqual(result.flagged!.filter(slice => slice.kind === "skill_smoke_failures").map(slice => slice.excerpt),
      ["aside-browser failed its smoke check: screenshot timed out", "why failed its smoke check"]);
    await writeFile(join(dataDir, SKILL_SMOKE_FILE), JSON.stringify({ results: [{ skill: "why", pass: "yes" }] }));
    await assert.rejects(measureHarness({ roots: [], views: async () => [], dataDir, now: NOW, ...noCache }), /skill-smoke\.json: expected \{ results: \[\{ skill, pass, detail\? \}\] \}/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("harness health: overlap ignores stop words and empty descriptions", () => {
  const skill = (id: string, about: string) => ({ id, description: about }) as Skill;
  assert.deepEqual(overlaps([skill("a", "When using the skill for this repo"), skill("b", "When using the skill for this repo"), skill("c", "")]), []);
  assert.equal(overlaps([skill("a", "convex schema tables"), skill("b", "convex schema queries")])[0]!.score, 0.5);
});

test("Skills and harness duty file parses, measures outcomes, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "harness-health.duty.json"), "utf8")), "d", NOW);
  assert.equal(duty.name, "Skills and harness");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "04:00" });
  assert.equal(duty.boardGoal, "p215");
  const dataDir = await mkdtemp(join(tmpdir(), "harness-keys-"));
  try {
    const written = Object.keys((await measureHarness({ roots: [], views: async () => [], dataDir, now: NOW, ...noCache })).metrics);
    assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), [...written].sort());
  } finally { await rm(dataDir, { recursive: true, force: true }); }
  assert.doesNotMatch(duty.goal + duty.onMiss, /\b\d+ (?:words|lines)\b|words and lines/, "no word or line targets (owner 10-10, c39)");
  assert.match(duty.onMiss, /never trim a skill for its size/);
});

const MIN = 60_000;
/** A call `ago` before NOW whose prompt is `read` cache reads, `write` cache writes and 10 fresh input tokens. */
const call = (id: string, ago: number, read: number, write: number, before: string[] = [], model = "claude-opus-5-5"): Call =>
  ({ id, endedAt: NOW - ago, startedAt: NOW - ago - 10_000, provider: "anthropic", model, input: 10, output: 100, cacheRead: read, cacheWrite: write, before });
/** `count` calls one minute apart ending `ago` before NOW, each reading a 100k warm prompt and writing 1k. */
const steady = (prefix: string, count: number, ago: number) => Array.from({ length: count }, (_, at) => call(`${prefix}${at}`, ago + (count - at) * MIN, 100_000, 1_000));

test("cache share: read over input plus read plus write per window; fork copies count once; error calls and caching-free providers are left out", () => {
  const warm: SessionCalls = { id: "s1", title: "warm chat", calls: steady("w", 30, 0) };
  const fork: SessionCalls = { id: "s2", title: "fork", calls: [...warm.calls.slice(0, 5),
    { ...call("err", MIN, 0, 0), input: 0, output: 0 }, { ...call("plain", MIN, 0, 0), provider: "other", input: 50_000 }] };
  const { metrics, flagged } = measureCache([warm, fork], NOW, TARGETS);
  const want = Math.round(1000 * 100_000 / (100_000 + 1_000 + 10)) / 10;
  assert.deepEqual(metrics, { cache_read_ratio_1h: want, cache_read_ratio_24h: want });
  assert.deepEqual(flagged, []);
});

test("cache share: a window under MIN_CALLS calls is no data, reads 100 and is flagged as no data, never a miss", () => {
  const { metrics, flagged } = measureCache([{ id: "s", title: "quiet", calls: [call("a", 2 * MIN, 0, 900_000), call("b", MIN, 0, 900_000)] }], NOW, TARGETS);
  assert.deepEqual(metrics, { cache_read_ratio_1h: 100, cache_read_ratio_24h: 100 });
  assert.deepEqual(flagged.map(slice => slice.excerpt), [`no data: 2 calls in the window, under ${MIN_CALLS}, so it reads 100`,
    `no data: 2 calls in the window, under ${MIN_CALLS}, so it reads 100`]);
});

test("cache share: a drop names the session with the most warm-break cache writes and the entry right before each break", () => {
  const broken: SessionCalls = { id: "s-broken", title: "Crawler VP", calls: [
    ...steady("b", 20, 30 * MIN),
    call("break1", 29 * MIN, 0, 101_000, ["agent_message"]),
    call("break2", 28 * MIN, 0, 102_000, ["harness_digest", "agent_message"]),
    call("cold", 2 * MIN, 0, 103_000, ["user"]),
    call("other-model", MIN, 0, 104_000, ["model_change"], "gpt-6.1-sol"),
  ] };
  const fine: SessionCalls = { id: "s-fine", title: "fine", calls: steady("f", 20, 0) };
  const { metrics, flagged } = measureCache([broken, fine], NOW, TARGETS);
  assert.ok(metrics.cache_read_ratio_1h < 90, `share ${metrics.cache_read_ratio_1h}`);
  const lines = flagged.filter(slice => slice.kind === "cache_read_ratio_1h").map(slice => slice.excerpt);
  assert.deepEqual(lines, [`${metrics.cache_read_ratio_1h}% < 90% over 44 calls; Crawler VP (s-broken, claude-opus-5-5): 2 warm breaks wrote 0.2M cache tokens; ` +
    "right before: agent_message x2"], "the call after 27 idle minutes and the model switch are not warm breaks");
});

test("cache share: a transcript gives its calls since the cutoff with the entries the model saw before each, and its chat title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cache-ratio-"));
  try {
    const at = (ago: number) => new Date(NOW - ago).toISOString();
    const assistant = (id: string, ago: number, cacheWrite: number) => ({ type: "message", id, timestamp: at(ago),
      message: { role: "assistant", model: "claude-opus-5-5", provider: "anthropic", responseId: `r-${id}`, timestamp: NOW - ago - 5_000,
        usage: { input: 3, output: 40, cacheRead: 1_000, cacheWrite } } });
    const path = join(dir, "s.jsonl");
    await writeFile(path, [
      { type: "session", id: "s-1", cwd: "/x" }, { type: "session_info", name: "Crawler VP" },
      assistant("old", 2 * DAY, 5), { type: "message", message: { role: "user", content: [] } }, assistant("a", 3 * MIN, 0),
      { type: "message", message: { role: "toolResult", content: [] } }, { type: "git_state" },
      { type: "custom_message", customType: "harness_digest" }, { type: "custom", customType: "chat_correction_checkpoint" }, { type: "compaction" },
      assistant("b", 2 * MIN, 900),
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const session = await readTranscript(path, NOW - DAY);
    assert.equal(session!.title, "Crawler VP");
    assert.deepEqual(session!.calls.map(({ id, before, cacheWrite, startedAt }) => ({ id, before, cacheWrite, startedAt })), [
      { id: "r-a", before: ["user"], cacheWrite: 0, startedAt: NOW - 3 * MIN - 5_000 },
      { id: "r-b", before: ["harness_digest", "chat_correction_checkpoint", "compaction"], cacheWrite: 900, startedAt: NOW - 2 * MIN - 5_000 },
    ]);
    await writeFile(path, JSON.stringify({ type: "message" }) + "\n");
    assert.equal(await readTranscript(path, 0), null, "a file that does not open with a session header is no transcript");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
