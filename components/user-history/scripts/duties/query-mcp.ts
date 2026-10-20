import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Query MCP duty's precheck for the Crawler VP chat (`node --import tsx scripts/duties/query-mcp.ts`). Reads only.
 * The owner, 10-15: "virev.ai MCP that lets a customer's agent read-query the whole crawled index freely", and 10-15 23:58Z: "팔로워 구간별로
 * 좋아요 수 비율 분석해줘" as one group-by sql call. Goal p542 closed on 10-19 at 23:22Z with 3 of 3 tools on both tiers of prod.
 * Per tier it calls prod https://virev.ai/mcp the way a customer's agent does (JSON-RPC over Streamable HTTP, a bearer token): describe, a sql
 * count, a search count, and the follower-bucket sql. The identity is the prod test user mcp-duty-checker with orgs org_mcp_duty_standard
 * and org_mcp_duty_full (dataApi allow), made on 10-20 for this duty; the precheck mints a fresh access token per run with the search app's
 * MCP_TOKEN_SIGNING_SECRET (auto-sns-agent apps/search/.env, read with dotenvx), so no token is stored.
 */

const MCP_URL = "https://virev.ai/mcp";
const REPO = join(homedir(), "Documents/Github/auto-sns-agent");
const USER = "mcp-duty-checker";
const TIERS = ["standard", "full"] as const;
/** Token lifetime: one run. The whole check took 26 to 38 s on prod (10-19 17:30Z and 23:22Z), so an hour covers it with room. */
const TOKEN_TTL_S = 3600;
export const FOLLOWER_BUCKET_SQL =
  "SELECT multiIf(followers < 1000, '0-1K', followers < 10000, '1K-10K', followers < 100000, '10K-100K', followers < 1000000, '100K-1M', '1M+') " +
  "AS follower_bucket, count() AS posts, round(avg(likes)) AS avg_likes, round(avg(likes / followers) * 100, 3) AS likes_per_follower_pct " +
  "FROM q.instagram_post_counts WHERE followers > 0 GROUP BY follower_bucket ORDER BY min(followers)";
const CALLS: { name: string; tool: "describe" | "sql" | "search"; args: Record<string, unknown> }[] = [
  { name: "describe", tool: "describe", args: {} },
  { name: "sql", tool: "sql", args: { sql: "SELECT count() AS posts FROM q.instagram_post_counts" } },
  { name: "search", tool: "search", args: { index: "crawler_v3_profiles", op: "_count", body: { query: { match_all: {} } } } },
  { name: "follower_bucket", tool: "sql", args: { sql: FOLLOWER_BUCKET_SQL } },
];

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export function mintToken(secret: string, tier: string, now: number): string {
  const payload = { userId: USER, clientId: `duty-query-mcp-${tier}`, clientName: `Query MCP duty check, ${tier} tier (keep)`, connectorSurface: "custom",
    resource: MCP_URL, aud: MCP_URL, scope: "openid profile email", orgId: `org_mcp_duty_${tier}`, type: "access", iat: now, exp: now + TOKEN_TTL_S,
    jti: randomBytes(16).toString("hex") };
  const enc = b64u(JSON.stringify(payload));
  return `vrev_mcp_access.${enc}.${b64u(createHmac("sha256", secret).update(enc).digest())}`;
}

/** The JSON-RPC result of one Streamable HTTP POST, answered as JSON or as an SSE stream. */
export function rpcResult(text: string): { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } } {
  const body = text.trimStart().startsWith("{") ? text : text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("");
  return JSON.parse(body);
}

interface CallResult { name: string; ok: boolean; ms: number; note: string }
async function callTool(token: string, tool: string, args: Record<string, unknown>, id: number): Promise<CallResult & { body?: unknown }> {
  const t0 = Date.now();
  try {
    const res = await fetch(MCP_URL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }) });
    const text = await res.text();
    if (!res.ok) return { name: tool, ok: false, ms: Date.now() - t0, note: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    const rpc = rpcResult(text);
    const out = (rpc.result?.content ?? []).map(c => c.text ?? "").join("");
    if (rpc.error || rpc.result?.isError) return { name: tool, ok: false, ms: Date.now() - t0, note: (rpc.error?.message ?? out).slice(0, 300) };
    let body: unknown = out; try { body = JSON.parse(out); } catch { /* text answer */ }
    return { name: tool, ok: true, ms: Date.now() - t0, note: "", body };
  } catch (error) {
    return { name: tool, ok: false, ms: Date.now() - t0, note: error instanceof Error ? error.message : String(error) };
  }
}

export function report(tiers: Record<string, CallResult[]>, now: number): PrecheckOutput {
  const answering = (calls: CallResult[]) => (["describe", "sql", "search"] as const).filter(t => calls.some(c => c.name === t && c.ok)).length;
  const flagged: FlaggedSlice[] = [];
  for (const [tier, calls] of Object.entries(tiers)) {
    flagged.push({ at: now, kind: "tier", excerpt: `${tier}: ` + calls.map(c => `${c.name} ${c.ok ? "ok" : "FAILED"} ${c.ms} ms${c.note ? ` (${c.note})` : ""}`).join("; ") });
  }
  return {
    metrics: {
      tools_answering: Math.min(...Object.values(tiers).map(answering)),
      follower_bucket_tiers: Object.values(tiers).filter(calls => calls.some(c => c.name === "follower_bucket" && c.ok)).length,
    },
    flagged,
  };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("query-mcp: OUTPUT_FILE is not set\n"); process.exit(2); }
  const secret = execFileSync("npx", ["--no-install", "dotenvx", "get", "MCP_TOKEN_SIGNING_SECRET", "-f", ".env"], { cwd: join(REPO, "apps/search"), encoding: "utf8" }).trim();
  if (!secret || secret.startsWith("encrypted:")) { process.stderr.write("query-mcp: MCP_TOKEN_SIGNING_SECRET did not decrypt\n"); process.exit(1); }
  const now = Math.floor(Date.now() / 1000);
  const tiers: Record<string, CallResult[]> = {};
  for (const tier of TIERS) {
    const token = mintToken(secret, tier, now);
    const calls: CallResult[] = [];
    for (const [i, call] of CALLS.entries()) {
      const r = await callTool(token, call.tool, call.args, i + 1);
      const meta = (r.body as { data?: { meta?: { ms?: number; readRows?: number; readBytes?: number } } } | undefined)?.data?.meta;
      calls.push({ name: call.name, ok: r.ok, ms: r.ms, note: r.ok && meta ? [`server ${meta.ms} ms`, meta.readRows !== undefined ? `${meta.readRows} rows` : "", meta.readBytes !== undefined ? `${meta.readBytes} bytes read` : ""].filter(Boolean).join(", ") : r.note });
    }
    tiers[tier] = calls;
  }
  await writeFile(output, JSON.stringify(report(tiers, Date.now()), null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
