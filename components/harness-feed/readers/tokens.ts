import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileLines } from "../../user-history/src/file-lines.ts";
import { cacheHealth } from "../../user-history/src/shared/cache-health.ts";
import type { ThreadMessage } from "../../user-history/src/shared/types.ts";
import { promisify } from "node:util";
import type { Context, Sample } from "../otlp.ts";
import { copyIndex, type CopyRow } from "./session-copy.ts";

/**
 * The tokens group. Token, cost, cache and throughput numbers are in LGTM already: components/usage-feed sends Prime's five prime_agent_*
 * counters from the transcripts (feed="transcripts") until Prime's own exporter ships, and the dashboard copies the PromQL of
 * components/user-history/src/usage/lgtm.ts. This reader adds what LGTM lacks:
 * 1. usage-feed's own health on every box: running, handed off, release, start time, CPU, memory and the errors in its log.
 * 2. On the chat host, each chat's lifetime cost and tokens as the chat app shows them: the thread's own session usage (the ContextMeter's
 *    session cost), its subagents (the child-usage job costs, chat-catalog.ts childUsage) and the root job sessions chat-jobs.json gives it.
 *    It reads the session copies the chat service saves (session-peer.ts, at most every 5 min) one row at a time, and only after a copy changed.
 * 3. On the chat host, the numbers the app computes from files or one query: the Settings > Usage query health, the Agents card rates (top 10),
 *    each chat's context ring, cache warning, compactions and Prompt view parts, and the Tools page's skills tokens.
 */

const run = promisify(execFile);
/** The window of the log error counts, the "last 30 min" of the shared brief. */
const ERROR_WINDOW_MS = 30 * 60_000;
/** The log tail a first round reads; usage-feed writes a line at start, at handoff and per failure only. */
const FIRST_READ_BYTES = 256 * 1024;

type Kind = "export_failed" | "handoff_check_failed" | "handed_off";
/** One usage-feed log line that matters, from components/usage-feed/feed.py. */
export type LogLine = { at: number; started: boolean; error: Kind | null };

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (.*)$/;
export function parseLogLine(line: string): LogLine | null {
  const match = STAMP.exec(line);
  if (!match) return null;
  const at = Date.parse(match[1]!);
  const text = match[2]!;
  if (text.startsWith("started as ")) return { at, started: true, error: null };
  if (text.startsWith("export failed:")) return { at, started: false, error: "export_failed" };
  if (text.startsWith("handoff check failed:")) return { at, started: false, error: "handoff_check_failed" };
  if (text.includes("the feed stops")) return { at, started: false, error: "handed_off" };
  return null;
}

type LogState = { offset: number; startedAt: number | null; errors: { at: number; kind: Kind }[] };

/** Reads the bytes the log gained since the last round; a log that shrank starts again from its start. */
export async function readLog(file: string, state: LogState): Promise<LogState> {
  const info = await stat(file).catch(() => null);
  if (!info) return state;
  let offset = state.offset > info.size ? 0 : state.offset;
  if (offset === 0 && info.size > FIRST_READ_BYTES) offset = info.size - FIRST_READ_BYTES;
  if (offset === info.size) return { ...state, offset };
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(info.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(10) + 1;
    let { startedAt } = state;
    const errors = [...state.errors];
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      const parsed = parseLogLine(line);
      if (!parsed) continue;
      if (parsed.started) startedAt = parsed.at;
      if (parsed.error) errors.push({ at: parsed.at, kind: parsed.error });
    }
    return { offset: offset + end, startedAt, errors };
  } finally {
    await handle.close();
  }
}

type Proc = { up: boolean; cpuSeconds: number | null; rssBytes: number | null };

