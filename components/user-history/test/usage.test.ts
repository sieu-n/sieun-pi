import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { UsageCall } from "../src/shared/usage.ts";
import { Ingest } from "../src/usage/ingest.ts";
import { claudeCode, codex, piFormat, type ParserSpec } from "../src/usage/parsers.ts";
import { resolvePrice, toTable } from "../src/usage/prices.ts";
import { readAppended } from "../src/usage/reader.ts";
import { parseBucket, parseGroup, parseMetric, parseWindow, UsageService } from "../src/usage/service.ts";
import { databaseSources, fileRoots } from "../src/usage/sources.ts";
import { UsageStore } from "../src/usage/store.ts";
import { sessionRates } from "../src/usage/rates.ts";

// Fixture lines keep the real field order and shapes of each client's transcript, with ids and text replaced.
const prime = {
  header: (depth = 0) => JSON.stringify({ type: "session", version: 3, id: "s-root", timestamp: "2026-10-07T11:06:08.149Z", cwd: "/work/repo", rlmDepth: depth, ...(depth ? { parentSession: "/p.jsonl" } : {}) }),
  user: JSON.stringify({ type: "message", id: "u1", parentId: "h", timestamp: "2026-10-07T11:06:10.000Z", message: { role: "user", content: [{ type: "text", text: "hi \"role\":\"assistant\"" }], timestamp: 1791371170000 } }),
  assistant: (id: string, responseId: string | null, output = 677, ts = "2026-10-07T11:06:23.517Z") => JSON.stringify({ type: "message", id, parentId: "u1", timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5",
      usage: { input: 4, output, cacheRead: 514, cacheWrite: 29000, totalTokens: 30195, cost: { input: 1.6e-5, output: 0.0135, cacheRead: 0.0001, cacheWrite: 0.232, total: 0.2456 } },
      stopReason: "toolUse", timestamp: 1791371170814, ...(responseId ? { responseId } : {}) } }),
  attributed: JSON.stringify({ type: "child_usage_attributed", id: "97f7e8a7", parentId: "bf20e4e4", timestamp: "2026-10-07T11:07:00.000Z", targetId: "a1",
    childUsage: { input: 5102, output: 243, cacheRead: 514, cacheWrite: 22402, totalTokens: 28261, cost: { total: 0.34 } },
    aggregateUsage: { input: 5128, output: 2893, cacheRead: 148864, cacheWrite: 23441, totalTokens: 152065, cost: { total: 0.52 } }, origin: "spawn_task" }),
};
const claude = {
  user: (ts: string) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: "external", cwd: "/work/repo", sessionId: "c-sess", version: "2.1.0", type: "user",
    message: { role: "user", content: "do it" }, uuid: "u-1", timestamp: ts }),
  assistant: (id: string, request: string, output: number, ts: string, model = "claude-opus-5-5") => JSON.stringify({ parentUuid: "u-1", isSidechain: false,
    message: { model, id, type: "message", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: null,
      usage: { input_tokens: 2, cache_creation_input_tokens: 71770, cache_read_input_tokens: 41170, output_tokens: output, service_tier: "standard" } },
    requestId: request, type: "assistant", uuid: "a-" + output, timestamp: ts, userType: "external", cwd: "/work/repo", sessionId: "c-sess", version: "2.1.0" }),
};
const usage = (input: number, cached: number, output: number, reasoning: number) =>
  ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const cx = {
  meta: (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: "2026-10-07T07:58:23.753Z", ordinal: 0, type: "session_meta",
    payload: { session_id: id, id, timestamp: "2026-10-07T07:58:23.753Z", cwd: "/work/repo", originator: "codex_sdk_ts", cli_version: "0.144.2", source: "exec", model_provider: "openai", ...extra } }),
  turn: (turnId: string, ts = "2026-10-07T07:58:24.000Z", model = "gpt-5.6-sol") => JSON.stringify({ timestamp: ts, ordinal: 7, type: "turn_context", payload: { turn_id: turnId, cwd: "/work/repo", model, effort: "xhigh" } }),
  tokens: (ts: string, total: ReturnType<typeof usage>, last: ReturnType<typeof usage>) => JSON.stringify({ timestamp: ts, ordinal: 13, type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 }, rate_limits: { limit_id: "codex" } } }),
};

