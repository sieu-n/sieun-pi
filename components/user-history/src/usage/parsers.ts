import type { UsageCall, UsageSource } from "../shared/usage.ts";
import type { Needle } from "./reader.ts";

/**
 * One parser per transcript format. Each rule is ported from tokscale's own parser
 * (github.com/junhoyeo/tokscale, crates/tokscale-core/src/sessions/, read at d4d1c75), cited per parser below.
 * A parser sees only lines that passed its needles, in file order, and keeps a small JSON state so a later read can
 * continue from the stored offset. `line()` returns the calls a line produced.
 */
export type ParserState = Record<string, unknown>;
export interface LineParser {
  line(text: string, lineOffset: number): UsageCall[];
  /** Called after each read; returns calls held back (Codex rows still waiting for a model). */
  finish(): UsageCall[];
  state(): ParserState;
}
/**
 * `version`: bump it with any change to what a parser emits. The next start deletes that source's calls and file
 * checkpoints and reads only that source again (UsageStore.resetSources); the other sources keep their rows.
 */
export type ParserSpec = { version: string; needles: Needle[]; create(context: ParseContext, saved: ParserState | null): LineParser };
export type ParseContext = { source: UsageSource; path: string; fileId: string; fallbackTime: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const time = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
function parse(line: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(line); return isRecord(value) ? value : null; } catch { return null; }
}

/**
 * Prime Agent and Pi: the Pi append-only record format. Port of sessions/pi.rs (`pi_emitted_record`,
 * `parse_pi_format_file_inner`) and sessions/prime_agent.rs:
 * - the first record must be the `session` header (a leading `title` record is allowed), else the file is not a transcript;
 * - a call is a `message` entry whose `message.role` is `assistant` with `usage` and `model`;
 * - tokens are usage input, output, cacheRead, cacheWrite; `reasoning` is a subset of output and is not added;
 * - an RLM child (header `rlmDepth > 0`) with a missing or unparsable entry timestamp is skipped;
 * - `child_usage_attributed` records are bookkeeping and never become calls: each child transcript is read on its own.
 *   tokscale also reverses a parent aggregate that a fork may persist; 33,031 attributions on this Mac all point at a
 *   message carrying its own usage (not the aggregate), so that reversal is not ported.
 * - the call id is `message.responseId`, else the entry id with its timestamp, so fork copies collapse.
 * Prime Agent also records the price it charged in `usage.cost.total`; that is kept as the call's cost.
 */
export const piFormat: ParserSpec = {
  version: "1",
  needles: [{ text: '"type":"session"', within: 1 }, { text: '"type":"title"', within: 1 }, { text: '"role":"assistant"', within: 320 }],
  create(context, saved) {
    const state = { header: false, bad: false, sessionId: null as string | null, cwd: null as string | null, child: false, ...(saved ?? {}) };
    return {
      line(line) {
        if (state.bad) return [];
        const entry = parse(line);
        if (!state.header) {
          if (entry?.type === "title") return [];
          if (entry?.type !== "session") { state.bad = true; return []; }
          state.header = true;
          state.sessionId = text(entry.id);
          state.cwd = text(entry.cwd);
          state.child = typeof entry.rlmDepth === "number" && entry.rlmDepth > 0;
          return [];
        }
        if (!entry || entry.type !== "message" || !isRecord(entry.message)) return [];
        const message = entry.message;
        if (message.role !== "assistant" || !isRecord(message.usage)) return [];
        const model = typeof message.model === "string" ? message.model : null;
        if (model === null) return [];
        const endedAt = time(entry.timestamp);
        if (state.child && endedAt === null) return [];
        const usage = message.usage;
        const cost = isRecord(usage.cost) && typeof usage.cost.total === "number" && Number.isFinite(usage.cost.total) && usage.cost.total >= 0 ? usage.cost.total : null;
        const entryId = text(entry.id);
        const callId = text(message.responseId) ?? (entryId ? `msg:${entryId}:${endedAt ?? "missing"}` : null);
        if (callId === null) return [];
        return [{
          source: context.source, callId, sessionId: state.sessionId, endedAt: endedAt ?? context.fallbackTime,
          startedAt: typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : null,
          provider: text(message.provider), model: model || "unknown",
          input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), reasoning: 0,
          costUsd: cost, cwd: state.cwd,
        }];
      },
      finish: () => [],
      state: () => ({ ...state }),
    };
  },
};