/** Linux: the systemd user unit's cgroup (install.py's usage-feed.service); no unit is not running. */
async function linuxProc(): Promise<Proc> {
  const uid = process.getuid?.() ?? 0;
  const dir = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/usage-feed.service`;
  const [procs, cpu] = await Promise.all([readFile(join(dir, "cgroup.procs"), "utf8").catch(() => ""), readFile(join(dir, "cpu.stat"), "utf8").catch(() => "")]);
  const pid = procs.split("\n").find(Boolean);
  if (!pid) return { up: false, cpuSeconds: null, rssBytes: null };
  const usec = /^usage_usec (\d+)$/m.exec(cpu);
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  return { up: true, cpuSeconds: usec ? Number(usec[1]) / 1e6 : null, rssBytes: rss ? Number(rss[1]) * 1024 : null };
}

/** `ps` TIME, such as 2:05.22 or 1:02:05.22, in seconds. */
export function psSeconds(time: string): number {
  return time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** The Mac: the launchd job's python, found with one `ps -ax` and then followed by pid with `ps -p`. */
async function macProc(state: Map<string, unknown>): Promise<Proc> {
  const ps = async (args: string[]) => (await run("/bin/ps", args).catch(() => ({ stdout: "" }))).stdout;
  let pid = state.get("tokens.feedPid") as string | undefined;
  let line = pid ? (await ps(["-o", "pid=,rss=,time=,command=", "-p", pid])).trim() : "";
  if (!line.includes("usage-feed/feed.py")) {
    line = (await ps(["-axo", "pid=,rss=,time=,command="])).split("\n").find(row => row.includes("usage-feed/feed.py"))?.trim() ?? "";
    pid = line.split(/\s+/)[0];
    state.set("tokens.feedPid", pid);
  }
  const [, rss, time] = line.split(/\s+/);
  if (!line || !rss || !time) return { up: false, cpuSeconds: null, rssBytes: null };
  return { up: true, cpuSeconds: psSeconds(time), rssBytes: Number(rss) * 1024 };
}

async function feedHealth(ctx: Context): Promise<Sample[]> {
  const share = join(ctx.home, ".local/share/usage-feed");
  const previous = (ctx.state.get("tokens.log") as LogState | undefined) ?? { offset: 0, startedAt: null, errors: [] };
  const [proc, handedOff, release, log] = await Promise.all([
    ctx.platform === "darwin" ? macProc(ctx.state) : linuxProc(),
    stat(join(share, "handed-off")).then(() => true, () => false),
    readFile(join(share, "release.json"), "utf8").then(text => JSON.parse(text) as { sha?: unknown; installedAt?: unknown }, () => null),
    readLog(join(share, "feed.log"), previous),
  ]);
  log.errors = log.errors.filter(error => ctx.now - error.at < ERROR_WINDOW_MS);
  ctx.state.set("tokens.log", log);
  const samples: Sample[] = [
    { name: "harness.tokens.usage_feed_up", kind: "gauge", help: "1 when the usage-feed process runs on this box.", value: proc.up ? 1 : 0 },
    { name: "harness.tokens.usage_feed_handed_off", kind: "gauge", help: "1 when usage-feed wrote handed-off because Prime's own exporter sends this box's usage.", value: handedOff ? 1 : 0 },
  ];
  for (const kind of ["export_failed", "handoff_check_failed", "handed_off"] as const) {
    samples.push({ name: "harness.tokens.usage_feed_log_errors", kind: "gauge", help: "usage-feed log lines of this kind in the last 30 min.",
      value: log.errors.filter(error => error.kind === kind).length, labels: { kind } });
  }
  if (log.startedAt !== null) samples.push({ name: "harness.tokens.usage_feed_start_time", kind: "gauge", unit: "s", help: "When usage-feed last started, from its log, in epoch seconds.", value: log.startedAt / 1000 });
  if (proc.cpuSeconds !== null) samples.push({ name: "harness.tokens.usage_feed_cpu", kind: "counter", unit: "s", help: "CPU seconds the usage-feed process has used since it started.", value: proc.cpuSeconds });
  if (proc.rssBytes !== null) samples.push({ name: "harness.tokens.usage_feed_rss", kind: "gauge", unit: "By", help: "usage-feed's resident memory.", value: proc.rssBytes });
  if (release && typeof release.sha === "string") {
    const installed = typeof release.installedAt === "string" ? Date.parse(release.installedAt) / 1000 : NaN;
    samples.push({ name: "harness.tokens.usage_feed_release", kind: "gauge", unit: "s", help: "When the running usage-feed copy was installed, in epoch seconds, by commit.", value: installed, labels: { sha: release.sha.slice(0, 7) } });
  }
  return samples;
}

/** The fields of one daemon session row (SessionSummary in a SessionPeer copy) the chat costs, rates and context ring need. */
export type Row = Pick<CopyRow, "id" | "parent" | "name" | "input" | "output" | "cost" | "file" | "window" | "model">;

/** A file's parsed form, loaded again only when its size or mtime changed. */
async function cached<T>(ctx: Context, file: string, load: (file: string) => Promise<T>, empty: T): Promise<T> {
  const info = await stat(file).catch(() => null);
  if (!info) return empty;
  const key = `${info.size}:${info.mtimeMs}`;
  const slot = `tokens.file:${file}`;
  const hit = ctx.state.get(slot) as { key: string; value: T } | undefined;
  if (hit?.key === key) return hit.value;
  const value = await load(file);
  ctx.state.set(slot, { key, value });
  return value;
}

const readJson = async <T>(file: string, pick: (json: unknown) => T): Promise<T> => pick(JSON.parse(await readFile(file, "utf8")) as unknown);

type Part = "thread" | "subagents" | "jobs";
export type ChatUsage = { chat: string; runsOn: string; part: Part; input: number; output: number; cost: number };

/**
 * Each chat's usage in three parts. `thread` is the chat session's row. `subagents` sums the rows whose parent is the chat, as
 * chat-catalog.ts childUsage does for the job costs the Reader shows. `jobs` sums the root job sessions chat-jobs.json gives the chat (by chatId,
 * else by a name the chat had) and their direct subagents. A job keyed by name is the first row with that session name.
 */
export function chatUsage(chatIds: readonly string[], jobs: Record<string, { chat?: string; chatId?: string }>, boxes: { box: string; rows: Row[] }[]): ChatUsage[] {
  const byId = new Map<string, { box: string; row: Row }>();
  const children = new Map<string, Row[]>();
  for (const { box, rows } of boxes) for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, { box, row });
    if (row.parent) { const list = children.get(row.parent); if (list) list.push(row); else children.set(row.parent, [row]); }
  }
  const chats = chatIds.flatMap(id => { const found = byId.get(id); return found ? [{ id, ...found }] : []; });
  // A job entry without chatId names its chat as it was called then; entries with both give the old names of a renamed chat.
  const idByName = new Map<string, string>();
  for (const job of Object.values(jobs)) if (job.chat && job.chatId) idByName.set(job.chat, job.chatId);
  for (const chat of chats) idByName.set(chat.row.name ?? chat.id.slice(0, 8), chat.id);
  // A job started by name is keyed by its session name in chat-jobs.json.
  const byName = new Map<string, Row>();
  for (const { row } of byId.values()) if (row.name && !byName.has(row.name)) byName.set(row.name, row);
  const jobsOf = new Map<string, Row[]>();
  const chatSet = new Set(chatIds);
  for (const [key, job] of Object.entries(jobs)) {
    const chatId = job.chatId ?? (job.chat ? idByName.get(job.chat) : undefined);
    const row = byId.get(key)?.row ?? byName.get(key);
    if (!chatId || !row || chatSet.has(key)) continue;
    const list = jobsOf.get(chatId) ?? [];
    list.push(row, ...children.get(row.id) ?? []);
    jobsOf.set(chatId, list);
  }
  const total = (rows: readonly Row[]) => rows.reduce((sum, row) => ({ input: sum.input + row.input, output: sum.output + row.output, cost: sum.cost + row.cost }), { input: 0, output: 0, cost: 0 });
  return chats.flatMap(({ id, box, row }) => {
    const chat = row.name ?? id.slice(0, 8);
    return [{ part: "thread" as const, ...total([row]) }, { part: "subagents" as const, ...total(children.get(id) ?? []) }, { part: "jobs" as const, ...total(jobsOf.get(id) ?? []) }]
      .map(usage => ({ chat, runsOn: box, ...usage }));
  });
}

type Jobs = Record<string, { chat?: string; chatId?: string }>;
type Rows = { ids: string[]; jobs: Jobs; boxes: { box: string; rows: Row[] }[] };

/** The chat host's chat list, job list and both boxes' session rows, each loaded again only after its file changed. */
async function loadRows(ctx: Context): Promise<Rows> {
  const chatDir = join(ctx.home, ".prime/agent/browser-chat");
  const mirror = join(ctx.home, ".cache/sieun-pi/hosts");
  const others = await readdir(mirror).catch(() => [] as string[]);
  const files = [{ box: ctx.host, file: join(chatDir, "session-copy.json") },
    ...others.filter(name => name.endsWith(".sessions.json")).map(name => ({ box: name.slice(0, -".sessions.json".length), file: join(mirror, name) }))];
  const [ids, jobs] = await Promise.all([
    cached(ctx, join(chatDir, "chats.json"), file => readJson(file, json => (json as { ids?: string[] }).ids ?? []), [] as string[]),
    cached(ctx, join(chatDir, "chat-jobs.json"), file => readJson(file, json => (json as { jobs?: Jobs }).jobs ?? {}), {} as Jobs),
  ]);
  // copyIndex parses a copy once per change for every reader of the feed; chat-health reads the same copies.
  const boxes: { box: string; rows: Row[] }[] = [];
  for (const { box, file } of files) boxes.push({ box, rows: await copyIndex(file) });
  return { ids, jobs, boxes };
}

/** chatCosts of the last round again while the chat list, the job list and every copy's rows are the same objects, which `cached` keeps. */
function costs(ctx: Context, rows: Rows): Sample[] {
  const inputs = [rows.ids, rows.jobs, ...rows.boxes.map(box => box.rows)];
  const held = ctx.state.get("tokens.costs") as { inputs: unknown[]; samples: Sample[] } | undefined;
  if (held && held.inputs.length === inputs.length && held.inputs.every((input, index) => input === inputs[index])) return held.samples;
  const samples = chatCosts(rows);
  ctx.state.set("tokens.costs", { inputs, samples });
  return samples;
}

function chatCosts({ ids, jobs, boxes }: Rows): Sample[] {
  return chatUsage(ids, jobs, boxes).flatMap(({ chat, runsOn, part, input, output, cost }) => {
    const labels = { chat, part, runs_on: runsOn };
    return [
      { name: "harness.tokens.chat_cost_usd", kind: "gauge" as const, help: "A chat's lifetime model cost in USD as the chat app's session rows give it, by part.", value: cost, labels },
      { name: "harness.tokens.chat_tokens", kind: "gauge" as const, help: "A chat's lifetime tokens as the chat app's session rows give them; input counts cache reads and writes.", value: input, labels: { ...labels, kind: "input" } },
      { name: "harness.tokens.chat_tokens", kind: "gauge" as const, help: "A chat's lifetime tokens as the chat app's session rows give them; input counts cache reads and writes.", value: output, labels: { ...labels, kind: "output" } },
    ];
  });
}

/** The newest bytes of a chat's session file a first round reads: the chat server's own TAIL_BYTES (session-tail.ts). */
export const FIRST_TAIL_BYTES = 8 * 1024 * 1024;
/** The messages a thread page holds when it opens, FIRST_PAGE_MESSAGES in session-tail.ts; the ContextMeter's cache health reads these. */
export const PAGE_MESSAGES = 100;
const DAY_MS = 86_400_000;

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } | number };
type Block = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type Entry = { type?: string; timestamp?: string; tokensBefore?: number; summary?: string; content?: unknown;
  message?: { role?: string; content?: unknown; usage?: Usage; stopReason?: string; provider?: string; model?: string; timestamp?: number; command?: string; output?: string } };

/** What a chat's session file says about its context, cache and compactions, kept between rounds. */
export type Tail = {
  offset: number;
  /** Eb() of the newest assistant reply that ended normally: totalTokens, else the four kinds summed. */
  usageTokens: number | null;
  /** Prime's chars / 4 estimate of every context message after that reply. */
  trailingTokens: number;
  /** False after a compaction until a reply with usage, when Prime's getContextUsage gives no tokens. */
  measured: boolean;
  /** input + cache read + cache write of the newest reply that reached the provider (prompt-view.ts lastInputTokens). */
  promptTokens: number | null;
  /** The model of the newest assistant reply, for the context window when the session row names none. */
  model: string | null;
  messages: ThreadMessage[];
  compactions: { at: number; tokensBefore: number }[];
};

export const emptyTail = (): Tail => ({ offset: 0, usageTokens: null, trailingTokens: 0, measured: false, promptTokens: null, model: null, messages: [], compactions: [] });

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const eb = (usage: Usage): number => num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);

/** Prime 0.9.8's nR(): one context message's tokens as ceil(chars / 4), images 4,800 chars. */
export function estimateMessage(role: string, message: { content?: unknown; command?: string; output?: string; summary?: string }): number {
  let chars = 0;
  const blocks = Array.isArray(message.content) ? message.content as Block[] : [];
  if (role === "user") chars = typeof message.content === "string" ? message.content.length : blocks.reduce((sum, b) => sum + (b.type === "text" && b.text ? b.text.length : 0), 0);
  else if (role === "assistant") for (const b of blocks) chars += b.type === "text" ? (b.text ?? "").length : b.type === "thinking" ? (b.thinking ?? "").length : b.type === "toolCall" ? (b.name ?? "").length + (JSON.stringify(b.arguments) ?? "").length : 0;
  else if (role === "custom" || role === "toolResult") chars = typeof message.content === "string" ? message.content.length
    : blocks.reduce((sum, b) => sum + (b.type === "text" && b.text ? b.text.length : 0) + (b.type === "image" ? 4800 : 0), 0);
  else if (role === "bashExecution") chars = (message.command ?? "").length + (message.output ?? "").length;
  else if (role === "branchSummary" || role === "compactionSummary") chars = (message.summary ?? "").length;
  return Math.ceil(chars / 4);
}

/** Folds one session file line into the tail. Only message, custom_message and compaction lines are parsed. */
export function foldLine(tail: Tail, line: string): void {
  if (!line.startsWith('{"type":"message"') && !line.startsWith('{"type":"compaction"') && !line.startsWith('{"type":"custom_message"')) return;
  let entry: Entry;
  try { entry = JSON.parse(line) as Entry; } catch { return; }
  if (entry.type === "compaction") {
    tail.measured = false;
    tail.compactions.push({ at: Date.parse(entry.timestamp ?? ""), tokensBefore: num(entry.tokensBefore) });
    return;
  }
  if (entry.type === "custom_message") { tail.trailingTokens += estimateMessage("custom", entry); return; }
  const message = entry.message;
  if (!message?.role) return;
  if (message.role === "assistant" && message.usage) {
    const usage = message.usage;
    if (message.model) tail.model = message.model;
    const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
    if (prompt > 0) tail.promptTokens = prompt;
    if (message.stopReason !== "aborted" && message.stopReason !== "error" && eb(usage) > 0) {
      tail.usageTokens = eb(usage);
      tail.trailingTokens = 0;
      tail.measured = true;
    } else tail.trailingTokens += estimateMessage("assistant", message);
    const cost = typeof usage.cost === "number" ? usage.cost : num(usage.cost?.total);
    tail.messages.push({ role: "assistant", provider: message.provider ?? "", model: message.model ?? "", timestamp: num(message.timestamp) || Date.parse(entry.timestamp ?? ""),
      usage: { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite), cost } } as unknown as ThreadMessage);
  } else {
    tail.trailingTokens += estimateMessage(message.role, message);
    tail.messages.push({ role: message.role } as unknown as ThreadMessage);
  }
  if (tail.messages.length > PAGE_MESSAGES * 2) tail.messages.splice(0, tail.messages.length - PAGE_MESSAGES);
}

/** Reads what a session file gained since `tail.offset` in 1 MiB chunks; a first read starts FIRST_TAIL_BYTES from the end, at a line start. */
export async function readTail(file: string, tail: Tail, now: number): Promise<Tail> {
  const info = await stat(file).catch(() => null);
  if (!info) return tail;
  if (info.size < tail.offset) tail = emptyTail();
  const first = tail.offset === 0 && info.size > FIRST_TAIL_BYTES;
  let offset = first ? info.size - FIRST_TAIL_BYTES : tail.offset;
  if (offset < info.size) {
    const handle = await open(file, "r");
    try {
      const chunk = Buffer.alloc(1 << 20);
      let carry = "";
      let skip = first;
      let position = offset;
      while (position < info.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const text = carry + chunk.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (skip) { skip = false; continue; }
          foldLine(tail, line);
        }
      }
      offset = position - Buffer.byteLength(carry);
    } finally {
      await handle.close();
    }
  }
  tail.offset = offset;
  tail.compactions = tail.compactions.filter(c => now - c.at < DAY_MS || c === tail.compactions.at(-1));
  return tail;
}

/** A chat's session file on this box: its own path, or the copy the chat host mirrors from another box (host-mirror.ts). */
function localFile(ctx: Context, box: string, file: string): string {
  return box === ctx.host ? file : join(ctx.home, ".cache/sieun-pi/hosts", box, file);
}

/** The ContextMeter ring, cache health and compactions of every chat, from its session file. */
async function chatTails(ctx: Context, chats: { chat: string; box: string; row: Row }[], windows: Map<string, number>): Promise<Sample[]> {
  const samples: Sample[] = [];
  const help = {
    share: "Share of the chat's context window in use, as Prime's getContextUsage counts it (the thread header ring).",
    tokens: "Tokens in the chat's context now, as Prime's getContextUsage counts it.",
    level: "The thread header cache warning of the chat: 0 ok, 1 warn, 2 bad (shared/cache-health.ts cacheHealth over the newest 100 messages).",
    hit: "Cache read share of the chat's prompt: the last call, or the usual (median) warm call.",
    misses: "Warm calls among the chat's last 20 that read under half their prompt from the cache.",
    before: "Tokens in the chat's context before its newest compaction.",
    at: "When the chat last compacted, in epoch seconds.",
    count: "Compactions of the chat in the last 24 h.",
    prompt: "Prompt tokens of the chat's newest call as the provider measured them: input, cache read and cache write.",
  };
  for (const { chat, box, row } of chats) {
    if (!row.file) continue;
    const file = localFile(ctx, box, row.file);
    const slot = `tokens.tail:${file}`;
    const tail = await readTail(file, (ctx.state.get(slot) as Tail | undefined) ?? emptyTail(), ctx.now);
    ctx.state.set(slot, tail);
    const labels = { chat };
    // A session row the daemon has not loaded names no model; its window is the one another row gives the same model.
    const window = row.window || (tail.model ? windows.get(tail.model) ?? 0 : 0);
    if (tail.measured && tail.usageTokens !== null && window > 0) {
      const tokens = tail.usageTokens + tail.trailingTokens;
      samples.push({ name: "harness.tokens.context", kind: "gauge", help: help.tokens, value: tokens, labels },
        { name: "harness.tokens.context_share", kind: "gauge", unit: "1", help: help.share, value: tokens / window, labels });
    }
    if (tail.promptTokens !== null) samples.push({ name: "harness.tokens.prompt_measured", kind: "gauge", help: help.prompt, value: tail.promptTokens, labels });
    const health = cacheHealth(tail.messages.slice(-PAGE_MESSAGES));
    if (health.calls > 0) {
      samples.push({ name: "harness.tokens.cache_level", kind: "gauge", help: help.level, value: { ok: 0, warn: 1, bad: 2 }[health.level], labels },
        { name: "harness.tokens.cache_recent_misses", kind: "gauge", help: help.misses, value: health.recentMisses, labels });
      if (health.last) samples.push({ name: "harness.tokens.cache_hit", kind: "gauge", unit: "1", help: help.hit, value: health.last.hit, labels: { chat, call: "last" } });
      if (health.usualHit !== null) samples.push({ name: "harness.tokens.cache_hit", kind: "gauge", unit: "1", help: help.hit, value: health.usualHit, labels: { chat, call: "usual" } });
    }
    const last = tail.compactions.at(-1);
    if (last) samples.push({ name: "harness.tokens.compaction_tokens_before", kind: "gauge", help: help.before, value: last.tokensBefore, labels },
      { name: "harness.tokens.compaction_time", kind: "gauge", unit: "s", help: help.at, value: last.at / 1000, labels });
    samples.push({ name: "harness.tokens.compactions_24h", kind: "gauge", help: help.count, value: tail.compactions.filter(c => ctx.now - c.at < DAY_MS).length, labels });
  }
  return samples;
}

/** Characters per token of Prime's <skill> blocks and the fixed lines around them, the Tools page's numbers (chat-skills.ts). */
export const SKILL_CHARS_PER_TOKEN = 2.45;
export const SKILLS_HEADER_TOKENS = 146;

/** prompt-view.ts SYSTEM_MARKS, with the part kind each mark opens; text before the first mark is the base system prompt. */
const SYSTEM_MARKS: readonly [string, RegExp][] = [
  ["system", /^# Delegating to sub-agents$/m],
  ["system", /^# Generic MCP Connections$/m],
  ["instructions", /^# Additional Guidance$/m],
  ["instructions", /^# Project Context$/m],
  ["skills", /\n\nThe following skills provide specialized instructions for specific tasks\./],
  ["harness", /^# Continual Harness State$/m],
];

/** One `<skill>` block of Prime's skills list: its name, its SKILL.md path as Prime walked it, and its length. */
export type SkillBlock = { name: string; location: string; chars: number };
export type PromptKinds = { system: number; instructions: number; skills: number; harness: number; tools: number; skillBlocks: SkillBlock[] };

const SKILL_BLOCK = /^ {2}<skill>\n[\s\S]*?\n {2}<\/skill>$/gm;

/** The `<skill>` blocks of a skills list, each as chat-skills.ts skillBlock writes it. */
export function skillBlocks(text: string): SkillBlock[] {
  return [...text.matchAll(SKILL_BLOCK)].map(([block]) => ({ name: /<name>(.*?)<\/name>/.exec(block)?.[1] ?? "", location: /<location>(.*?)<\/location>/.exec(block)?.[1] ?? "", chars: block.length }));
}

/** One system prompt's tokens per part kind as prompt-view.ts systemParts splits it, each part ceil(chars / 4) (estimateTokens). */
export function systemKinds(text: string): Omit<PromptKinds, "tools"> {
  const marks: { at: number; kind: string }[] = [];
  let from = 0;
  for (const [kind, pattern] of SYSTEM_MARKS) {
    const match = pattern.exec(text.slice(from));
    if (!match) continue;
    const raw = from + match.index;
    const at = raw + (match[0].startsWith("\n") ? match[0].length - match[0].trimStart().length : 0);
    marks.push({ at, kind });
    from = at + 1;
  }
  const end = text.indexOf("</available_skills>");
  if (end >= 0) { const after = end + "</available_skills>".length; if (text.slice(after).trim()) marks.push({ at: after, kind: "instructions" }); }
  marks.sort((a, b) => a.at - b.at);
  const out: Omit<PromptKinds, "tools"> = { system: 0, instructions: 0, skills: 0, harness: 0, skillBlocks: [] };
  const head = text.slice(0, marks[0]?.at ?? text.length);
  if (head.trim()) out.system += Math.ceil(head.length / 4);
  marks.forEach((mark, index) => {
    const body = text.slice(mark.at, marks[index + 1]?.at ?? text.length);
    out[mark.kind as "system"] += Math.ceil(body.length / 4);
    if (mark.kind === "skills") out.skillBlocks.push(...skillBlocks(body));
  });
  return out;
}

/**
 * The user texts prompt-view.ts userSource files under instructions ([corrections], [message id: ...]) or harness ([harness-digest], [*-refinement]),
 * found as JSON string values in a captured payload without parsing all of it. A digest stops at its "[compaction-summary]", which is conversation.
 */
const MESSAGE_KINDS = /"(?:text|content)":"\[(harness-digest\]|corrections\]|message id: |[a-z]+-refinement\])/g;

export function messageKinds(text: string): { instructions: number; harness: number } {
  const out = { instructions: 0, harness: 0 };
  for (const match of text.matchAll(MESSAGE_KINDS)) {
    const value = valueAt(text, match.index + match[0].indexOf(":") + 1);
    if (typeof value !== "string") continue;
    const digest = match[1] === "harness-digest]";
    const cut = digest ? value.indexOf("\n\n[compaction-summary]") : -1;
    const body = cut < 0 ? value : value.slice(0, cut);
    out[digest || match[1]!.endsWith("-refinement]") ? "harness" : "instructions"] += Math.ceil(body.length / 4);
  }
  return out;
}

/** The JSON value that starts at `start` in `text`: a string, array or object, cut by depth outside strings; null when it runs past the text. */
export function valueAt(text: string, start: number): unknown {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') { inString = false; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  return null;
}

/** The value of the last `"key":` in `text` that is a key and not part of a string (a quote inside a JSON string is always escaped). */
function lastKey(text: string, key: string, before = text.length): unknown {
  const needle = `"${key}":`;
  for (let at = text.lastIndexOf(needle, before); at > 0; at = text.lastIndexOf(needle, at - 1)) {
    if (text[at - 1] !== "\\") return valueAt(text, at + needle.length);
  }
  return null;
}

/** prompt-view.ts toolParts: each tool's description and its schema printed with two-space indent, ceil(chars / 4) per tool. */
export function toolTokens(tools: unknown): number {
  if (!Array.isArray(tools)) return 0;
  return tools.reduce((sum: number, tool: Record<string, unknown>) => {
    const fn = (tool?.function ?? tool) as Record<string, unknown>;
    const schema = fn?.input_schema ?? fn?.parameters;
    const text = [typeof fn?.description === "string" ? fn.description : "", schema === undefined ? "" : JSON.stringify(schema, null, 2)].filter(Boolean).join("\n\n");
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

/**
 * The system, instructions, skills, harness and tools tokens of a captured provider request (prompt-capture.ts). The system prompt and tools are
 * found from the ends of the file (the Anthropic payload puts them last, OpenAI Responses puts instructions first), and the instructions and
 * harness texts among the messages by their prefix.
 */
export async function captureKinds(file: string): Promise<PromptKinds | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const at = text.indexOf('"instructions":');
    const instructions = at >= 0 && at < 4096 ? valueAt(text, at + '"instructions":'.length) : null;
    const toolsAt = text.lastIndexOf('"tools":');
    const tools = lastKey(text, "tools");
    const system = typeof instructions === "string" ? instructions : lastKey(text, "system", toolsAt > 0 ? toolsAt : text.length);
    // payloadParts: a first system block under 200 chars, before others, is the provider identity line (kind system).
    const blocks = typeof system === "string" ? [system] : Array.isArray(system) ? system.map(block => (block as { text?: unknown })?.text).filter((text): text is string => typeof text === "string") : [];
    if (!blocks.length) return null;
    const out: PromptKinds = { system: 0, instructions: 0, skills: 0, harness: 0, skillBlocks: [], tools: toolTokens(tools) };
    blocks.forEach((block, index) => {
      if (blocks.length > 1 && index === 0 && block.length < 200) { out.system += Math.ceil(block.length / 4); return; }
      const kinds = systemKinds(block);
      for (const key of ["system", "instructions", "skills", "harness"] as const) out[key] += kinds[key];
      out.skillBlocks.push(...kinds.skillBlocks);
    });
    const messages = messageKinds(text);
    out.instructions += messages.instructions;
    out.harness += messages.harness;
    return out;
  } catch {
    return null;
  }
}

/** The Grafana datasource and job of the chat's usage queries (usage/lgtm.ts DATASOURCE and JOB). */
const DATASOURCE = "estate_prometheus_stg";
const JOB = 'job="prime-agent"';
const ALL = `prime_agent_tokens_total{${JOB}}`;
/** The six queries of usage/lgtm.ts Usage.summary, the Settings > Usage feed; `since` is the seconds since the chat's local midnight. */
export const summaryQueries = (since: number): { promql: string; range: boolean }[] => [
  { promql: `sum by (kind) (rate(${ALL}[1m]))`, range: false },
  { promql: `sum by (kind) (increase(${ALL}[1h])) / 60`, range: false },
  { promql: `sum by (kind) (increase(${ALL}[24h]))`, range: false },
  { promql: `sum(increase(prime_agent_cost_USD_total{${JOB}}[${since}s]))`, range: false },
  { promql: `sum by (kind) (rate(${ALL}[1m]))`, range: true },
  { promql: `sum by (kind) (increase(${ALL}[1m]))`, range: true },
];
/**
 * Usage.rates over the last minute: output tokens per second of generation time for every session that made a call. `> 0` drops the idle sessions'
 * 0 / 0, which were 739 of 810 answers on 10-19 and which the reader skipped anyway.
 */
const LIVE_RATES = `sum by (session) (increase(prime_agent_session_output_tokens_total{${JOB}}[1m])) / sum by (session) (increase(prime_agent_session_generation_seconds_total{${JOB}}[1m])) > 0`;
/** How many live agents the Agents card rates go out as, by rank. */
export const TOP_AGENTS = 10;

type Grafana = (path: "query" | "query_range", params: Record<string, string>) => Promise<{ status: number; result: unknown }>;

/** The Grafana proxy call of usage/lgtm.ts grafanaPrometheus, with the token file the chat reads; status 0 is a network failure, 503 no token. */
function grafana(config: string): Grafana {
  return async (path, params) => {
    let url: unknown, token: unknown;
    try { ({ url, token } = JSON.parse(await readFile(config, "utf8")) as Record<string, unknown>); } catch { return { status: 503, result: null }; }
    if (typeof url !== "string" || typeof token !== "string") return { status: 503, result: null };
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/api/datasources/proxy/uid/${DATASOURCE}/api/v1/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => null) as { status?: string; data?: { result?: unknown } } | null;
      return body?.status === "success" && response.ok ? { status: 200, result: body.data?.result } : { status: response.status === 200 ? 502 : response.status, result: null };
    } catch {
      return { status: 0, result: null };
    }
  };
}

/** The chat's local midnight: the chat service runs with TZ=Asia/Seoul, so Usage.summary counts cost today from KST midnight. */
export function secondsSinceKstMidnight(now: number): number {
  const kst = now + 9 * 3_600_000;
  return Math.max(1, Math.floor((kst % 86_400_000) / 1000));
}

/** Whether the six Settings > Usage queries answer as the chat would ask them now, how long they took, and the worst HTTP status. */
async function appQuery(ctx: Context, ask: Grafana): Promise<Sample[]> {
  const started = performance.now();
  const end = ctx.now / 1000;
  const answers = await Promise.all(summaryQueries(secondsSinceKstMidnight(ctx.now)).map(({ promql, range }) => range
    ? ask("query_range", { query: promql, start: String(end - (promql.includes("rate(") ? 600 : 3600)), end: String(end), step: promql.includes("rate(") ? "10" : "60" })
    : ask("query", { query: promql, time: String(end) })));
  const failed = answers.filter(answer => answer.status !== 200);
  return [
    { name: "harness.tokens.app_usage_query_ok", kind: "gauge", help: "1 when the six queries of Settings > Usage (usage/lgtm.ts Usage.summary) all answer from LGTM.", value: failed.length ? 0 : 1 },
    { name: "harness.tokens.app_usage_query_failed", kind: "gauge", help: "How many of the six Settings > Usage queries failed this round.", value: failed.length },
    { name: "harness.tokens.app_usage_query_duration", kind: "gauge", unit: "s", help: "How long the six Settings > Usage queries took together.", value: (performance.now() - started) / 1000 },
    ...failed.length ? [{ name: "harness.tokens.app_usage_query_status", kind: "gauge" as const, help: "The HTTP status of a failed Settings > Usage query: 0 no answer, 503 no Grafana token.", value: failed[0]!.status }] : [],
  ];
}

/** The chat a session belongs to: itself, its parent chain's top, or the chat chat-jobs.json gives that top. */
export function chatOf(id: string, rows: Rows, byId: Map<string, Row>, names: Map<string, string>): string | null {
  const seen = new Set<string>();
  let row = byId.get(id);
  while (row?.parent && !seen.has(row.id) && !rows.ids.includes(row.id)) { seen.add(row.id); row = byId.get(row.parent) ?? undefined; }
  if (!row) return null;
  if (rows.ids.includes(row.id)) return names.get(row.id) ?? null;
  const job = rows.jobs[row.id] ?? (row.name ? rows.jobs[row.name] : undefined);
  if (!job) return null;
  return job.chatId ? names.get(job.chatId) ?? job.chat ?? null : job.chat ?? null;
}

/** The Agents card rates: the TOP_AGENTS fastest sessions of the last minute by rank, named by session and chat. */
async function agentRates(ask: Grafana, rows: Rows, chats: { id: string; chat: string }[]): Promise<Sample[]> {
  const answer = await ask("query", { query: LIVE_RATES });
  if (answer.status !== 200 || !Array.isArray(answer.result)) return [];
  const byId = new Map<string, Row>();
  for (const { rows: list } of rows.boxes) for (const row of list) if (!byId.has(row.id)) byId.set(row.id, row);
  const names = new Map(chats.map(chat => [chat.id, chat.chat]));
  const live = (answer.result as { metric?: { session?: string }; value?: [number, string] }[])
    .map(item => ({ session: item.metric?.session ?? "", tps: Number(item.value?.[1]) }))
    .filter(item => item.session && Number.isFinite(item.tps))
    .sort((a, b) => b.tps - a.tps);
  const help = "Output tokens per second of generation time over the last minute of the fastest live agents, as the Agents card rates them (usage/lgtm.ts Usage.rates).";
  return [
    { name: "harness.tokens.live_agents", kind: "gauge", help: "Sessions that finished a model call in the last minute, on every box.", value: live.length },
    ...live.slice(0, TOP_AGENTS).map((item, index) => ({ name: "harness.tokens.agent_output_tps", kind: "gauge" as const, help, value: Math.round(item.tps * 10) / 10,
      labels: { rank: String(index + 1), agent: byId.get(item.session)?.name ?? item.session.slice(0, 8), chat: chatOf(item.session, rows, byId, names) ?? "none" } })),
  ];
}

type Chat = { id: string; chat: string; box: string; row: Row };

/** The chats of chats.json that a session copy lists, named as the chat app names them. */
function chatList({ ids, boxes }: Rows): Chat[] {
  const byId = new Map<string, { box: string; row: Row }>();
  for (const { box, rows } of boxes) for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, { box, row });
  return ids.flatMap(id => { const found = byId.get(id); return found ? [{ id, chat: found.row.name ?? id.slice(0, 8), ...found }] : []; });
}

const captureFile = (ctx: Context, id: string) => join(ctx.home, ".prime/agent/browser-chat/prompts", `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/** The Prompt view's tokens per part kind of each chat's newest captured request, and the Tools page's skills tokens of that prompt. */
async function chatPrompts(ctx: Context, chats: Chat[], measured: Map<string, number>): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const { id, chat } of chats) {
    const kinds = await cached(ctx, captureFile(ctx, id), captureKinds, null);
    if (!kinds) continue;
    const parts: Record<string, number> = { system: kinds.system, instructions: kinds.instructions, skills: kinds.skills, harness: kinds.harness, tools: kinds.tools };
    const prompt = measured.get(chat);
    if (prompt !== undefined) parts.conversation = Math.max(0, prompt - Object.values(parts).reduce((a, b) => a + b, 0));
    for (const [part, value] of Object.entries(parts)) samples.push({ name: "harness.tokens.prompt_part", kind: "gauge", value, labels: { chat, part },
      help: "Tokens of the chat's newest prompt by part as the Prompt view estimates them (chars / 4); conversation is the measured prompt minus the other parts." });
    samples.push({ name: "harness.tokens.skills", kind: "gauge", value: skillTokens(ctx.home, kinds.skillBlocks).total, labels: { chat },
      help: "Tokens the skills list adds to the chat's prompt, counted as the Tools page counts them (chat-skills.ts)." });
  }
  return samples;
}