function run(spec: ParserSpec, lines: string[], path = "/x/rollout-2026-10-07T16-58-23-01a1155e-e7b4-7c93-a748-3320643ba371.jsonl"): UsageCall[] {
  const parser = spec.create({ source: "test", path, fileId: "1", fallbackTime: 0 }, null);
  const out: UsageCall[] = [];
  lines.forEach((line, index) => out.push(...parser.line(line, index)));
  out.push(...parser.finish());
  return out;
}

test("Prime Agent: one call per assistant message, own cost kept, attribution bookkeeping skipped", () => {
  const calls = run(piFormat, [prime.header(), prime.user, prime.assistant("a1", "msg_1"), prime.attributed, prime.assistant("a2", null, 10)]);
  assert.equal(calls.length, 2);
  assert.deepEqual({ ...calls[0] }, { source: "test", callId: "msg_1", sessionId: "s-root", endedAt: Date.parse("2026-10-07T11:06:23.517Z"), startedAt: 1791371170814,
    provider: "anthropic", model: "claude-opus-5-5", input: 4, output: 677, cacheRead: 514, cacheWrite: 29000, reasoning: 0, costUsd: 0.2456, cwd: "/work/repo" });
  assert.equal(calls[1]!.callId, `msg:a2:${Date.parse("2026-10-07T11:06:23.517Z")}`);
});

test("Prime Agent: a file without a session header is not a transcript; a child without a timestamp is skipped", () => {
  assert.equal(run(piFormat, [prime.assistant("a1", "msg_1")]).length, 0);
  const noTime = JSON.parse(prime.assistant("a3", "msg_3")) as Record<string, unknown>;
  delete noTime.timestamp;
  assert.equal(run(piFormat, [prime.header(1), JSON.stringify(noTime), prime.assistant("a4", "msg_4")]).length, 1);
});

test("Claude Code: request start from the user entry, message:request id, <synthetic> notices dropped", () => {
  const calls = run(claudeCode, [claude.user("2026-10-07T10:00:00.000Z"), claude.assistant("msg_A", "req_A", 10, "2026-10-07T10:00:05.000Z"),
    claude.assistant("msg_A", "req_A", 319, "2026-10-07T10:00:09.000Z"), claude.user("2026-10-07T10:01:00.000Z"),
    claude.assistant("msg_S", "req_S", 0, "2026-10-07T10:01:01.000Z", "<synthetic>")]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.callId, "msg_A:req_A");
  assert.equal(calls[0]!.startedAt, Date.parse("2026-10-07T10:00:00.000Z"));
  assert.equal(calls[1]!.startedAt, null);
  assert.deepEqual([calls[0]!.input, calls[0]!.cacheWrite, calls[0]!.cacheRead, calls[1]!.output], [2, 71770, 41170, 319]);
});

test("Codex: last_token_usage per event, cached and reasoning split out, repeated totals dropped, model from turn_context", () => {
  const calls = run(codex, [cx.meta("01a1155e-e7b4-7c93-a748-3320643ba371"), cx.turn("01a1155e-e9c7-7131-95d3-1e7498357c14"),
    cx.tokens("2026-10-07T07:58:33.325Z", usage(47454, 0, 288, 155), usage(47454, 0, 288, 155)),
    cx.tokens("2026-10-07T07:58:34.000Z", usage(47454, 0, 288, 155), usage(47454, 0, 288, 155)),
    cx.tokens("2026-10-07T07:58:42.078Z", usage(95799, 47232, 586, 396), usage(48345, 47232, 298, 241))]);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[1]!.input, calls[1]!.cacheRead, calls[1]!.output, calls[1]!.reasoning, calls[1]!.model], [1113, 47232, 57, 241, "gpt-5.6-sol"]);
  assert.equal(calls[1]!.startedAt, Date.parse("2026-10-07T07:58:33.325Z"));
  assert.match(calls[0]!.callId, /^total:01a1155e-e7b4-7c93-a748-3320643ba371:openai:gpt-5.6-sol:47454:288:0:155$/);
});

test("Codex: a forked child skips the replayed parent history and keys its rows by the fork parent", () => {
  const child = "01a11600-0000-7000-8000-000000000002";
  const calls = run(codex, [cx.meta(child, { forked_from_id: "01a11500-0000-7000-8000-000000000001", thread_source: "subagent" }),
    cx.meta("01a11500-0000-7000-8000-000000000001"), cx.turn("01a11500-0000-7000-8000-0000000000aa", "2026-10-07T07:00:00.000Z"),
    cx.tokens("2026-10-07T07:00:01.000Z", usage(1000, 0, 10, 0), usage(1000, 0, 10, 0)),
    cx.turn("01a11601-0000-7000-8000-0000000000bb", "2026-10-07T08:00:00.000Z"),
    cx.tokens("2026-10-07T08:00:01.000Z", usage(1000, 0, 10, 0), usage(1000, 0, 10, 0)),
    cx.tokens("2026-10-07T08:00:02.000Z", usage(3000, 1000, 30, 0), usage(2000, 1000, 20, 0))]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, 1000);
  assert.match(calls[0]!.callId, /^total:01a11500-0000-7000-8000-000000000001:/);
});

