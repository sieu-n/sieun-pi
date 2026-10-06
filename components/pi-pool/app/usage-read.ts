/**
 * Reads usage for chosen pooled accounts now, through tokenmaxxing's own read and save functions.
 * `tokenmaxxing status` skips an account read in the last 90 s to 15 min and reports it as "cached",
 * so it cannot answer "read this account now". This helper ignores that timer. It still honours the
 * usage endpoint's Retry-After, so a rate limited account is reported, not read.
 *
 * Usage: bun usage-read.ts <tokenmaxxing src dir> <anthropic|openai-codex> [account id ...]
 * stdout, one JSON object per line:
 *   {"event":"accounts","accounts":[{"id","email"}]}            the accounts about to be read
 *   {"event":"reading","id"}                                    one read started
 *   {"event":"read","id","ok":true,"usage_at"}                  saved; usage_at in epoch seconds
 *   {"event":"read","id","ok":false,"reason","retry_at"}        not read; retry_at in epoch seconds or null
 *   {"event":"error","message"}                                 nothing was read (bad arguments, tokenmaxxing changed)
 * Never prints a credential.
 */
import { join } from "node:path";

type Window = { name: string | null; sampledAt: number };
type Account = { id: string; email: string | null; label: string; tier?: string | null; windows: Window[]; lastUsageAt?: number; lastProbeAt?: number;
  usageRetryAt?: number; needsReauth?: boolean; probeFails?: number };
type Pool = { lockFile: string };
type Index = { accounts: Account[] };
type Ready = { ok: true; token: string; expiresAt: number } | { ok: false; reason: string };
type Outcome = { ok: true; usage: unknown } | { ok: false; reason: string; retryAt?: number };
type Report = { ok: true } | { ok: false; reason: string };

const CONCURRENCY = 4;
const emit = (value: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(value) + "\n"); };
const seconds = (ms: number | null | undefined): number | null => (ms == null ? null : Math.round(ms / 1000));

/** Loads one tokenmaxxing module and checks it still exports what this helper calls. A daily auto-update can rename them. */
async function load(src: string, file: string, names: string[]): Promise<Record<string, any>> {
  const mod: Record<string, unknown> = await import(join(src, file));
  const missing = names.filter((name) => mod[name] === undefined);
  if (missing.length) throw new Error(`tokenmaxxing ${file} no longer exports ${missing.join(", ")}; pi-pool refresh needs an update`);
  return mod as Record<string, any>;
}