type SkillGroup = "global" | "built-in" | "repo";

/** chat-skills.ts sources by where Prime found the SKILL.md: ~/.prime/agent/skills or ~/.agents/skills, a Prime release's skills/, else the repo. */
export function skillGroup(home: string, location: string): SkillGroup {
  if ([".prime/agent/skills/", ".agents/skills/"].some(dir => location.startsWith(`${home}/${dir}`))) return "global";
  return location.includes("/prime-agent/releases/") ? "built-in" : "repo";
}

/** The Tools page count of a skills list: each block's chars over 2.45, rounded per skill, plus the fixed header lines when any block is listed. */
export function skillTokens(home: string, blocks: readonly SkillBlock[]): { total: number; groups: Record<SkillGroup | "header", number>; skills: { name: string; group: SkillGroup; tokens: number }[] } {
  const skills = blocks.map(block => ({ name: block.name, group: skillGroup(home, block.location), tokens: Math.round(block.chars / SKILL_CHARS_PER_TOKEN) }));
  const groups = { global: 0, "built-in": 0, repo: 0, header: skills.length ? SKILLS_HEADER_TOKENS : 0 };
  for (const skill of skills) groups[skill.group] += skill.tokens;
  return { total: groups.global + groups["built-in"] + groups.repo + groups.header, groups, skills };
}

