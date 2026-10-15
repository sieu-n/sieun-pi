import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { cacheHitShare } from "../../src/shared/cache-health.ts";
import type { FlaggedSlice } from "../../src/shared/chat-duties.ts";
import { readAppended, type Needle } from "../../src/usage/reader.ts";
import { fileRoots } from "../../src/usage/sources.ts";

/**
 * The prompt cache read share for the Skills and harness duty (owner c41: "measures the hourly and daily cache read ratio and flags a drop").
 * Share = cache read / (input + cache read + cache write) over the Prime Agent calls the Usage page counts: the same transcript files
 * (src/usage/sources.ts) and the same call rules as its parser (an assistant message with usage and a model, one row per response id).
 * When a share is under its target, the duty job gets the sessions that lost the most cache in warm breaks, with what came right before.
 */

const HOUR = 60 * 60_000;
export const WINDOWS = { cache_read_ratio_1h: HOUR, cache_read_ratio_24h: 24 * HOUR } as const;
export type CacheMetric = keyof typeof WINDOWS;
/** A window with fewer calls is no data: the metric reads 100 and a flagged line says so. */
export const MIN_CALLS = 20;
/** A warm break: same session and model, at most this long after the call before, writing more than half that call's prompt to cache. */
export const WARM_GAP_MS = 5 * 60_000;
const TOP = 3;
/** Entries the model never sees; they are not named as the thing before a break. */
const UNSEEN = new Set(["git_state", "child_usage_attributed", "session_state", "agent_status", "session_info", "thread_goal_state"]);

export interface Call {
  id: string; endedAt: number; startedAt: number | null; provider: string | null; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  /** The entries the model saw between the call before and this one, oldest first: an entry type, or a custom entry's customType, or `user`. */
  before: string[];
}
export interface SessionCalls { id: string; title: string; calls: Call[] }
export interface WarmBreak { session: SessionCalls; call: Call; cacheWrite: number; after: string }

const prompt = (call: Call) => call.input + call.cacheRead + call.cacheWrite;
const share = (calls: readonly Call[]) => {
  const hit = cacheHitShare(calls.reduce((sum, call) => ({ input: sum.input + call.input, cacheRead: sum.cacheRead + call.cacheRead, cacheWrite: sum.cacheWrite + call.cacheWrite }), { input: 0, cacheRead: 0, cacheWrite: 0 }));
  return hit === null ? 100 : Math.round(1000 * hit) / 10;
};

/** Each call once (fork copies share a response id), dropping error calls with no tokens and providers that report no cache at all in the window. */
export function windowCalls(sessions: readonly SessionCalls[], from: number, to: number): Call[] {
  const seen = new Map<string, Call>();
  for (const session of sessions) for (const call of session.calls) {
    if (call.endedAt <= from || call.endedAt > to || seen.has(call.id) || prompt(call) + call.output === 0) continue;
    seen.set(call.id, call);
  }
  const caching = new Set([...seen.values()].filter(call => call.cacheRead + call.cacheWrite > 0).map(call => call.provider));
  return [...seen.values()].filter(call => caching.has(call.provider));
}

/** Warm breaks whose call ended in the window, each break call once. */
export function warmBreaks(sessions: readonly SessionCalls[], from: number, to: number): WarmBreak[] {
  const found = new Map<string, WarmBreak>();
  for (const session of sessions) {
    const calls = [...session.calls].sort((a, b) => a.endedAt - b.endedAt);
    for (let at = 1; at < calls.length; at++) {
      const last = calls[at - 1]!, call = calls[at]!;
      if (call.endedAt <= from || call.endedAt > to || found.has(call.id) || call.model !== last.model) continue;
      if ((call.startedAt ?? call.endedAt) - last.endedAt > WARM_GAP_MS || call.cacheWrite <= prompt(last) / 2) continue;
      found.set(call.id, { session, call, cacheWrite: call.cacheWrite, after: call.before.at(-1) ?? "tool results only" });
    }
  }
  return [...found.values()];
}

/** One line per session with the most warm-break cache writes, top 3: its title and id, model, breaks, tokens, and what came before them. */
export function breakLines(breaks: readonly WarmBreak[]): string[] {
  const bySession = new Map<string, WarmBreak[]>();
  for (const item of breaks) bySession.set(item.session.id, [...(bySession.get(item.session.id) ?? []), item]);
  return [...bySession.values()]
    .map(items => ({ items, tokens: items.reduce((sum, item) => sum + item.cacheWrite, 0) }))
    .sort((a, b) => b.tokens - a.tokens).slice(0, TOP)
    .map(({ items, tokens }) => {
      const { session, call } = items[0]!;
      const after = new Map<string, number>();
      for (const item of items) after.set(item.after, (after.get(item.after) ?? 0) + 1);
      const causes = [...after].sort((a, b) => b[1] - a[1]).map(([what, count]) => `${what} x${count}`).join(", ");
      return `${session.title} (${session.id}, ${call.model}): ${items.length} warm breaks wrote ${(tokens / 1e6).toFixed(1)}M cache tokens; right before: ${causes}`;
    });
}