async function main(): Promise<number> {
  const [src, provider, ...ids] = process.argv.slice(2);
  if (!src || (provider !== "anthropic" && provider !== "openai-codex")) {
    emit({ event: "error", message: "usage: usage-read.ts <tokenmaxxing src> <anthropic|openai-codex> [account id ...]" });
    return 2;
  }
  const state = await load(src, "lib/state.ts", ["loadAccounts", "saveAccounts", "loadConfig"]);
  const { withLock } = await load(src, "lib/lock.ts", ["withLock"]);
  const { landWindows, thresholdBars } = await load(src, "lib/picker.ts", ["landWindows", "thresholdBars"]);
  const { claudePool, codexPool } = await load(src, "lib/paths.ts", ["claudePool", "codexPool"]);
  const { mergeWindows, windowsOf } = await load(src, "lib/usage.ts", ["mergeWindows", "windowsOf"]);
  const { readyToSample, runSample } = await load(src, "lib/sample.ts", ["readyToSample", "runSample"]);
  const { codex } = await load(src, "lib/codex.ts", ["codex"]);
  if (typeof codex.samplePool !== "function" || typeof codex.mergeWindows !== "function") throw new Error("tokenmaxxing's codex provider no longer has samplePool; pi-pool refresh needs an update");

  const pool: Pool = provider === "anthropic" ? claudePool : codexPool;
  const bars = thresholdBars(state.loadConfig());
  const all: Account[] = (state.loadAccounts(pool) as Index).accounts;
  const chosen = ids.length ? ids.map((id) => all.find((a) => a.id === id) ?? id) : all;
  emit({ event: "accounts", accounts: chosen.map((a) => (typeof a === "string" ? { id: a, email: null } : { id: a.id, email: a.email ?? a.label })) });

  /** Saves what one read learned under tokenmaxxing's pool lock, the way its own probe does, and returns the stored account. */
  const save = (id: string, apply: (stored: Account) => void): Promise<Account | null> => withLock(pool.lockFile, () => {
    const idx: Index = state.loadAccounts(pool);
    const stored = idx.accounts.find((a) => a.id === id);
    if (!stored) return null;
    apply(stored);
    state.saveAccounts(pool, idx);
    return stored;
  });

  async function readClaude(a: Account): Promise<Record<string, unknown>> {
    const ready: Ready = await readyToSample(a, Date.now());
    if (!ready.ok) {
      if (a.needsReauth) await save(a.id, (s) => { s.needsReauth = true; });
      const retry = a.usageRetryAt != null && a.usageRetryAt > Date.now() ? a.usageRetryAt : null;
      return { ok: false, reason: ready.reason, retry_at: seconds(retry) };
    }
    const startedAt = Date.now();
    const outcome: Outcome = await runSample(a, ready);
    const stored = await save(a.id, (s) => {
      s.lastProbeAt = startedAt;
      if (a.tier != null) s.tier = a.tier;
      if (a.needsReauth) s.needsReauth = true;
      if (outcome.ok) {
        s.probeFails = 0;
        if (s.lastUsageAt == null || startedAt > s.lastUsageAt) landWindows(s, mergeWindows(windowsOf(outcome.usage, startedAt), s.windows), startedAt, bars);
      } else {
        s.probeFails = (s.probeFails ?? 0) + 1;
        if (outcome.retryAt != null) s.usageRetryAt = outcome.retryAt;
      }
    });
    if (!stored) return { ok: false, reason: "the account left the pool during the read", retry_at: null };
    return outcome.ok ? { ok: true, usage_at: seconds(stored.lastUsageAt) } : { ok: false, reason: outcome.reason, retry_at: seconds(outcome.retryAt) };
  }

  async function readCodex(a: Account): Promise<Record<string, unknown>> {
    const reports: Map<string, Report> = await codex.samplePool([a], null, Date.now());
    const report = reports.get(a.id) ?? { ok: false, reason: "tokenmaxxing returned no result for this account" };
    const stored = await save(a.id, (s) => {
      if (a.needsReauth) s.needsReauth = true;
      if ((a.lastProbeAt ?? 0) > (s.lastProbeAt ?? 0)) s.lastProbeAt = a.lastProbeAt;
      if (a.lastUsageAt != null && (s.lastUsageAt == null || a.lastUsageAt > s.lastUsageAt)) {
        landWindows(s, codex.mergeWindows(a.windows, s.windows), a.lastUsageAt, bars);
        if (a.email != null) s.email = a.email;
        if (a.tier != null) s.tier = a.tier;
      }
    });
    if (!stored) return { ok: false, reason: "the account left the pool during the read", retry_at: null };
    return report.ok ? { ok: true, usage_at: seconds(stored.lastUsageAt) } : { ok: false, reason: report.reason, retry_at: null };
  }

  const queue = [...chosen];
  async function worker(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (typeof next === "string") { emit({ event: "read", id: next, ok: false, reason: "not in the pool", retry_at: null }); continue; }
      emit({ event: "reading", id: next.id });
      let result: Record<string, unknown>;
      try { result = provider === "anthropic" ? await readClaude(next) : await readCodex(next); }
      catch (error) { result = { ok: false, reason: String(error instanceof Error ? error.message : error).slice(0, 200), retry_at: null }; }
      emit({ event: "read", id: next.id, ...result });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  emit({ event: "error", message: String(error instanceof Error ? error.message : error).slice(0, 300) });
  process.exit(1);
});