/** How many of the newest session files firstPrompt reads (chat-skills.ts FIRST_PROMPT_SCAN). */
export const FIRST_PROMPT_SCAN = 200;

type FirstUsage = { tokens: number; at: number } | "no" | "wait";

/**
 * chat-skills.ts firstUsage with its null split in two: "no" for a child session, another cwd or a first reply without usage, which stays so,
 * and "wait" for a session with no reply yet or a line still being written, which a later round reads again.
 */
export async function firstUsage(file: string, cwd: string): Promise<FirstUsage> {
  for await (const line of fileLines(file)) {
    let entry: { type?: string; cwd?: string; parentSession?: string; message?: { role?: string; timestamp?: number; usage?: Record<string, unknown> } };
    try { entry = JSON.parse(line) as typeof entry; } catch { return "wait"; }
    if (entry.type === "session") { if (entry.cwd !== cwd || entry.parentSession) return "no"; continue; }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = entry.message.usage ?? {};
    const tokens = ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (typeof usage[key] === "number" ? usage[key] : 0), 0);
    return tokens > 0 && typeof entry.message.timestamp === "number" ? { tokens, at: entry.message.timestamp } : "no";
  }
  return "wait";
}

type FirstScan = { dirKey: string; names: string[]; no: Set<string>; waits: Map<string, number>; found: { sessionId: string; tokens: number; at: number } | null };

