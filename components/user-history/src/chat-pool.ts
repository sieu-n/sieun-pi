import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AccountAction, AccountsView, PoolAccount, PoolEvent, PoolProvider, PoolResolution } from "./shared/types.ts";

const executable = fileURLToPath(new URL("../../pi-pool/bin/pi-pool", import.meta.url));
export const pooledProviders = ["anthropic", "openai-codex"] as const;
type PooledProvider = typeof pooledProviders[number];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const isPooled = (value: string): value is PooledProvider => (pooledProviders as readonly string[]).includes(value);

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
      ...(typeof row.plan === "string" ? { plan: row.plan } : {}) };
  });
}

export function parsePoolResolution(value: unknown, provider: string): PoolResolution | null {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("pi-pool returned an invalid resolution");
  const selected = value.providers[provider];
  if (!isRecord(selected) || "error" in selected) return null;
  return { account: typeof selected.account === "string" ? selected.account : null, email: typeof selected.email === "string" ? selected.email : null,
    reason: typeof selected.reason === "string" ? selected.reason : null, pinned: selected.pinned === true };
}

export function parsePoolLog(output: string): PoolEvent[] {
  return output.split("\n").flatMap(line => {
    if (!line.trim()) return [];
    let value: unknown;
    try { value = JSON.parse(line); } catch { return []; }
    if (!isRecord(value) || typeof value.ts !== "string" || typeof value.event !== "string") return [];
    return [{ ts: value.ts, event: value.event, ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
      ...(typeof value.account === "string" ? { account: value.account } : {}), ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.source === "string" ? { source: value.source } : {}) }];
  });
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error("pi-pool failed: " + (String(stderr).trim() || error.message).slice(0, 300))); return; }
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
      return { provider, rows: parsePoolRows(listing, provider), resolution: resolution ? parsePoolResolution(resolution, provider) : null };
    } catch (error) { return { provider, rows: [], resolution: null, error: error instanceof Error ? error.message : String(error) }; }
  }));
  return { sessionId, checkedAt: new Date().toISOString(), providers };
}

export async function runAccountAction(action: AccountAction): Promise<void> {
  if (!isPooled(action.provider)) throw new Error("Choose a pooled provider.");
  const provider = ["--provider", action.provider];
  switch (action.action) {
    case "use": {
      if (!action.account || action.account.startsWith("-") || !action.id) throw new Error("Choose an account and a thread.");
      await run(["use", action.account, ...(action.force ? ["--force"] : []), ...provider, "--session", action.id]); return;
    }
    case "follow": {
      if (!action.id) throw new Error("Choose a thread.");
      await run(["use", "--follow", ...provider, "--session", action.id]); return;
    }
    case "pin": {
      if (!action.account || action.account.startsWith("-")) throw new Error("Choose an account.");
      await run(["pin", action.account, ...provider]); return;
    }
    case "unpin": await run(["unpin", ...provider]); return;
    case "switch": await run(["switch", ...provider]); return;
  }
}

export async function poolLog(count = 30): Promise<PoolEvent[]> {
  return parsePoolLog(await run(["log", String(count)]));
}
