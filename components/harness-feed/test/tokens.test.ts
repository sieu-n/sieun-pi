import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promName, type Context, type Sample } from "../otlp.ts";
import { copyIndex } from "../readers/session-copy.ts";
import { captureKinds, emptyTail, estimateMessage, firstPrompt, firstUsage, foldLine, messageKinds, parseLogLine, psSeconds, read, readLog, readTail,
  secondsSinceKstMidnight, skillTokens, summaryQueries, systemKinds, toolTokens } from "../readers/tokens.ts";

const home = join(import.meta.dirname, "fixtures/tokens/home");
const at = (text: string) => Date.parse(text);
const context = (chatHost: boolean, now = at("2026-10-19T17:00:00Z")): Context => ({ home, host: "us-metal02", platform: "linux", now, chatHost, state: new Map() });
const find = (samples: Sample[], name: string, labels: Record<string, string> = {}) =>
  samples.filter(s => s.name === name && Object.entries(labels).every(([key, value]) => s.labels?.[key] === value));
const value = (samples: Sample[], name: string, labels: Record<string, string> = {}) => {
  const found = find(samples, name, labels);
  assert.equal(found.length, 1, `${name} ${JSON.stringify(labels)}`);
  return found[0]!.value;
};

test("log lines: start, both failure kinds and the handoff; anything else is skipped", () => {
  assert.deepEqual(parseLogLine("2026-10-19T16:22:07Z started as usage-feed-x-2; 12 transcripts"), { at: at("2026-10-19T16:22:07Z"), started: true, error: null });
  assert.equal(parseLogLine("2026-10-19T16:51:10Z export failed: <urlopen error [Errno 111] Connection refused>")?.error, "export_failed");
  assert.equal(parseLogLine("2026-10-19T16:51:10Z handoff check failed: boom")?.error, "handoff_check_failed");
  assert.equal(parseLogLine("2026-10-19T16:51:10Z Prime's exporter writes prime_agent_calls_total for box mbp; the feed stops")?.error, "handed_off");
  assert.equal(parseLogLine("handed off already: 2026-10-19T16:51:10Z ..."), null);
  assert.equal(parseLogLine("Traceback (most recent call last):"), null);
});

test("ps TIME in seconds", () => {
  assert.equal(psSeconds("2:05.22"), 125.22);
  assert.equal(psSeconds("1:02:05.5"), 3725.5);
});

test("usage-feed health: the last start, errors in the last 30 min only, the release", async () => {
  const samples = await read(context(false));
  assert.equal(value(samples, "harness.tokens.usage_feed_start_time"), at("2026-10-19T16:22:07Z") / 1000);
  assert.equal(value(samples, "harness.tokens.usage_feed_log_errors", { kind: "export_failed" }), 1);
  assert.equal(value(samples, "harness.tokens.usage_feed_log_errors", { kind: "handoff_check_failed" }), 1);
  assert.equal(value(samples, "harness.tokens.usage_feed_log_errors", { kind: "handed_off" }), 0);
  assert.equal(value(samples, "harness.tokens.usage_feed_handed_off"), 0);
  assert.equal(value(samples, "harness.tokens.usage_feed_release", { sha: "7c1f61b" }), at("2026-10-19T16:21:47Z") / 1000);
  assert.equal(find(samples, "harness.tokens.usage_feed_up").length, 1);
  assert.equal(promName(find(samples, "harness.tokens.usage_feed_start_time")[0]!), "harness_tokens_usage_feed_start_time_seconds");
});

test("off the chat host the reader sends no chat costs", async () => {
  const samples = await read(context(false));
  assert.equal(find(samples, "harness.tokens.chat_cost_usd").length, 0);
});

test("chat costs: the thread row, its subagents and its jobs, from both boxes' copies; this box's copy wins a duplicate", async () => {
  const samples = await read(context(true));
  const cost = (chat: string, part: string) => value(samples, "harness.tokens.chat_cost_usd", { chat, part });
  assert.equal(cost("Alpha", "thread"), 10);
  assert.equal(cost("Alpha", "subagents"), 5);
  // job-1 4 + its child 1, "named job" by session name 0.5, job-old by its old chat name 0.25; job-missing has no row.
  assert.equal(cost("Alpha", "jobs"), 5.75);
  assert.equal(cost("Mac chat", "thread"), 7);
  assert.equal(cost("Mac chat", "jobs"), 1.5);
  assert.equal(find(samples, "harness.tokens.chat_cost_usd", { chat: "Mac chat" })[0]!.labels!.runs_on, "mac");
  assert.equal(find(samples, "harness.tokens.chat_cost_usd", { chat: "Alpha" })[0]!.labels!.runs_on, "us-metal02");
  assert.equal(value(samples, "harness.tokens.chat_tokens", { chat: "Alpha", part: "thread", kind: "input" }), 5000);
  assert.equal(value(samples, "harness.tokens.chat_tokens", { chat: "Alpha", part: "thread", kind: "output" }), 50);
  assert.equal(find(samples, "harness.tokens.chat_cost_usd", { chat: "chat-gon" }).length, 0);
});

