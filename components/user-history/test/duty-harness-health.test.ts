import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { description, measureHarness, overlaps, READS_FILE, readSkills, type Skill, type SkillRoot, type View } from "../scripts/duties/harness-health.ts";
import { declaredScripts, namedPaths, SMOKE_SESSION, smokeSkills } from "../scripts/duties/skill-smoke.ts";
import { measureCache, MIN_CALLS, readTranscript, type Call, type SessionCalls } from "../scripts/duties/cache-ratio.ts";

const NOW = Date.parse("2026-10-10T04:00:00Z");
const DAY = 24 * 60 * 60_000;
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const skillMd = (name: string, about: string) => `---\nname: ${name}\ndescription: "${about}"\n---\n\n# ${name}\n`;
const chat = (id: string) => ({ id, name: `chat ${id}` });
const TARGETS = { cache_read_ratio_1h: 90, cache_read_ratio_24h: 94 };
/** No transcripts with model calls; in chat c the owner wrote the words of c1's repeat, and nothing else. No fixture skill is a Python skill. */
const stubs = { sessions: async () => [], cacheTargets: TARGETS, ownerTexts: async (id: string) => id === "c" ? ["ok, again, the same thing. fix it"] : [],
  transcripts: async () => [], smoke: { python: "/nonexistent/python" } };

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
    entry("c2", iso(3 * DAY), [{ at: iso(DAY), chat: chat("c"), words: "(my own note, no owner words) the same thing again" }]),
  ] }));
  return { dir, dataDir, roots: [{ name: "repo", dir: repo, views: "@code/.agents/skills/" }, { name: "prime", dir: prime }] };
}

test("harness health: frontmatter descriptions in one line, quoted, or folded", () => {
  assert.equal(description("---\nname: a\ndescription: plain words here\n---\n"), "plain words here");
  assert.equal(description("---\nname: a\ndescription: \"quoted: words\"\n---\n"), "quoted: words");
  assert.equal(description("---\nname: a\ndescription: >-\n  folded line one\n  line two\nmetadata: x\n---\n"), "folded line one line two");
  assert.equal(description("# no frontmatter\n"), "");
});