/**
 * Claude Code `~/.claude/projects/**\/*.jsonl`. Port of sessions/claudecode.rs (`parse_claude_file_with_cache_and_home`):
 * - a call is an `assistant` entry with `message.usage` and `message.model`; the local `<synthetic>` notice is no call;
 * - the id is `message.id:requestId` (or `message:<id>` without a request id); streamed copies of one message merge by
 *   the larger value per token field (the store does that on conflict), across files too, so resumed and compacted
 *   transcripts that rewrite their file in place never count twice, and rows that vanish from a rewritten file stay;
 * - tokens are input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens;
 * - the request start is the timestamp of the last `user` or `tool_result` entry before the reply (tokscale dates the
 *   call there; here it is `startedAt`, and `endedAt` is the assistant entry's own timestamp).
 * Tool results that declare their own token counts (no current Claude Code build writes them) are not read.
 */
export const claudeCode: ParserSpec = {
  version: "1",
  needles: [{ text: '"type":"assistant"' }, { text: '"type":"user"' }, { text: '"type":"tool_result"' }],
  create(context, saved) {
    const state = { pending: null as number | null, ...(saved ?? {}) };
    return {
      line(line, lineOffset) {
        const entry = parse(line);
        if (!entry) return [];
        if (entry.type === "user" || entry.type === "tool_result") {
          const at = time(entry.timestamp);
          if (at !== null) state.pending = at;
          return [];
        }
        if (entry.type !== "assistant" || !isRecord(entry.message)) return [];
        const message = entry.message;
        const model = typeof message.model === "string" ? message.model : null;
        if (model !== null && model.trim().toLowerCase() === "<synthetic>") { state.pending = null; return []; }
        if (!isRecord(message.usage) || model === null) return [];
        const usage = message.usage;
        const messageId = text(message.id), requestId = text(entry.requestId);
        const callId = messageId ? (requestId ? `${messageId}:${requestId}` : `message:${messageId}`) : `line:${context.fileId}:${lineOffset}`;
        const endedAt = time(entry.timestamp) ?? context.fallbackTime;
        const startedAt = state.pending !== null && state.pending <= endedAt ? state.pending : null;
        state.pending = null;
        return [{
          source: context.source, callId, sessionId: text(entry.sessionId), endedAt, startedAt,
          provider: text(message.provider_id) ?? text(entry.providerId) ?? "anthropic", model,
          input: count(usage.input_tokens), output: count(usage.output_tokens), cacheRead: count(usage.cache_read_input_tokens),
          cacheWrite: count(usage.cache_creation_input_tokens), reasoning: 0, costUsd: null, cwd: text(entry.cwd),
        }];
      },
      finish: () => [],
      state: () => ({ ...state }),
    };
  },
};

type Totals = { input: number; output: number; cached: number; reasoning: number };
const totalsOf = (usage: unknown): Totals | null => isRecord(usage) ? {
  input: count(usage.input_tokens), output: count(usage.output_tokens),
  cached: Math.max(count(usage.cached_input_tokens), count(usage.cache_read_input_tokens)), reasoning: count(usage.reasoning_output_tokens),
} : null;
const sameTotals = (a: Totals, b: Totals) => a.input === b.input && a.output === b.output && a.cached === b.cached && a.reasoning === b.reasoning;
const sumTotals = (t: Totals) => t.input + t.output + t.cached + t.reasoning;
const within = (t: Totals, b: Totals) => t.input <= b.input && t.output <= b.output && t.cached <= b.cached && t.reasoning <= b.reasoning;
function deltaFrom(t: Totals, p: Totals): Totals | null {
  if (t.input < p.input || t.output < p.output || t.cached < p.cached || t.reasoning < p.reasoning) return null;
  return { input: t.input - p.input, output: t.output - p.output, cached: t.cached - p.cached, reasoning: t.reasoning - p.reasoning };
}
function staleRegression(current: Totals, previous: Totals, last: Totals): boolean {
  const p = sumTotals(previous), c = sumTotals(current), l = sumTotals(last);
  if (p <= 0 || c <= 0 || l <= 0) return false;
  return c * 100 >= p * 98 || c + l * 2 >= p;
}
/** Codex `reasoning_output_tokens` is a subset of output and cached input a subset of input; tokscale splits both out. */
function tokensOf(t: Totals) {
  const cached = Math.max(0, Math.min(t.cached, t.input));
  const reasoning = Math.max(0, Math.min(t.reasoning, t.output));
  return { input: Math.max(0, t.input - cached), output: Math.max(0, t.output - reasoning), cacheRead: cached, reasoning };
}
function uuidV7Key(id: string): string | null {
  const parts = id.split("-");
  if (parts.length !== 5 || parts[0]!.length !== 8 || parts[1]!.length !== 4 || parts[2]!.length !== 4 || parts[3]!.length !== 4 || parts[4]!.length !== 12 || !parts[2]!.startsWith("7")) return null;
  const key = parts.join("").toLowerCase();
  return /^[0-9a-f]{32}$/.test(key) ? key : null;
}
const infoModel = (info: unknown) => isRecord(info) ? text(info.model) ?? text(info.model_name) : null;
const payloadModel = (payload: Record<string, unknown>) =>
  (isRecord(payload.model_info) ? text(payload.model_info.slug) : null) ?? text(payload.model) ?? text(payload.model_name) ?? infoModel(payload.info);