/**
 * chat-skills.ts firstPrompt, kept between rounds: the newest root session started in `cwd` whose first reply has usage. The folder is listed
 * again only after its mtime moved, a "no" file is never read again, and a "wait" file only after it grew.
 */
export async function firstPrompt(state: Map<string, unknown>, dir: string, cwd: string): Promise<FirstScan["found"]> {
  const info = await stat(dir).catch(() => null);
  if (!info) return null;
  const scan = (state.get("tokens.firstPrompt") as FirstScan | undefined) ?? { dirKey: "", names: [], no: new Set<string>(), waits: new Map<string, number>(), found: null };
  state.set("tokens.firstPrompt", scan);
  if (scan.dirKey !== String(info.mtimeMs)) {
    scan.names = (await readdir(dir)).filter(name => name.endsWith(".jsonl")).sort().reverse().slice(0, FIRST_PROMPT_SCAN);
    scan.dirKey = String(info.mtimeMs);
    const listed = new Set(scan.names);
    for (const name of scan.no) if (!listed.has(name)) scan.no.delete(name);
    for (const name of scan.waits.keys()) if (!listed.has(name)) scan.waits.delete(name);
  }
  let found: FirstScan["found"] = null;
  for (const name of scan.names) {
    const sessionId = name.slice(0, -".jsonl".length);
    if (scan.found?.sessionId === sessionId) { found = scan.found; break; }
    if (scan.no.has(name)) continue;
    const size = (await stat(join(dir, name)).catch(() => null))?.size ?? -1;
    if (scan.waits.get(name) === size) continue;
    const usage = await firstUsage(join(dir, name), cwd).catch(() => "wait" as const);
    if (usage === "no") { scan.no.add(name); scan.waits.delete(name); continue; }
    if (usage === "wait") { scan.waits.set(name, size); continue; }
    scan.waits.delete(name);
    found = { sessionId, ...usage };
    break;
  }
  scan.found = found;
  return found;
}

