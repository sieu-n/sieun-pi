import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../../pi-pool/bin/pi-pool-token", import.meta.url));
export const pooledProviders = new Set(["anthropic", "openai-codex"]);
export interface PoolAccount {
  id: string; email: string; usage: string; session_pct: number | null; weekly_pct: number | null;
  usable: boolean; reason: string | null; current: boolean; pinned: boolean; force: boolean;
  live: boolean; seat: boolean; score: number | null; plan?: string;
}
export type PoolListing = { kind: "pool"; provider: string; sessionId: string; checkedAt: string; rows: PoolAccount[] }
  | { kind: "none"; provider: string; sessionId: string };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function parsePoolListing(value: unknown, provider: string, sessionId: string): PoolListing {
  if (!record(value) || value.provider !== provider || value.session !== sessionId || !Array.isArray(value.rows)) {
    throw new Error("pi-pool returned an invalid session listing");
  }
  const rows = value.rows.map((row: unknown): PoolAccount => {
    if (!record(row) || typeof row.id !== "string" || !row.id || typeof row.email !== "string" ||
      typeof row.usage !== "string" || !(row.reason === null || typeof row.reason === "string") ||
      typeof row.usable !== "boolean" || typeof row.current !== "boolean" || typeof row.pinned !== "boolean" ||
      typeof row.force !== "boolean" || typeof row.live !== "boolean" || typeof row.seat !== "boolean") {
      throw new Error("pi-pool returned an invalid account");
    }
    return { id: row.id, email: row.email, usage: row.usage, reason: row.reason, usable: row.usable,
      current: row.current, pinned: row.pinned, force: row.force, live: row.live, seat: row.seat,
      session_pct: percent(row.session_pct), weekly_pct: percent(row.weekly_pct), score: percent(row.score),
      ...(typeof row.plan === "string" ? { plan: row.plan } : {}) };
  });
  return { kind: "pool", provider, sessionId, rows, checkedAt: new Date().toISOString() };
}
async function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["--cli", ...args], { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error("pi-pool is unavailable for this session. Check /account in Prime Agent.")); return; }
      resolve(stdout);
    });
  });
}
export async function listPool(provider: string, sessionId: string): Promise<PoolListing> {
  if (!pooledProviders.has(provider)) return { kind: "none", provider, sessionId };
  const output = await run(["ls", "--json", "--provider", provider, "--session", sessionId]);
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("pi-pool returned unreadable data"); }
  if (record(value) && typeof value.error === "string") throw new Error("pi-pool could not list this session. Check /account in Prime Agent.");
  return parsePoolListing(value, provider, sessionId);
}
export async function choosePool(input: { provider: string; sessionId: string; target: string; force: boolean }): Promise<PoolListing> {
  const { provider, sessionId, target, force } = input;
  const listing = await listPool(provider, sessionId);
  if (listing.kind === "none") throw new Error("This model has no account pool");
  if (target !== "follow") {
    const row = listing.rows.find(row => row.id === target);
    if (!row || target.startsWith("-")) throw new Error("Choose an account from this pool");
    if (!row.usable && !force) throw new Error("This account needs explicit force confirmation");
  } else if (force) throw new Error("Follow the pool does not accept force");
  await run(["use", ...(target === "follow" ? ["--follow"] : [target]), "--provider", provider,
    "--session", sessionId, ...(force ? ["--force"] : [])]);
  return listPool(provider, sessionId);
}