test("reader: only whole lines, needles near the line start, offset after the last newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-reader-"));
  const path = join(dir, "t.jsonl");
  await writeFile(path, '{"type":"a","x":1}\n{"x":"type a later","type":"a"}\n{"type":"a","partial');
  const seen: string[] = [];
  const first = await readAppended(path, 0, [{ text: '"type":"a"', within: 1 }], text => seen.push(text));
  assert.deepEqual(seen, ['{"type":"a","x":1}']);
  assert.equal(first.offset, '{"type":"a","x":1}\n{"x":"type a later","type":"a"}\n'.length);
  await appendFile(path, '":true}\n');
  const anywhere: string[] = [];
  const second = await readAppended(path, first.offset, [{ text: '"type":"a"' }], text => anywhere.push(text));
  assert.deepEqual(anywhere, ['{"type":"a","partial":true}']);
  assert.equal(second.offset, (await readFile(path)).length);
  await rm(dir, { recursive: true });
});

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), "usage-home-"));
  await mkdir(join(home, ".prime/agent/sessions"), { recursive: true });
  await mkdir(join(home, ".prime/agent/session-artifacts/s-root/sub-1"), { recursive: true });
  await mkdir(join(home, ".prime/agent/session-artifacts/s-root/notes"), { recursive: true });
  await mkdir(join(home, ".claude/projects/-work-repo"), { recursive: true });
  await mkdir(join(home, ".codex/sessions/2026/10/07"), { recursive: true });
  await writeFile(join(home, ".prime/agent/sessions/root.jsonl"), [prime.header(), prime.assistant("a1", "msg_1"), prime.attributed, ""].join("\n"));
  await writeFile(join(home, ".prime/agent/session-artifacts/s-root/sub-1/child.jsonl"), [prime.header(1), prime.assistant("c1", "msg_child", 50), ""].join("\n"));
  await writeFile(join(home, ".prime/agent/session-artifacts/s-root/notes/other.jsonl"), [prime.header(), prime.assistant("n1", "msg_not_a_child"), ""].join("\n"));
  await writeFile(join(home, ".claude/projects/-work-repo/c.jsonl"), [claude.user("2026-10-07T10:00:00.000Z"), claude.assistant("msg_A", "req_A", 10, "2026-10-07T10:00:05.000Z"), ""].join("\n"));
  await writeFile(join(home, ".codex/sessions/2026/10/07/rollout-2026-10-07T16-58-23-01a1155e-e7b4-7c93-a748-3320643ba371.jsonl"),
    [cx.meta("01a1155e-e7b4-7c93-a748-3320643ba371"), cx.turn("t1"), cx.tokens("2026-10-07T07:58:33.325Z", usage(100, 0, 10, 0), usage(100, 0, 10, 0)), ""].join("\n"));
  return home;
}

async function totals(store: UsageStore) {
  return (await store.daily(0)).map(row => `${row.source} ${row.calls} ${row.tokens.total}`).sort();
}