test("harness health: outcomes only; every skill passes its smoke check, repeat corrections in 7 days, skills read in 14 days, overlapping descriptions", async () => {
  const { dir, roots, dataDir } = await tree();
  try {
    const views: View[] = [
      { path: "@code/.agents/skills/apps/search/references/routes.md", ts: iso(2 * DAY) },
      { path: "@code/.agents/skills/apps/search-chat/SKILL.md", ts: iso(DAY) },
      { path: "@code/.agents/skills/apps/search-chat/SKILL.md", ts: iso(3 * DAY) },
    ];
    let askedSince = "";
    const result = await measureHarness({ roots, dataDir, now: NOW, views: async since => { askedSince = since; return views; }, ...stubs });
    assert.equal(askedSince, iso(14 * DAY));
    const byId = new Map(result.skills.map(skill => [skill.id, skill]));
    assert.deepEqual(result.skills.map(skill => skill.id), ["prime:why", "repo:apps/search", "repo:apps/search-chat", "repo:stack/stale"], "the symlinked repo skill counts once");
    assert.equal(byId.get("repo:apps/search-chat")!.lastRead, iso(DAY));
    assert.equal(byId.get("repo:stack/stale")!.lastRead, null);
    assert.equal(byId.get("prime:why")!.lastRead, undefined, "a root with no view events is untracked, not unread");
    assert.equal(byId.get("prime:why")!.dir.endsWith("/source/why"), true);

    assert.deepEqual(result.metrics, { skills_to_prune: 2, skill_smoke_failures: 0, unread_14d: 1, overlapping_pairs: 1, cache_read_ratio_1h: 100, cache_read_ratio_24h: 100,
      repeat_corrections_7d: 1 }, "no size counts; the unread skill and the overlapping pair are two skills to prune");
    const kinds = result.flagged!.map(slice => slice.kind);
    assert.deepEqual([...new Set(kinds)], ["cache_read_ratio_1h", "cache_read_ratio_24h", "repeat_corrections_7d", "unread_14d", "overlap", "untracked"]);
    assert.deepEqual(result.smoke.map(row => [row.skill, row.pass]), result.skills.map(skill => [skill.id, true]), "the smoke check ran on every skill, and each passed");
    const repeat = result.flagged!.find(slice => slice.kind === "repeat_corrections_7d")!;
    assert.equal(repeat.chat, "c");
    assert.equal(repeat.excerpt, "c1 \"rule c1\" (enforced by brief: brief bullet) given again in chat c: again, the same thing");
    assert.match(result.flagged!.find(slice => slice.kind === "overlap")!.excerpt, /repo:apps\/search and repo:apps\/search-chat share \d+% of description words: .*billing/);
    assert.equal(result.flagged!.find(slice => slice.kind === "unread_14d")!.excerpt, `repo:stack/stale (${byId.get("repo:stack/stale")!.dir}) has no view event since 2026-09-26`);
    assert.doesNotMatch(JSON.stringify(result), /\d+ (?:words|lines)\b/, "no word or line counts anywhere in the output");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const SH = (body: string) => `#!/bin/sh\n${body}\n`;
async function put(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  if (mode) await chmod(path, mode);
}
const pyproject = (name: string, script: string) => `[project]\nname = "${name}"\nversion = "1.0.0"\n\n[project.scripts]\n${script} = "rlm.skill:cli"\n\n[build-system]\nrequires = ["hatchling"]\n`;

test("skill smoke: a missing script path, a failing import, a missing CLI, a missing name and a failing repo read each fail; good skills pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-smoke-"));
  try {
    const prime = join(dir, "prime"), repo = join(dir, "repo"), bin = join(dir, "venv/bin");
    await put(join(prime, "good/SKILL.md"), `${skillMd("good", "Use for good things.")}\nRead [the guide](references/guide.md), then run \`scripts/run.sh\`.\nShow a picture with \`![alt](path)\`; see [snippet](snippet).\n\n\`\`\`md\n[not a file](nowhere/at-all.md)\n\`\`\`\n`);
    await put(join(prime, "good/references/guide.md"), "Run `../scripts/run.sh` from here.\n");
    await put(join(prime, "good/scripts/run.sh"), SH("exit 0"), 0o755);
    await put(join(prime, "lost/SKILL.md"), `${skillMd("lost", "Use for lost things.")}\nRun \`scripts/run.sh\` and read [notes](references/notes.md).\n`);
    await put(join(prime, "nameless/SKILL.md"), "---\ndescription: \"Use for things with no name.\"\n---\n");
    await put(join(prime, "blank/SKILL.md"), "---\nname: blank\n---\n");
    await put(join(prime, "good-tool/SKILL.md"), skillMd("good-tool", "Use for a Python tool that imports."));
    await put(join(prime, "good-tool/pyproject.toml"), pyproject("good-tool", "good_tool"));
    await put(join(prime, "good-tool/src/good_tool/__init__.py"), "def run():\n    return 1\n");
    await put(join(prime, "broken-tool/SKILL.md"), skillMd("broken-tool", "Use for a Python tool that does not import."));
    await put(join(prime, "broken-tool/pyproject.toml"), pyproject("broken-tool", "broken_tool"));
    await put(join(prime, "broken-tool/src/broken_tool/__init__.py"), "raise ImportError('httpx2 is not installed')\n");
    await put(join(bin, "python"), SH(`PYTHONPATH="${join(prime, "good-tool/src")}:${join(prime, "broken-tool/src")}" exec python3 "$@"`), 0o755);
    await put(join(bin, "good_tool"), SH(`[ "$1" = --help ] && exit 0; exit 2`), 0o755);
    await put(join(repo, ".agents/skills/apps/read/SKILL.md"), skillMd("read", "Use for a repo skill that reads."));
    await put(join(repo, ".agents/skills/apps/unread/SKILL.md"), skillMd("unread", "Use for a repo skill the reader refuses."));
    await put(join(repo, "scripts/skills/read-skill.mjs"), `const id = process.argv[2];
if (process.env.RLM_SESSION_DIR !== "/${SMOKE_SESSION}") process.exit(3);
if (id.endsWith("unread")) { console.error("[read-skill] Skill not found: " + id); process.exit(1); }
process.stdout.write("# " + id);
`);
    const roots: SkillRoot[] = [{ name: "repo", dir: join(repo, ".agents/skills"), views: "@code/.agents/skills/", repo }, { name: "prime", dir: prime }];
    const results = Object.fromEntries((await smokeSkills(await readSkills(roots), roots, { python: join(bin, "python") })).map(row => [row.skill, row.detail ?? "pass"]));
    assert.deepEqual(results, {
      "prime:blank": "Prime does not load it: description is required",
      "prime:broken-tool": "import broken_tool fails in the kernel venv: ImportError: httpx2 is not installed; broken_tool --help exits without a code: " +
        `spawn ${join(bin, "broken_tool")} ENOENT`,
      "prime:good": "pass",
      "prime:good-tool": "pass",
      "prime:lost": "missing path: SKILL.md names references/notes.md; missing path: SKILL.md names scripts/run.sh",
      "prime:nameless": "the frontmatter has no name",
      "repo:apps/read": "pass",
      "repo:apps/unread": "node scripts/skills/read-skill.mjs .agents/skills/apps/unread exits 1: [read-skill] Skill not found: .agents/skills/apps/unread",
    });
    const measured = await measureHarness({ roots, views: async () => [], dataDir: join(dir, "data"), now: NOW, ...stubs, smoke: { python: join(bin, "python") } });
    assert.equal(measured.metrics.skill_smoke_failures, 5);
    assert.deepEqual(measured.flagged!.filter(slice => slice.kind === "skill_smoke_failures").map(slice => slice.excerpt.split(" failed")[0]),
      ["prime:blank", "prime:broken-tool", "prime:lost", "prime:nameless", "repo:apps/unread"]);
    assert.match(measured.flagged!.find(slice => slice.excerpt.startsWith("prime:lost"))!.excerpt, /^prime:lost failed its smoke check: missing path: SKILL\.md names references\/notes\.md/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("skill smoke: the paths a markdown file names, and the CLIs a pyproject.toml declares", () => {
  assert.deepEqual(namedPaths("See [a](references/a.md#top), `scripts/b.sh`, `apps/x/y.ts:12`, `~/.prime/c.md`, `/abs/d.md`, [e](https://x.dev/e.md), " +
    "`<dir>/f.md`, `word`, `a/b`, [slug](snippet), `![g](path)`.\n```\n[h](h.md)\n```\n"), [
    { path: "references/a.md", strict: true }, { path: "scripts/b.sh", strict: true }, { path: "apps/x/y.ts", strict: false },
  ]);
  assert.deepEqual(declaredScripts("[project]\nname = \"w\"\n\n[project.scripts]\nwebsearch = \"rlm.skill:cli\"\n\"other-cli\" = \"m:main\"\n\n[build-system]\nx = 1\n"), ["websearch", "other-cli"]);
  assert.deepEqual(declaredScripts("[project]\nname = \"board\"\n"), []);
});

test("harness health: Prime skills count as read from tool calls and /skill loads in transcripts, and a later run reads only the appended bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-reads-"));
  try {
    const prime = join(dir, "prime"), dataDir = join(dir, "data"), log = join(dir, "s.jsonl");
    await put(join(prime, "why/SKILL.md"), skillMd("why", "Use for design rationale questions."));
    await put(join(prime, "unused/SKILL.md"), skillMd("unused", "Use for nothing anyone asks about."));
    await put(join(prime, "board/SKILL.md"), skillMd("board", "Use to read the chat board from Python."));
    await put(join(prime, "board/pyproject.toml"), pyproject("board", "board"));
    await put(join(prime, "board/src/board/__init__.py"), "def wake(**_):\n    return 1\n");
    await mkdir(dataDir, { recursive: true });
    const line = (ago: number, role: string, content: unknown[]) => JSON.stringify({ type: "message", timestamp: iso(ago), message: { role, content } });
    const tool = (code: string) => ({ type: "toolCall", id: "t", name: "ipython", arguments: { code } });
    await writeFile(log, [
      JSON.stringify({ type: "session", id: "s" }),
      line(20 * DAY, "assistant", [tool("open('/h/.prime/agent/skills/unused/SKILL.md').read()")]),
      line(3 * DAY, "user", [{ type: "text", text: "Read /h/.prime/agent/skills/unused/SKILL.md first." }]),
      line(3 * DAY, "assistant", [{ type: "text", text: "I will read skills/unused/SKILL.md" }, tool("x = 1\nboard.wake(at='10:00')")]),
      line(2 * DAY, "assistant", [tool("open('/h/sieun-pi/skills/why/SKILL.md').read(); ls skills/unused-extra/")]),
      line(2 * DAY, "toolResult", [{ type: "text", text: "see skills/unused/SKILL.md" }]),
      line(DAY, "user", [{ type: "text", text: '<skill name="why" location="/h/.prime/agent/skills/why/SKILL.md">' }]),
    ].join("\n") + "\n");
    await put(join(dir, "venv/bin/python"), SH("exit 0"), 0o755);
    await put(join(dir, "venv/bin/board"), SH("exit 0"), 0o755);
    const roots: SkillRoot[] = [{ name: "prime", dir: prime, transcripts: true }];
    let asked = 0;
    const measure = () => measureHarness({ roots, views: async () => [], dataDir, now: NOW, ...stubs, smoke: { python: join(dir, "venv/bin/python") },
      transcripts: async since => { asked = since; return [log]; } });
    const first = await measure();
    assert.equal(asked, NOW - 14 * DAY);
    assert.deepEqual(first.skills.map(skill => [skill.id, skill.lastRead]), [["prime:board", iso(3 * DAY)], ["prime:unused", null], ["prime:why", iso(DAY)]],
      "a brief, a reply text, a tool result, a longer name and a read 20 days ago are no reads");
    assert.equal(first.metrics.skills_to_prune, 1);
    assert.equal(first.flagged!.find(slice => slice.kind === "unread_14d")!.excerpt,
      `prime:unused (${first.skills[1]!.dir}) has no agent read in a Prime transcript since 2026-09-26`);
    assert.equal(first.flagged!.some(slice => slice.kind === "untracked"), false);
    const state = JSON.parse(await readFile(join(dataDir, READS_FILE), "utf8"));
    assert.equal(state.offsets[log], (await readFile(log)).length, "the next run starts at the end of what this run read");

    await writeFile(log, (await readFile(log, "utf8")).replace("skills/unused-extra/", "skills/unused/ xxxxx") + line(DAY / 2, "assistant", [tool("cat skills/unused/SKILL.md")]) + "\n");
    const second = await measure();
    assert.deepEqual(second.skills.map(skill => [skill.id, skill.lastRead]), [["prime:board", iso(3 * DAY)], ["prime:unused", iso(DAY / 2)], ["prime:why", iso(DAY)]],
      "only the appended line is read: the earlier line edited in place is not read again");
    assert.equal(second.metrics.skills_to_prune, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("harness health: overlap ignores stop words and empty descriptions", () => {
  const skill = (id: string, about: string) => ({ id, description: about }) as Skill;
  assert.deepEqual(overlaps([skill("a", "When using the skill for this repo"), skill("b", "When using the skill for this repo"), skill("c", "")]), []);
  assert.equal(overlaps([skill("a", "convex schema tables"), skill("b", "convex schema queries")])[0]!.score, 0.5);
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

test("cache share: the first call after failed calls is a cold start, not a warm break, and the failed calls are counted", () => {
  // 10-18 04:45 KST: the pool's token hook gave no token for 35 hours, so each chat's last call before its cold start was a failed call with no tokens.
  const failedCall = (id: string, ago: number) => ({ ...call(id, ago, 0, 0), input: 0, output: 0 });
  const outage: SessionCalls = { id: "s-out", title: "ops train", calls: [
    call("before-outage", 30 * 60 * MIN, 400_000, 1_000), failedCall("f1", 4 * MIN), failedCall("f2", 3 * MIN), call("cold", 2 * MIN, 514, 391_000),
  ] };
  const { metrics, flagged } = measureCache([outage, { id: "s-fine", title: "fine", calls: steady("f", 20, 0) }], NOW, TARGETS);
  assert.ok(metrics.cache_read_ratio_1h < 90, `share ${metrics.cache_read_ratio_1h}`);
  assert.deepEqual(flagged.filter(slice => slice.kind === "cache_read_ratio_1h").map(slice => slice.excerpt),
    [`${metrics.cache_read_ratio_1h}% < 90% over 21 calls (2 more failed with no tokens); no warm breaks: the drop comes from cold starts or calls after more than 5 minutes idle`]);
  const quiet = measureCache([{ id: "s", title: "down", calls: [failedCall("x", 2 * MIN), call("y", MIN, 0, 900_000)] }], NOW, TARGETS);
  assert.equal(quiet.flagged[0]!.excerpt, `no data: 1 calls in the window, under ${MIN_CALLS}, so it reads 100; 1 calls failed with no tokens`);
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
      assistant("b", 2 * MIN, 900), { type: "message", message: { role: "user", content: [] } },
      { ...assistant("fail", 90_000, 0), message: { ...assistant("fail", 90_000, 0).message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
      assistant("c", MIN, 800),
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const session = await readTranscript(path, NOW - DAY);
    assert.equal(session!.title, "Crawler VP");
    assert.deepEqual(session!.calls.map(({ id, before, cacheWrite, startedAt }) => ({ id, before, cacheWrite, startedAt })), [
      { id: "r-a", before: ["user"], cacheWrite: 0, startedAt: NOW - 3 * MIN - 5_000 },
      { id: "r-b", before: ["harness_digest", "chat_correction_checkpoint", "compaction"], cacheWrite: 900, startedAt: NOW - 2 * MIN - 5_000 },
      { id: "r-fail", before: ["user"], cacheWrite: 0, startedAt: NOW - 90_000 - 5_000 },
      { id: "r-c", before: ["user", "failed call"], cacheWrite: 800, startedAt: NOW - MIN - 5_000 },
    ], "a failed call passes the entries before it on to the next call");
    await writeFile(path, JSON.stringify({ type: "message" }) + "\n");
    assert.equal(await readTranscript(path, 0), null, "a file that does not open with a session header is no transcript");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
