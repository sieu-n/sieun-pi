import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FiringAlert } from "./alert-bridge.ts";

/**
 * A pool-wide token hook failure as one alert for the alert bridge. From 10-16 08:44Z to 10-17 19:45Z every Prime turn on the Mac failed with
 * "Failed to resolve API key ... pi-pool-token" (20,981 failed calls), the pool log had no line for any of them, and no chat told the owner for
 * 35 hours. The hook leaves no trace when Prime kills it before it runs, so this reads Prime's own session files: in the last HOOK_WINDOW_MS,
 * HOOK_MIN_FAILURES or more pooled turns in two or more root sessions failed on the hook and no pooled turn got an answer. The bridge puts the
 * alert on its chat's board as one step and notes it resolved once a pooled turn gets an answer again.
 */
export const HOOK_WINDOW_MS = 10 * 60_000;
export const HOOK_MIN_FAILURES = 3;
export const HOOK_FINGERPRINT = "pi-pool-token-hook";
export const HOOK_ALERT_NAME = "Every Prime turn fails because the pi-pool token hook gives no token";
const TAIL_BYTES = 256 * 1024;
const POOLED = new Set(["anthropic", "openai-codex"]);
const HOOK_FAILED = /^Failed to resolve API key for provider "[^"]+" from shell command: .*pi-pool-token/;

export interface HookTally { failures: number; sessions: number; answers: number; first: number | null }

interface Line { type?: unknown; timestamp?: unknown; message?: { role?: unknown; provider?: unknown; stopReason?: unknown; errorMessage?: unknown } }

/** Counts the pooled assistant turns in one session file's tail at or after `since`: hook failures, and answers (a turn that ended without an error or abort). */
export function tallyTail(text: string, since: number): { failures: number[]; answers: number } {
  const failures: number[] = [];
  let answers = 0;
  for (const raw of text.split("\n")) {
    if (!raw.includes("\"assistant\"")) continue;
    let line: Line;
    try { line = JSON.parse(raw) as Line; } catch { continue; }
    const message = line.message;
    if (line.type !== "message" || message?.role !== "assistant" || typeof message.provider !== "string" || !POOLED.has(message.provider)) continue;
    const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    if (!Number.isFinite(at) || at < since) continue;
    if (message.stopReason === "error") {
      if (typeof message.errorMessage === "string" && HOOK_FAILED.test(message.errorMessage)) failures.push(at);
    } else if (message.stopReason !== "aborted") answers++;
  }
  return { failures, answers };
}

export const poolDown = (tally: HookTally): boolean => tally.failures >= HOOK_MIN_FAILURES && tally.sessions >= 2 && tally.answers === 0;

async function tail(path: string, size: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { await file.close(); }
}

/** Tallies the root session files in `dir` that changed in the window ending at `now`. */
export async function tallySessions(dir: string, now: number): Promise<HookTally> {
  const since = now - HOOK_WINDOW_MS;
  const tally: HookTally = { failures: 0, sessions: 0, answers: 0, first: null };
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.mtimeMs < since) continue;
    const { failures, answers } = tallyTail(await tail(path, info.size).catch(() => ""), since);
    tally.answers += answers;
    if (!failures.length) continue;
    tally.failures += failures.length;
    tally.sessions++;
    const first = Math.min(...failures);
    tally.first = tally.first === null ? first : Math.min(tally.first, first);
  }
  return tally;
}

/** The bridge alert for one down spell. `startsAt` stays the spell's first failure, so the bridge keeps one step for the whole spell. */
export class TokenHookWatch {
  private since: string | null = null;
  constructor(private readonly deps: { sessionsDir: string; now?: () => number }) {}

  async alerts(): Promise<FiringAlert[]> {
    const now = this.deps.now?.() ?? Date.now();
    const tally = await tallySessions(this.deps.sessionsDir, now);
    if (!poolDown(tally)) {
      this.since = null;
      return [];
    }
    this.since ??= new Date(tally.first ?? now).toISOString();
    return [{ fingerprint: HOOK_FINGERPRINT, startsAt: this.since, alertname: HOOK_ALERT_NAME, labels: { alertname: HOOK_ALERT_NAME, source: "pi-pool" }, url: "",
      summary: `In the last ${HOOK_WINDOW_MS / 60_000} min, ${tally.failures} turns in ${tally.sessions} sessions failed with "Failed to resolve API key" from ` +
        "pi-pool-token and no turn on a pooled provider got an answer. When the hook ran, ~/.config/pi-pool/pi-pool.log has a hook_no_token line with the reason." }];
  }
}

/** Grafana's firing list plus the local token hook alert. Null only when Grafana has no config and the hook alert is not firing. */
export async function withHookAlert(grafana: Promise<FiringAlert[] | null>, watch: Pick<TokenHookWatch, "alerts">): Promise<FiringAlert[] | null> {
  const [remote, local] = await Promise.all([grafana, watch.alerts()]);
  return remote === null && !local.length ? null : [...(remote ?? []), ...local];
}