type CodexState = {
  model: string | null; previous: Totals | null; lastAccepted: number | null; metaId: string | null; forkedFrom: string | null;
  childId: string | null; replayId: string | null; waiting: boolean; baseline: Totals | null; baselineReported: number | null;
  taskTurns: string[]; userFork: boolean; provider: string | null; cwd: string | null;
};

/**
 * Codex `~/.codex/sessions/**` and `~/.codex/archived_sessions/**` rollout files. Port of sessions/codex.rs
 * (`parse_codex_reader`, `CodexTotals`, `codex_token_count_dedup_key`, the forked-child replay gate):
 * - a call is an `event_msg` `token_count` with `info`; `last_token_usage` is the increment and `total_token_usage`
 *   the cumulative snapshot used only to drop repeats and stale regressions;
 * - the model comes from the payload, else `turn_context`; rows before any model wait for one, else become "unknown";
 * - a forked child (session_meta with `forked_from_id` or `source.subagent.thread_spawn.parent_thread_id`) replays its
 *   parent's history first; those rows are skipped until the child's own `turn_context`, then until totals pass the
 *   inherited baseline;
 * - the call id is the cumulative total scoped to the fork parent (or the session), so sibling replays collapse;
 *   without a total it is the timestamp and tokens;
 * - `startedAt` is the previous token_count or the turn start (tokscale dates the call there), `endedAt` the event.
 */