test("ingest: first build, appended bytes, partial lines, in-place rewrite and inode change, rebuild from scratch", async () => {
  const home = await fixtureHome();
  const dataDir = await mkdtemp(join(tmpdir(), "usage-data-"));
  const open = async () => {
    const store = await UsageStore.open(join(dataDir, "usage.duckdb"));
    const ingest = new Ingest({ store, roots: fileRoots(home), databases: databaseSources(home), pricesPath: join(dataDir, "p.json"), debounceMs: 20, sweepMs: 60_000,
      fetchPrices: async () => { throw new Error("offline"); } });
    await ingest.start();
    await ingest.idle();
    return { store, ingest };
  };
  let { store, ingest } = await open();
  assert.equal(store.fresh, true);
  const first = await totals(store);
  assert.deepEqual(first, ["claude-code 1 112952", "codex 1 110", "prime-agent 2 59763"]);
  // Per-session timed calls, for the Agents card's output rates: the Prime Agent fixture call started at its message timestamp and ended at its entry's.
  const timed = await store.sessionCalls(["s-root", "nobody"], 0);
  assert.deepEqual(timed.map(call => [call.sessionId, call.startedAt, call.endedAt, call.output]).sort((a, b) => Number(a[3]) - Number(b[3])),
    [["s-root", 1791371170814, Date.parse("2026-10-07T11:06:23.517Z"), 50], ["s-root", 1791371170814, Date.parse("2026-10-07T11:06:23.517Z"), 677]]);
  assert.deepEqual(await store.sessionCalls([], 0), []);
  assert.deepEqual(sessionRates(timed, Date.parse("2026-10-07T11:07:00Z")), { "s-root": { tps: 28.6, live: true } }, "727 tokens over two 12.7 s calls");

  // Appended: one whole line and one partial; then the rest of the partial line.
  const rootPath = join(home, ".prime/agent/sessions/root.jsonl");
  const line = prime.assistant("a5", "msg_5", 1);
  await appendFile(rootPath, line + "\n" + line.slice(0, 40).replace("msg_5", "msg_6"));
  await ingest.syncFile(fileRoots(home)[0]!, rootPath);
  await (ingest as unknown as { flush(force: boolean): Promise<void> }).flush(true);
  assert.equal((await store.daily(0)).find(r => r.source === "prime-agent")!.calls, 3);
  await appendFile(rootPath, prime.assistant("a6", "msg_6", 1).slice(40) + "\n");
  await ingest.syncFile(fileRoots(home)[0]!, rootPath);
  await (ingest as unknown as { flush(force: boolean): Promise<void> }).flush(true);
  assert.equal((await store.daily(0)).find(r => r.source === "prime-agent")!.calls, 4);

  // Claude Code rewrites a transcript in place on resume or compact: the old call stays, the streamed copy merges up.
  const claudePath = join(home, ".claude/projects/-work-repo/c.jsonl");
  await writeFile(claudePath, [claude.assistant("msg_A", "req_A", 319, "2026-10-07T10:00:09.000Z"), ""].join("\n"));
  const claudeRoot = fileRoots(home).find(root => root.source === "claude-code")!;
  await ingest.syncFile(claudeRoot, claudePath);
  await (ingest as unknown as { flush(force: boolean): Promise<void> }).flush(true);
  const merged = (await store.daily(0)).find(r => r.source === "claude-code")!;
  assert.deepEqual([merged.calls, merged.tokens.output], [1, 319]);
  // A new inode (write to a temp file, then rename) rereads from 0 with no double count.
  await writeFile(claudePath + ".tmp", [claude.assistant("msg_A", "req_A", 319, "2026-10-07T10:00:09.000Z"), claude.assistant("msg_B", "req_B", 5, "2026-10-07T10:02:00.000Z"), ""].join("\n"));
  await rename(claudePath + ".tmp", claudePath);
  await ingest.syncFile(claudeRoot, claudePath);
  await (ingest as unknown as { flush(force: boolean): Promise<void> }).flush(true);
  assert.equal((await store.daily(0)).find(r => r.source === "claude-code")!.calls, 2);

  const before = await totals(store);
  ingest.close(); await ingest.idle(); await store.close();
  await rm(join(dataDir, "usage.duckdb"), { force: true });
  await rm(join(dataDir, "usage.duckdb.wal"), { force: true });
  ({ store, ingest } = await open());
  assert.deepEqual(await totals(store), before);
  ingest.close(); await ingest.idle(); await store.close();
  await rm(home, { recursive: true }); await rm(dataDir, { recursive: true });
});

test("ingest: a Prime Agent session moved to sessions-archive keeps its calls and counts once", async () => {
  const home = await fixtureHome();
  const dataDir = await mkdtemp(join(tmpdir(), "usage-archive-"));
  const open = async () => {
    const store = await UsageStore.open(join(dataDir, "usage.duckdb"));
    const ingest = new Ingest({ store, roots: fileRoots(home), databases: [], pricesPath: join(dataDir, "p.json"), debounceMs: 20, sweepMs: 60_000,
      fetchPrices: async () => { throw new Error("offline"); } });
    await ingest.start();
    await ingest.idle();
    return { store, ingest };
  };
  let { store, ingest } = await open();
  try {
    const before = await totals(store);
    ingest.close(); await ingest.idle(); await store.close();
    await mkdir(join(home, ".prime/agent/sessions-archive/2026-10-audit"), { recursive: true });
    await rename(join(home, ".prime/agent/sessions/root.jsonl"), join(home, ".prime/agent/sessions-archive/2026-10-audit/root.jsonl"));
    ({ store, ingest } = await open());
    assert.deepEqual(await totals(store), before);
  } finally {
    ingest.close(); await ingest.idle(); await store.close();
    await rm(home, { recursive: true }); await rm(dataDir, { recursive: true });
  }
});