/** Both shares, and for a share under its target the top warm-break sessions in that window. */
export function measureCache(sessions: readonly SessionCalls[], now: number, targets: Record<CacheMetric, number>): { metrics: Record<CacheMetric, number>; flagged: FlaggedSlice[] } {
  const metrics = {} as Record<CacheMetric, number>;
  const flagged: FlaggedSlice[] = [];
  for (const [key, span] of Object.entries(WINDOWS) as [CacheMetric, number][]) {
    const calls = windowCalls(sessions, now - span, now);
    if (calls.length < MIN_CALLS) {
      metrics[key] = 100;
      flagged.push({ kind: key, excerpt: `no data: ${calls.length} calls in the window, under ${MIN_CALLS}, so it reads 100` });
      continue;
    }
    metrics[key] = share(calls);
    if (metrics[key] >= targets[key]) continue;
    const lines = breakLines(warmBreaks(sessions, now - span, now));
    flagged.push(...(lines.length ? lines : ["no warm breaks: the drop comes from cold starts or calls after more than 5 minutes idle"])
      .map(line => ({ kind: key, excerpt: `${metrics[key]}% < ${targets[key]}% over ${calls.length} calls; ${line}` })));
  }
  return { metrics, flagged };
}

const NEEDLES: Needle[] = ["session", "title", "session_info", "compaction", "model_change", "thinking_level_change", "service_tier_change", "custom"]
  .map(type => ({ text: `"type":"${type}`, within: 1 }))
  .concat([{ text: '"role":"assistant"', within: 320 }, { text: '"role":"user"', within: 320 }]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const text = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value : null;

/** One transcript's calls since `since`, with what the model saw before each; null when the file is not a Prime Agent transcript. */
export async function readTranscript(path: string, since: number): Promise<SessionCalls | null> {
  let header: { id: string } | null = null, bad = false, title: string | null = null;
  let before: string[] = [];
  const calls: Call[] = [];
  await readAppended(path, 0, NEEDLES, line => {
    if (bad) return;
    let entry: Record<string, unknown>;
    try { const value: unknown = JSON.parse(line); if (!isRecord(value)) return; entry = value; } catch { return; }
    if (!header) {
      if (entry.type === "title") return;
      if (entry.type !== "session" || !text(entry.id)) { bad = true; return; }
      header = { id: entry.id as string };
      return;
    }
    if (entry.type === "session_info") { title = text(entry.name) ?? title; return; }
    const message = isRecord(entry.message) ? entry.message : null;
    if (entry.type === "message" && message?.role === "user") { before.push("user"); return; }
    if (entry.type !== "message") {
      const kind = text(entry.customType) ?? String(entry.type);
      if (!UNSEEN.has(kind)) before.push(kind);
      return;
    }
    if (message?.role !== "assistant" || !isRecord(message.usage) || typeof message.model !== "string") return;
    const parsed = Date.parse(String(entry.timestamp));
    const endedAt = Number.isFinite(parsed) ? parsed : null;
    const seen = before;
    before = [];
    if (endedAt === null || endedAt < since) return;
    const id = text(message.responseId) ?? (text(entry.id) ? `msg:${entry.id}:${endedAt}` : null);
    if (!id) return;
    const usage = message.usage;
    calls.push({ id, endedAt, startedAt: typeof message.timestamp === "number" ? message.timestamp : null, provider: text(message.provider), model: message.model || "unknown",
      input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite), before: seen });
  });
  const found = header as { id: string } | null;
  return found && !bad ? { id: found.id, title: title ?? found.id, calls } : null;
}

/**
 * The files under `dir` that `accepts` takes. In session-artifacts it enters only `sub-*` folders below the first level: transcripts sit in
 * session folders and their RLM child chains (src/usage/sources.ts), and agents keep millions of artifact files beside them.
 */
async function transcripts(dir: string, accepts: (path: string) => boolean, subOnly: boolean, depth = 0): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && (!subOnly || depth === 0 || entry.name.startsWith("sub-"))) found.push(...await transcripts(path, accepts, subOnly, depth + 1));
    else if (entry.isFile() && accepts(path)) found.push(path);
  }
  return found;
}

/** Every Prime Agent transcript the Usage page reads that changed since `since`. */
export async function primeTranscripts(home: string, since: number): Promise<string[]> {
  const found: string[] = [];
  for (const root of fileRoots(home).filter(root => root.source === "prime-agent")) {
    for (const path of await transcripts(root.root, root.accepts, basename(root.root) === "session-artifacts")) {
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs >= since) found.push(path);
    }
  }
  return found;
}

/** Every Prime Agent transcript the Usage page reads that changed since `since`, read for calls since then. */
export async function readSessions(home: string, since: number): Promise<SessionCalls[]> {
  const sessions: SessionCalls[] = [];
  for (const path of await primeTranscripts(home, since)) {
    const session = await readTranscript(path, since);
    if (session?.calls.length) sessions.push(session);
  }
  return sessions;
}