export const codex: ParserSpec = {
  version: "1",
  needles: ["session_meta", "turn_context", "task_started", "token_count"].map(type => ({ text: `"type":"${type}"`, within: 120 })),
  create(context, saved) {
    const fileSession = /rollout-.{19}-(.+)$/.exec(context.path.replace(/\.jsonl$/, "").split("/").pop() ?? "")?.[1] ?? context.path;
    const state: CodexState = { model: null, previous: null, lastAccepted: null, metaId: null, forkedFrom: null, childId: null, replayId: null, waiting: false,
      baseline: null, baselineReported: null, taskTurns: [], userFork: false, provider: null, cwd: null, ...(saved as Partial<CodexState> | null ?? {}) };
    let pending: UsageCall[] = [];
    const flush = (model: string): UsageCall[] => {
      const out = pending.map(call => ({ ...call, model }));
      pending = [];
      return out;
    };
    const childTurnStarts = (turnId: string | null): boolean => {
      if (state.replayId === null || state.childId === null) return true;
      const childKey = uuidV7Key(state.childId);
      if (turnId === null || childKey === null) return true;
      const turnKey = uuidV7Key(turnId);
      if (turnKey === null) return state.userFork || state.taskTurns.includes(turnId);
      const a = turnKey.slice(0, 12), b = childKey.slice(0, 12);
      return a > b ? true : a < b ? false : state.userFork || state.taskTurns.includes(turnId);
    };
    const childTaskStarts = (turnId: string | null, startedAt: number | null): boolean => {
      if (turnId === null || state.childId === null) return false;
      const childKey = uuidV7Key(state.childId);
      if (childKey === null) return true;
      const turnKey = uuidV7Key(turnId);
      if (turnKey !== null) return turnKey.slice(0, 12) >= childKey.slice(0, 12);
      if (startedAt === null) return false;
      return startedAt >= Math.floor(parseInt(childKey.slice(0, 12), 16) / 1000);
    };
    return {
      line(line) {
        const entry = parse(line);
        if (!entry || !isRecord(entry.payload)) return [];
        const payload = entry.payload;
        const type = entry.type, kind = payload.type;
        const isTokenCount = type === "event_msg" && kind === "token_count";
        const turnId = text(payload.turn_id);
        const out: UsageCall[] = [];
        if (state.waiting) {
          if (type === "turn_context" && childTurnStarts(turnId)) {
            state.waiting = false; state.replayId = null; state.taskTurns = []; state.userFork = false;
            if (state.childId) state.metaId = state.childId;
            state.model = payloadModel(payload);
          } else {
            if (type === "event_msg" && kind === "task_started") {
              const startedAt = typeof payload.started_at === "number" ? Math.trunc(payload.started_at) : null;
              if (turnId !== null && childTaskStarts(turnId, startedAt)) state.taskTurns.push(turnId);
            }
            if (type === "session_meta") {
              const id = text(payload.id);
              if (id !== null && state.childId !== null && state.childId !== id) state.replayId = id;
            }
            if (isTokenCount && isRecord(payload.info)) {
              const total = totalsOf(payload.info.total_token_usage);
              if (total) {
                state.previous = total; state.baseline = total;
                const reported = isRecord(payload.info.total_token_usage) ? payload.info.total_token_usage.total_tokens : null;
                state.baselineReported = typeof reported === "number" && reported >= 0 ? reported : null;
              }
            }
            return [];
          }
        }
        if (type === "session_meta") {
          const id = text(payload.id);
          if (id) state.metaId = id;
          const source = payload.source;
          const spawnParent = isRecord(source) && isRecord(source.subagent) && isRecord(source.subagent.thread_spawn) ? text(source.subagent.thread_spawn.parent_thread_id) : null;
          const forkedFrom = text(payload.forked_from_id) ?? spawnParent;
          if (forkedFrom) {
            const repeated = !state.waiting && id !== null && state.childId === id;
            state.forkedFrom = forkedFrom;
            state.childId = id;
            if (!repeated) {
              state.waiting = true; state.replayId = null; state.baseline = null; state.baselineReported = null; state.taskTurns = [];
              state.userFork = payload.thread_source === "user";
            }
          }
          const provider = text(payload.model_provider);
          if (provider) state.provider = provider;
          const cwd = text(payload.cwd);
          if (cwd) state.cwd = cwd;
          return [];
        }
        if (type === "turn_context") {
          state.model = payloadModel(payload);
          if (!state.model && pending.length) out.push(...flush("unknown"));
          state.lastAccepted = time(entry.timestamp);
          if (state.model) out.push(...flush(state.model));
          return out;
        }
        if (type === "event_msg" && kind === "task_started") {
          if (pending.length) out.push(...flush("unknown"));
          state.lastAccepted = typeof payload.started_at === "number" ? Math.trunc(payload.started_at) * 1000 : time(entry.timestamp);
          return out;
        }
        if (!isTokenCount || !isRecord(payload.info)) return out;
        const info = payload.info;
        const model = payloadModel(payload) ?? infoModel(info) ?? state.model;
        if (model) { state.model = model; out.push(...flush(model)); }
        const total = totalsOf(info.total_token_usage), last = totalsOf(info.last_token_usage);
        // Forked children can replay more parent rows after their first turn_context; skip until totals pass the baseline.
        const reported = isRecord(info.total_token_usage) && typeof info.total_token_usage.total_tokens === "number" && info.total_token_usage.total_tokens >= 0 ? info.total_token_usage.total_tokens : null;
        if (reported !== null && state.baselineReported !== null && reported <= state.baselineReported) return out;
        if (total && state.baseline && within(total, state.baseline)) return out;
        state.baseline = null; state.baselineReported = null;
        let increment: Totals, next: Totals | null;
        const previous = state.previous;
        if (total && last && previous) {
          if (sameTotals(total, previous)) return out;
          if (deltaFrom(total, previous) === null && staleRegression(total, previous, last)) return out;
          increment = last; next = total;
        } else if (total && last) { increment = last; next = total; }
        else if (total && previous) {
          if (sameTotals(total, previous)) return out;
          const delta = deltaFrom(total, previous);
          if (!delta) { state.previous = total; return out; }
          increment = delta; next = total;
        } else if (total) { increment = total; next = total; }
        else if (last && previous) { increment = last; next = { input: previous.input + last.input, output: previous.output + last.output, cached: previous.cached + last.cached, reasoning: previous.reasoning + last.reasoning }; }
        else if (last) { increment = last; next = null; }
        else return out;
        const tokens = tokensOf(increment);
        if (tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0 && tokens.reasoning === 0) return out;
        state.previous = next;
        const parsed = time(entry.timestamp);
        const endedAt = parsed ?? context.fallbackTime;
        const startedAt = state.lastAccepted !== null && state.lastAccepted < endedAt ? state.lastAccepted : null;
        const provider = state.provider ?? (model && /^(gpt|o\d|codex)/i.test(model) ? "openai" : null) ?? "openai";
        const scope = state.forkedFrom ?? state.metaId ?? fileSession;
        const modelKey = model ?? "unknown";
        const callId = total ? `total:${scope}:${provider}:${modelKey}:${total.input}:${total.output}:${total.cached}:${total.reasoning}`
          : `tc:${state.lastAccepted ?? endedAt}:${provider}:${modelKey}:${tokens.input}:${tokens.output}:${tokens.cacheRead}:0:${tokens.reasoning}`;
        if (parsed !== null && (state.lastAccepted === null || parsed > state.lastAccepted)) state.lastAccepted = parsed;
        const call: UsageCall = { source: context.source, callId, sessionId: state.metaId ?? fileSession, endedAt, startedAt, provider, model: model ?? "unknown",
          input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: 0, reasoning: tokens.reasoning, costUsd: null, cwd: state.cwd };
        if (model) out.push(call); else pending.push(call);
        return out;
      },
      finish: () => flush("unknown"),
      state: () => ({ ...state }),
    };
  },
};