test("ingest: a parser version bump reads only that source again", async () => {
  const home = await fixtureHome();
  const dataDir = await mkdtemp(join(tmpdir(), "usage-parser-"));
  const path = join(dataDir, "usage.duckdb");
  const open = async (roots: ReturnType<typeof fileRoots>) => {
    const store = await UsageStore.open(path);
    const ingest = new Ingest({ store, roots, databases: [], pricesPath: join(dataDir, "p.json"), debounceMs: 20, sweepMs: 60_000,
      fetchPrices: async () => { throw new Error("offline"); } });
    await ingest.start();
    await ingest.idle();
    return { store, ingest };
  };
  let { store, ingest } = await open(fileRoots(home));
  try {
    const before = await totals(store);
    ingest.close(); await ingest.idle(); await store.close();
    // Mark every stored row wrong, as a parser bug would; only the bumped source may be corrected.
    const instance = await DuckDBInstance.create(path);
    const db = await instance.connect();
    await db.run("UPDATE calls SET output = output + 1000");
    db.closeSync(); instance.closeSync();
    const bumped = fileRoots(home).map(root => root.source === "codex" ? { ...root, spec: { ...root.spec, version: "2" } } : root);
    ({ store, ingest } = await open(bumped));
    const after = await totals(store);
    assert.equal(after.find(row => row.startsWith("codex")), before.find(row => row.startsWith("codex")));
    assert.notEqual(after.find(row => row.startsWith("claude-code")), before.find(row => row.startsWith("claude-code")));
    assert.deepEqual([...new Set((await store.files()).filter(row => row.source === "codex").map(row => row.parser))], ["2"]);
  } finally {
    ingest.close(); await ingest.idle(); await store.close();
    await rm(home, { recursive: true }); await rm(dataDir, { recursive: true });
  }
});

test("prices: LiteLLM rows, matched with provider prefixes, dates and version dots", () => {
  const table = toTable({ "claude-opus-4-5": { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_input_token_cost: 5e-7 }, "openai/gpt-5": { input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 } });
  assert.equal(resolvePrice("claude-opus-4.5-20251101", "anthropic", table)?.key, "claude-opus-4-5");
  assert.equal(resolvePrice("gpt-5", "openai", table)?.key, "openai/gpt-5");
  assert.equal(resolvePrice("gpt-5.6-sol", "openai", table), null);
});

