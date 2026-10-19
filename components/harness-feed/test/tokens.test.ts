import assert from "node:assert/strict";
import { appendFile, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promName, type Context, type Sample } from "../otlp.ts";
import { copyRows, parseLogLine, psSeconds, read, readLog } from "../readers/tokens.ts";

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
      { sessionId: "b", parentSessionId: "a", usage: { inputTokens: 1, outputTokens: 2, cost: 0.25 }, sessionActions: [{ kind: "x" }] },
      { id: "no session id" },
    ];
    await writeFile(file, JSON.stringify({ version: 1, fullAt: 1, rows }));
    assert.deepEqual(await copyRows(file), [
      { id: "a", parent: null, name: "say \"}{][\\", input: 5, output: 6, cost: 1.5 },
      { id: "b", parent: "a", name: null, input: 1, output: 2, cost: 0.25 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