/**
 * The Settings > Tools and skills numbers (chat-skills.ts skillsView): the tokens the skills list adds to a new session in the repo, by group and
 * by skill, and that session's measured first prompt. The list is the one Prime sent in that session's captured request, read once per session.
 */
async function toolsPage(ctx: Context): Promise<Sample[]> {
  const repo = process.env.HARNESS_REPO || join(ctx.home, "Documents/Github/auto-sns-agent");
  const first = await firstPrompt(ctx.state, join(ctx.home, ".prime/agent/sessions"), repo);
  if (!first) return [];
  const samples: Sample[] = [{ name: "harness.tokens.first_prompt", kind: "gauge", value: first.tokens,
    help: "Prompt tokens of the first call of the newest root session started in the repo, input plus cache read and write (chat-skills.ts firstPrompt)." }];
  let held = ctx.state.get("tokens.firstSkills") as { sessionId: string; blocks: SkillBlock[] } | undefined;
  if (held?.sessionId !== first.sessionId) {
    const kinds = await captureKinds(captureFile(ctx, first.sessionId));
    held = kinds ? { sessionId: first.sessionId, blocks: kinds.skillBlocks } : undefined;
    if (held) ctx.state.set("tokens.firstSkills", held);
  }
  if (!held) return samples;
  const { groups, skills } = skillTokens(ctx.home, held.blocks);
  for (const [group, value] of Object.entries(groups)) samples.push({ name: "harness.tokens.skills_group", kind: "gauge", value, labels: { group },
    help: "Tokens the skills list adds to every new session in the repo, by the Tools page's groups; header is the fixed lines around the list." });
  for (const skill of skills) samples.push({ name: "harness.tokens.skill", kind: "gauge", value: skill.tokens, labels: { skill: skill.name, group: skill.group },
    help: "Tokens one skill's entry adds to every new session in the repo, its block's chars over 2.45 as the Tools page counts it." });
  return samples;
}

export async function read(ctx: Context): Promise<Sample[]> {
  if (!ctx.chatHost) return feedHealth(ctx);
  const ask = grafana(join(ctx.home, ".prime/agent/browser-chat/grafana-alerts.json"));
  const rowsLoaded = loadRows(ctx);
  const [health, app, rows] = await Promise.all([feedHealth(ctx), appQuery(ctx, ask), rowsLoaded]);
  const chats = chatList(rows);
  const windows = new Map<string, number>();
  for (const { rows: list } of rows.boxes) for (const row of list) if (row.model && row.window > 0) windows.set(row.model, row.window);
  const [agents, tails] = await Promise.all([agentRates(ask, rows, chats), chatTails(ctx, chats, windows)]);
  const measured = new Map(tails.filter(s => s.name === "harness.tokens.prompt_measured").map(s => [s.labels!.chat!, s.value]));
  const [prompts, tools] = await Promise.all([chatPrompts(ctx, chats, measured), toolsPage(ctx)]);
  return [...health, ...costs(ctx, rows), ...app, ...agents, ...tails, ...prompts, ...tools];
}