test("service: the worker answers summary, series and models; bad parameters are 400", async () => {
  assert.throws(() => parseWindow("2h"), /Use window/);
  assert.throws(() => parseBucket(null), /Use bucket/);
  assert.equal(parseGroup(null), "none");
  assert.equal(parseGroup("kind"), "kind");
  assert.equal(parseMetric(null), "output");
  assert.equal(parseMetric("cacheRead"), "cacheRead");
  assert.throws(() => parseMetric("reasoning"), (error: Error & { status?: number }) => error.status === 400 && /Use metric output, input, cacheRead, cacheWrite, total/.test(error.message));
  const home = await fixtureHome();
  const dataDir = await mkdtemp(join(tmpdir(), "usage-svc-"));
  const service = new UsageService({ dataDir, home, offline: true, debounceMs: 20 });
  service.start();
  // close() in finally: an open usage worker keeps the test process alive after a failed assertion.
  try {
    let summary;
    for (let i = 0; i < 100; i++) {
      summary = await service.summary().catch(() => null);
      if (summary?.ingest.state === "idle") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(summary?.ingest.state, "idle");
    assert.equal(summary.ingest.filesDone, summary.ingest.filesTotal);
    assert.deepEqual(summary.ingest.sources.map(s => s.source).sort(), ["claude-code", "codex", "prime-agent"]);
    const series = await service.series("all", "day", "source");
    assert.ok(series.points.length >= 1);
    assert.equal(series.metric, "output");
    assert.equal(series.points.reduce((sum, p) => sum + p.tokens.total, 0), 112952 + 110 + 4 + 677 + 514 + 29000 + 4 + 50 + 514 + 29000);
    assert.ok(series.keys.includes("codex"));
    // byKey carries the metric: output per source, ranked by it (prime-agent 677 + 50, claude-code 10, codex 10).
    const outBySource = series.points.reduce<Record<string, number>>((sum, p) => { for (const [k, v] of Object.entries(p.byKey ?? {})) sum[k] = (sum[k] ?? 0) + v; return sum; }, {});
    assert.deepEqual(outBySource, { "prime-agent": 727, "claude-code": 10, codex: 10 });
    assert.equal(series.keys[0], "prime-agent");
    const reads = await service.series("all", "day", "source", "cacheRead");
    assert.equal(reads.metric, "cacheRead");
    assert.equal(reads.points.reduce((sum, p) => sum + (p.byKey?.["claude-code"] ?? 0), 0), 41170);
    // Group kind: the four kinds in stack order, output first, and the parts add up to the total.
    const kinds = await service.series("all", "day", "kind", "cacheWrite");
    assert.deepEqual(kinds.keys, ["output", "input", "cacheWrite", "cacheRead"]);
    for (const point of kinds.points) assert.equal(Object.values(point.byKey ?? {}).reduce((a, b) => a + b, 0), point.tokens.total);
    assert.equal(kinds.points.reduce((sum, p) => sum + (p.byKey?.cacheRead ?? 0), 0), 41170 + 514 + 514);
    assert.equal(kinds.points.reduce((sum, p) => sum + (p.byKey?.output ?? 0), 0), 747);
    // The 24 h rates and sparklines are per metric; the fixture calls are old, so they are all zero but complete.
    assert.deepEqual(Object.keys(summary.perDay).sort(), ["cacheRead", "cacheWrite", "input", "output", "total"]);
    assert.deepEqual(Object.keys(summary.sparkSeconds).sort(), ["cacheRead", "cacheWrite", "input", "output", "total"]);
    assert.equal(summary.sparkMinutes.output.length, 60);
    const { models } = await service.models("all");
    assert.equal(models.find(m => m.model === "claude-opus-5-5" && m.source === "prime-agent")?.calls, 2);
    await assert.rejects(service.series("all", "second", "none"), (error: Error & { status?: number }) => error.status === 400);
    // A new line in a live transcript reaches the summary through fs.watch, split by kind: 7 output, 4 input, 514 cache read, 29000 cache write.
    await appendFile(join(home, ".prime/agent/sessions/root.jsonl"), prime.assistant("a9", "msg_9", 7, new Date().toISOString()) + "\n");
    let live: Awaited<ReturnType<typeof service.summary>> | null = null;
    for (let i = 0; i < 100 && !live; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const next = await service.summary();
      if (next.sparkSeconds.total.some(n => n > 0)) live = next;
    }
    assert.ok(live, "the appended call shows in the per-second window");
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    assert.deepEqual({ output: sum(live.sparkSeconds.output), input: sum(live.sparkSeconds.input), cacheRead: sum(live.sparkSeconds.cacheRead), cacheWrite: sum(live.sparkSeconds.cacheWrite), total: sum(live.sparkSeconds.total) },
      { output: 7, input: 4, cacheRead: 514, cacheWrite: 29000, total: 29525 });
    assert.equal(live.perSecond.output, 7 / 60);
    assert.equal(live.perSecond.cacheRead, 514 / 60);
    assert.equal(live.perMinute.total, 29525 / 60);
    // The fixture calls are dated 2026-10-07, so the 24 h window may hold them as well; the kinds still add up to the total.
    assert.ok(live.perDay.output >= 7);
    assert.equal(live.perDay.total, live.perDay.output + live.perDay.input + live.perDay.cacheRead + live.perDay.cacheWrite);
  } finally {
    await service.close();
    await rm(home, { recursive: true }); await rm(dataDir, { recursive: true });
  }
});

test("service: a worker that cannot open the database reports state error and close() returns at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-broken-"));
  // A file where the data folder should be: DuckDB cannot create usage.duckdb under it.
  const dataDir = join(dir, "not-a-folder");
  await writeFile(dataDir, "x");
  const service = new UsageService({ dataDir, home: dir, offline: true });
  service.start();
  try {
    let summary;
    for (let i = 0; i < 100; i++) {
      summary = await service.summary();
      if (summary.ingest.state === "error") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(summary?.ingest.state, "error");
    assert.ok(summary.ingest.error);
    await assert.rejects(service.series("24h", "hour", "none"), (error: Error & { status?: number }) => error.status === 503);
  } finally {
    const started = Date.now();
    await service.close();
    assert.ok(Date.now() - started < 3500);
    await rm(dir, { recursive: true });
  }
});
