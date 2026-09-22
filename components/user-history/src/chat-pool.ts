import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AccountAction, AccountsView, PoolAccount, PoolProvider, PoolResolution, PoolWindow } from "./shared/types.ts";

const executable = fileURLToPath(new URL("../../pi-pool/bin/pi-pool", import.meta.url));
export const pooledProviders = ["anthropic", "openai-codex"] as const;
type PooledProvider = typeof pooledProviders[number];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const isPooled = (value: string): value is PooledProvider => (pooledProviders as readonly string[]).includes(value);
const epochMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const WINDOW_KINDS = new Set<unknown>(["session", "weekly", "model"]);

function parseWindows(value: unknown): PoolWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): PoolWindow[] => {
    if (!isRecord(entry) || !WINDOW_KINDS.has(entry.kind) || typeof entry.label !== "string") return [];
    return [{ kind: entry.kind as PoolWindow["kind"], label: entry.label, pct: percent(entry.pct) ?? 0, resetsAt: epochMs(entry.resets_at) }];
  });
}

export function parsePoolRows(value: unknown, provider: string): PoolAccount[] {
  if (!isRecord(value) || value.provider !== provider || !Array.isArray(value.rows)) throw new Error("pi-pool returned an invalid listing");
  return value.rows.map((row: unknown): PoolAccount => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id || typeof row.email !== "string" || typeof row.usage !== "string" ||
      !(row.reason === null || typeof row.reason === "string") || typeof row.usable !== "boolean" || typeof row.current !== "boolean" ||
      typeof row.pinned !== "boolean" || typeof row.force !== "boolean" || typeof row.live !== "boolean" || typeof row.seat !== "boolean") {
      throw new Error("pi-pool returned an invalid account");
    }
    return { id: row.id, email: row.email, usage: row.usage, reason: row.reason, usable: row.usable, current: row.current, pinned: row.pinned, force: row.force,
      live: row.live, seat: row.seat, session_pct: percent(row.session_pct), weekly_pct: percent(row.weekly_pct), score: percent(row.score),
      ...(typeof row.plan === "string" ? { plan: row.plan } : {}),
      tier: text(row.tier), windows: parseWindows(row.windows), usageAt: epochMs(row.usage_at), cooldownUntil: epochMs(row.cooldown_until),
      cooldownReason: text(row.cooldown_reason) };
  });
}

export function parsePoolResolution(value: unknown, provider: string): PoolResolution | null {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("pi-pool returned an invalid resolution");
  const selected = value.providers[provider];
  if (!isRecord(selected) || "error" in selected) return null;
  return { account: typeof selected.account === "string" ? selected.account : null, email: typeof selected.email === "string" ? selected.email : null,
    reason: typeof selected.reason === "string" ? selected.reason : null, pinned: selected.pinned === true };
}

/** pi-pool reads the calling session from these variables. The service may have been started inside a session; a thread is always named with --session instead. */
const SESSION_VARIABLES = ["PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"];
const poolEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.includes(name)));

function reportedError(stdout: string): string | null {
  try { const value: unknown = JSON.parse(stdout); return isRecord(value) ? text(value.error) : null; } catch { return null; }
}

function run(args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: poolEnv() }, (error, stdout, stderr) => {
      if (error) { reject(new Error("pi-pool failed: " + (String(stderr).trim() || reportedError(String(stdout)) || error.message).slice(0, 300))); return; }
      resolve(stdout);
    });
  });
}

const session = (sessionId: string | null) => sessionId ? ["--session", sessionId] : [];

export async function listAccounts(sessionId: string | null): Promise<AccountsView> {
  const resolution = await run(["who", "--json", ...session(sessionId)]).then(JSON.parse).catch(() => null);
  const providers = await Promise.all(pooledProviders.map(async (provider): Promise<PoolProvider> => {
    try {
      const listing: unknown = JSON.parse(await run(["ls", "--json", "--provider", provider, ...session(sessionId)]));
      if (isRecord(listing) && typeof listing.error === "string") return { provider, rows: [], resolution: null, error: listing.error };
      const poolPin = isRecord(listing) && isRecord(listing.pin) ? text(listing.pin.id) : null;
      return { provider, rows: parsePoolRows(listing, provider), resolution: resolution ? parsePoolResolution(resolution, provider) : null, poolPin };
    } catch (error) { return { provider, rows: [], resolution: null, error: error instanceof Error ? error.message : String(error) }; }
  }));
  return { sessionId, checkedAt: new Date().toISOString(), providers };
}

/** One sentence from `pi-pool refresh --json`: which accounts tokenmaxxing could not read. */
export function refreshNotice(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("pi-pool returned an invalid refresh report");
  const rows = Object.values(value.providers).flatMap(rows => Array.isArray(rows) ? rows.filter(isRecord) : []);
  const failed = rows.filter(row => row.ok !== true);
  if (!failed.length) return rows.length === 1 ? "Usage updated." : `Usage updated for ${rows.length} accounts.`;
  return `Usage updated for ${rows.length - failed.length} of ${rows.length} accounts. ` +
    failed.map(row => `${text(row.email) ?? "An account"}: ${text(row.reason) ?? "not read"}.`).join(" ");
}

/** Runs one pool action. Returns a sentence to show when the action reports something beyond the new pool state. */
export async function runAccountAction(action: AccountAction): Promise<string | null> {
  if (!isPooled(action.provider)) throw new Error("Choose a pooled provider.");
  const provider = ["--provider", action.provider];
  switch (action.action) {
    case "use": {
      if (!action.account || action.account.startsWith("-") || !action.id) throw new Error("Choose an account and a thread.");
      await run(["use", action.account, ...(action.force ? ["--force"] : []), ...provider, "--session", action.id]); return null;
    }
    case "follow": {
      if (!action.id) throw new Error("Choose a thread.");
      await run(["use", "--follow", ...provider, "--session", action.id]); return null;
    }
    case "pin": {
      if (!action.account || action.account.startsWith("-")) throw new Error("Choose an account.");
      await run(["pin", action.account, ...provider]); return null;
    }
    case "unpin": await run(["unpin", ...provider]); return null;
    case "switch": await run(["switch", ...provider]); return null;
    case "refresh": return refreshNotice(JSON.parse(await run(["refresh", "--json"], 75000)));
    case "recheck": {
      if (action.provider !== "anthropic") throw new Error("Only Claude accounts can be checked for a refusal.");
      const found = (await run(["probe", "--force"], 30000)).trim();
      return found ? found.replaceAll("; ", ". ") + "." : "No refusals found.";
    }
  }
}