test("the log is read from the saved offset, and a shorter log starts again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-log-"));
  try {
    const file = join(dir, "feed.log");
    await copyFile(join(home, ".local/share/usage-feed/feed.log"), file);
    const first = await readLog(file, { offset: 0, startedAt: null, errors: [] });
    assert.equal(first.errors.length, 3);
    await appendFile(file, "2026-10-19T16:59:00Z export failed: x\n2026-10-19T16:59:30Z exp");
    const second = await readLog(file, first);
    assert.equal(second.errors.length, 4);
    assert.equal(second.offset, first.offset + "2026-10-19T16:59:00Z export failed: x\n".length);
    const again = await readLog(file, { ...second, offset: 1e9 });
    assert.equal(again.startedAt, at("2026-10-19T16:22:07Z"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("copy rows: a row longer than a chunk, braces and escaped quotes in strings, and nested objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-copy-"));
  try {
    const file = join(dir, "copy.json");
    const rows = [
      { sessionId: "a", sessionName: "say \"}{][\\", firstMessage: "x{".repeat(700_000), model: { cost: { input: 4 } }, usage: { inputTokens: 5, outputTokens: 6, cost: 1.5 } },
      { sessionId: "b", parentSessionId: "a", model: { id: "m1", contextWindow: 200000 }, usage: { inputTokens: 1, outputTokens: 2, cost: 0.25 }, sessionActions: [{ kind: "x" }] },
      { id: "no session id" },
    ];
    await writeFile(file, JSON.stringify({ version: 1, fullAt: 1, rows }));
    const pick = ({ id, parent, name, input, output, cost, file, window, model }: Awaited<ReturnType<typeof copyIndex>>[number]) => ({ id, parent, name, input, output, cost, file, window, model });
    assert.deepEqual((await copyIndex(file)).map(pick), [
      { id: "a", parent: null, name: "say \"}{][\\", input: 5, output: 6, cost: 1.5, file: null, window: 0, model: null },
      { id: "b", parent: "a", name: null, input: 1, output: 2, cost: 0.25, file: null, window: 200000, model: "m1" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** One session file line, as Prime writes it. */
const line = (entry: object) => JSON.stringify(entry) + "\n";
const reply = (usage: object, extra: object = {}) => line({ type: "message", timestamp: "2026-10-19T16:00:00Z", message: { role: "assistant", provider: "anthropic", model: "m1", timestamp: at("2026-10-19T16:00:00Z"), content: [{ type: "text", text: "ok" }], usage, ...extra } });

test("context: the newest reply's usage plus chars / 4 of what came after it; a compaction stops the count until the next reply", async () => {
  const tail = emptyTail();
  foldLine(tail, reply({ input: 100, output: 20, cacheRead: 880, cacheWrite: 0 }).trim());
  foldLine(tail, line({ type: "message", message: { role: "user", content: "x".repeat(40) } }).trim());
  foldLine(tail, line({ type: "custom_message", content: "y".repeat(8) }).trim());
  assert.equal(tail.usageTokens, 1000);
  assert.equal(tail.trailingTokens, 12);
  assert.equal(tail.measured, true);
  assert.equal(tail.promptTokens, 980);
  assert.equal(tail.model, "m1");
  foldLine(tail, reply({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, { stopReason: "aborted", content: [{ type: "text", text: "abcd" }] }).trim());
  assert.equal(tail.usageTokens, 1000, "an aborted reply only adds its text");
  assert.equal(tail.trailingTokens, 13);
  foldLine(tail, line({ type: "compaction", timestamp: "2026-10-19T16:30:00Z", tokensBefore: 480_000, summary: "s" }).trim());
  assert.equal(tail.measured, false);
  assert.deepEqual(tail.compactions, [{ at: at("2026-10-19T16:30:00Z"), tokensBefore: 480_000 }]);
  assert.equal(estimateMessage("bashExecution", { command: "ls", output: "abcdef" }), 2);
});

test("readTail: reads only what the file gained, and a first read of a big file starts at a line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-tail-"));
  try {
    const file = join(dir, "s.jsonl");
    await writeFile(file, reply({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }));
    const first = await readTail(file, emptyTail(), at("2026-10-19T17:00:00Z"));
    assert.equal(first.usageTokens, 10);
    await appendFile(file, reply({ input: 30, output: 0, cacheRead: 0, cacheWrite: 0 }) + '{"type":"message","mess');
    const second = await readTail(file, first, at("2026-10-19T17:00:00Z"));
    assert.equal(second.usageTokens, 30);
    assert.equal(second.messages.length, 2);
    assert.equal(second.offset, (await readFile(file, "utf8")).lastIndexOf("\n") + 1, "a half-written line waits for the next round");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SKILL = (name: string, location: string) => `  <skill>\n    <name>${name}</name>\n    <type>markdown</type>\n    <description>d</description>\n    <location>${location}</location>\n  </skill>`;
const SYSTEM = ["You are base.", "# Delegating to sub-agents\n\nspawn", "# Additional Guidance\n\n- brief", "# Project Context\n\nagents",
  "\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n" +
  [SKILL("unslop", "/h/.prime/agent/skills/unslop/SKILL.md"), SKILL("edit", "/h/.local/share/prime-agent/releases/r1/skills/edit/SKILL.md"), SKILL("repo-skill", "/repo/.agents/skills/x/SKILL.md")].join("\n") +
  "\n</available_skills>"].join("\n\n");

test("prompt parts: system marks, skill blocks by group, and the hook and harness texts among the messages", async () => {
  const kinds = systemKinds(SYSTEM);
  assert.deepEqual(kinds.skillBlocks.map(block => block.name), ["unslop", "edit", "repo-skill"]);
  assert.ok(kinds.system > 0 && kinds.instructions > 0 && kinds.skills > 0);
  const count = skillTokens("/h", kinds.skillBlocks);
  assert.deepEqual(Object.keys(count.groups), ["global", "built-in", "repo", "header"]);
  assert.deepEqual(count.skills.map(skill => skill.group), ["global", "built-in", "repo"]);
  assert.equal(count.groups.header, 146);
  assert.equal(count.total, count.skills.reduce((sum, skill) => sum + skill.tokens, 146));
  assert.equal(count.skills[0]!.tokens, Math.round(SKILL("unslop", "/h/.prime/agent/skills/unslop/SKILL.md").length / 2.45));
  const messages = JSON.stringify({ messages: [
    { role: "user", content: [{ type: "text", text: "[message id: abc; reply_to it]" }, { type: "text", text: "owner words" }] },
    { role: "user", content: "[corrections] " + "c".repeat(26) },
    { role: "user", content: [{ type: "text", text: "[harness-digest]\n\nmem\n\n[compaction-summary]\n" + "z".repeat(400) }] },
    { role: "user", content: [{ type: "text", text: "[auto-refinement] saved" }] },
    { role: "user", content: [{ type: "tool_result", content: "{\"text\":\"[corrections] nested\"}" }] },
  ] });
  assert.deepEqual(messageKinds(messages), { instructions: Math.ceil(30 / 4) + Math.ceil(40 / 4), harness: Math.ceil("[harness-digest]\n\nmem".length / 4) + Math.ceil(23 / 4) });
});

test("captureKinds: an Anthropic capture's identity line, system, tools and message kinds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-capture-"));
  try {
    const file = join(dir, "c.json");
    const tools = [{ name: "ipython", description: "Run code.", input_schema: { type: "object" } }];
    await writeFile(file, JSON.stringify({ capturedAt: 1, payload: { model: "m1", messages: [{ role: "user", content: [{ type: "text", text: "[message id: q]" }] }],
      system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: SYSTEM }], tools } }));
    const kinds = await captureKinds(file);
    const base = systemKinds(SYSTEM);
    assert.equal(kinds!.system, base.system + Math.ceil("You are Claude Code.".length / 4));
    assert.equal(kinds!.instructions, base.instructions + Math.ceil("[message id: q]".length / 4));
    assert.equal(kinds!.tools, toolTokens(tools));
    assert.equal(kinds!.skillBlocks.length, 3);
    assert.equal(await captureKinds(join(dir, "none.json")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("firstPrompt: the newest root session in the repo with a first reply; children, other folders and failed replies are skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokens-first-"));
  try {
    const session = (cwd: string, parent?: string) => line({ type: "session", cwd, ...parent ? { parentSession: parent } : {} });
    const usage = (input: number) => line({ type: "message", message: { role: "assistant", timestamp: 5, usage: { input, cacheRead: 10, cacheWrite: 0 } } });
    await writeFile(join(dir, "01-old.jsonl"), session("/repo") + usage(90));
    await writeFile(join(dir, "02-other.jsonl"), session("/elsewhere") + usage(1));
    await writeFile(join(dir, "03-child.jsonl"), session("/repo", "p") + usage(1));
    await writeFile(join(dir, "04-failed.jsonl"), session("/repo") + usage(0).replace('"cacheRead":10', '"cacheRead":0'));
    await writeFile(join(dir, "05-new.jsonl"), session("/repo") + line({ type: "message", message: { role: "user", content: "hi" } }));
    const state = new Map<string, unknown>();
    assert.deepEqual(await firstPrompt(state, dir, "/repo"), { sessionId: "01-old", tokens: 100, at: 5 });
    assert.equal(await firstUsage(join(dir, "05-new.jsonl"), "/repo"), "wait");
    await appendFile(join(dir, "05-new.jsonl"), usage(40));
    assert.deepEqual(await firstPrompt(state, dir, "/repo"), { sessionId: "05-new", tokens: 50, at: 5 }, "a waiting file is read again once it grew");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A chat host home with one chat, its session file and capture, a repo session, and a Grafana that answers from `answer`. */
async function chatHome(answer: (query: string) => { status: number; result: unknown }) {
  const dir = await mkdtemp(join(tmpdir(), "tokens-home-"));
  const server = createServer((req, res) => {
    const query = new URL(req.url ?? "", "http://x").searchParams.get("query") ?? "";
    const { status, result } = answer(query);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { status: "success", data: { resultType: "vector", result } } : { status: "error" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const chatDir = join(dir, ".prime/agent/browser-chat");
  const sessions = join(dir, ".prime/agent/sessions");
  await mkdir(join(chatDir, "prompts"), { recursive: true });
  await mkdir(sessions, { recursive: true });
  const sessionFile = join(dir, "chat.jsonl");
  await writeFile(sessionFile, reply({ input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0 }) + reply({ input: 1000, output: 100, cacheRead: 98_900, cacheWrite: 0 })
    + line({ type: "compaction", timestamp: "2026-10-19T16:50:00Z", tokensBefore: 470_000 }) + line({ type: "message", message: { role: "user", content: "after" } }));
  await writeFile(join(chatDir, "chats.json"), JSON.stringify({ ids: ["chat-a"] }));
  await writeFile(join(chatDir, "chat-jobs.json"), JSON.stringify({ jobs: {} }));
  await writeFile(join(chatDir, "session-copy.json"), JSON.stringify({ version: 1, fullAt: 1, rows: [
    { sessionId: "chat-a", sessionName: "Alpha", sessionFile, model: { id: "m1", contextWindow: 200_000 }, usage: { inputTokens: 1, outputTokens: 1, cost: 1 } },
    { sessionId: "job-x", sessionName: "worker", parentSessionId: "chat-a", usage: {} },
  ] }));
  await writeFile(join(chatDir, "grafana-alerts.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: "t" }));
  const payload = { messages: [{ role: "user", content: [{ type: "text", text: "[corrections] cc" }] }], system: [{ type: "text", text: "Hi." }, { type: "text", text: SYSTEM }], tools: [] };
  await writeFile(join(chatDir, "prompts/chat-a.json"), JSON.stringify({ payload }));
  await writeFile(join(chatDir, "prompts/repo-1.json"), JSON.stringify({ payload }));
  await writeFile(join(sessions, "repo-1.jsonl"), line({ type: "session", cwd: join(dir, "repo") }) + line({ type: "message", message: { role: "assistant", timestamp: 1, usage: { input: 3, cacheRead: 20_000, cacheWrite: 0 } } }));
  process.env.HARNESS_REPO = join(dir, "repo");
  const ctx: Context = { home: dir, host: "us-metal02", platform: "linux", now: at("2026-10-19T17:00:00Z"), chatHost: true, state: new Map() };
  return { ctx, close: async () => { server.close(); delete process.env.HARNESS_REPO; await rm(dir, { recursive: true, force: true }); } };
}

test("chat host: usage query health, Agents card rates, context ring, cache, compaction, prompt parts and the Tools page skills", async () => {
  const { ctx, close } = await chatHome(query => query.includes("prime_agent_session_output_tokens_total")
    ? { status: 200, result: [{ metric: { session: "job-x" }, value: [1, "80.04"] }, { metric: { session: "chat-a" }, value: [1, "95.5"] }, { metric: { session: "zz-unknown-session" }, value: [1, "10"] }] }
    : { status: 200, result: [] });
  try {
    const samples = await read(ctx);
    assert.equal(value(samples, "harness.tokens.app_usage_query_ok"), 1);
    assert.equal(value(samples, "harness.tokens.app_usage_query_failed"), 0);
    assert.equal(find(samples, "harness.tokens.app_usage_query_status").length, 0);
    assert.equal(value(samples, "harness.tokens.live_agents"), 3);
    assert.deepEqual(find(samples, "harness.tokens.agent_output_tps").map(s => [s.labels!.rank, s.labels!.agent, s.labels!.chat, s.value]),
      [["1", "Alpha", "Alpha", 95.5], ["2", "worker", "Alpha", 80], ["3", "zz-unkno", "none", 10]]);
    assert.equal(find(samples, "harness.tokens.context_share", { chat: "Alpha" }).length, 0, "no ring after a compaction until the next reply");
    assert.equal(value(samples, "harness.tokens.compaction_tokens_before", { chat: "Alpha" }), 470_000);
    assert.equal(value(samples, "harness.tokens.compactions_24h", { chat: "Alpha" }), 1);
    assert.equal(value(samples, "harness.tokens.cache_hit", { chat: "Alpha", call: "last" }), 98_900 / 99_900);
    assert.equal(value(samples, "harness.tokens.cache_level", { chat: "Alpha" }), 0);
    assert.equal(value(samples, "harness.tokens.prompt_measured", { chat: "Alpha" }), 99_900);
    const parts = Object.fromEntries(find(samples, "harness.tokens.prompt_part", { chat: "Alpha" }).map(s => [s.labels!.part, s.value]));
    assert.equal(parts.instructions, systemKinds(SYSTEM).instructions + Math.ceil("[corrections] cc".length / 4));
    assert.equal(Object.values(parts).reduce((a, b) => a + b, 0), 99_900, "conversation is the measured prompt minus the other parts");
    assert.equal(value(samples, "harness.tokens.first_prompt"), 20_003);
    assert.equal(value(samples, "harness.tokens.skills_group", { group: "built-in" }), Math.round(SKILL("edit", "/h/.local/share/prime-agent/releases/r1/skills/edit/SKILL.md").length / 2.45));
    assert.equal(find(samples, "harness.tokens.skill").length, 3);
    assert.equal(value(samples, "harness.tokens.skills", { chat: "Alpha" }), find(samples, "harness.tokens.skills_group").reduce((sum, s) => sum + s.value, 0));
    await appendFile(join(ctx.home, "chat.jsonl"), reply({ input: 100, output: 50, cacheRead: 59_850, cacheWrite: 0 }));
    const later = await read({ ...ctx, now: ctx.now + 30_000 });
    assert.equal(value(later, "harness.tokens.context_share", { chat: "Alpha" }), 60_000 / 200_000);
  } finally {
    await close();
  }
});

test("chat host: a failing LGTM shows as a failed usage query with its status, and no agent rates", async () => {
  const { ctx, close } = await chatHome(() => ({ status: 500, result: null }));
  try {
    const samples = await read(ctx);
    assert.equal(value(samples, "harness.tokens.app_usage_query_ok"), 0);
    assert.equal(value(samples, "harness.tokens.app_usage_query_failed"), 6);
    assert.equal(value(samples, "harness.tokens.app_usage_query_status"), 500);
    assert.equal(find(samples, "harness.tokens.agent_output_tps").length, 0);
  } finally {
    await close();
  }
});

test("Cost today counts from the chat's KST midnight", () => {
  assert.equal(secondsSinceKstMidnight(at("2026-10-19T15:00:00Z")), 1);
  assert.equal(secondsSinceKstMidnight(at("2026-10-19T17:00:00Z")), 7200);
  assert.equal(summaryQueries(7200)[3]!.promql, 'sum(increase(prime_agent_cost_USD_total{job="prime-agent"}[7200s]))');
});
