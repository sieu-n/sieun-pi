import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { REPO, SOURCE_DEADLINE_MS, grafanaClient, prodReader, readGrafanaAuth, settle, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The api portal vp chat's "DM outreach works" precheck (`node --import tsx scripts/duties/dm-outreach.ts`). No model call, reads only, sends nothing.
 * It answers what the owner checks by hand on https://api.virev.ai/playground/dm-playground: can a new conversation go out, does the page say so, and do sends go out.
 * 1. It reads `sendable_now` from the prod crawler's GET /ops/engage/health: the accounts the outreach claim can take whose exit passes the send's
 *    stored egress admission. On 11-20 at 18:34Z prod held 58 active accounts and no paid proxy, so no send could go out, while the census sum this
 *    duty read before (new plus active) kept it green.
 * 2. It finds the commit prod runs from the newest READY production deployment of the api-portal Vercel project (vercelApi in auto-sns-agent
 *    scripts/repo/env/vercel-blobs.mjs), reads `sendingState` from apps/api-portal/src/lib/server/engage-dm.ts at that commit, and runs it on the
 *    same answer, so a flag names a page that offers Start conversation while nothing can send, or shows Paused while sends can go.
 * 3. It reads prod ig_engage_messages through Grafana's estate_pg_prod (estate-reads.ts prodReader): outbound rows of the last 24 h whose
 *    status is failed or delivery_unknown. A daily_send_limit_reached refusal writes no row (fleet/budget charges before the row), and the query
 *    leaves one out if it ever does.
 *
 * Targets in dm-outreach.duty.json (the JSON cannot hold comments):
 * - sending_available >= 1: 1 when sendable_now is at least 1, the owner's p17 done line of a customer who can start a conversation.
 * - sendable_accounts >= 1: sendable_now itself.
 * - failed_sends_24h <= 0: a failed send is a customer's message that did not go out. 3 of 4 prod sends went out on 10-15 and the 4th failed
 *   ui_no_compose, so no failure is normal.
 * A source that failed makes the metrics it feeds read missValue() and adds a source_error flag.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DUTY_FILE = join(HERE, "dm-outreach.duty.json");
const ENGAGE_DM = "apps/api-portal/src/lib/server/engage-dm.ts";
/** The refusal the duty leaves out of the failed sends: the owner's cap of 2 sends a day per account ("2/day/account", 10-12). */
export const DAILY_LIMIT_CODE = "daily_send_limit_reached";

export type Sending = "available" | "paused" | "unknown";
export interface FailedSend { id: number; status: string; code: string; at: number }
export type Source = "prod deployment" | "prod sendingState" | "crawler engage health" | "prod sends";
export const FEEDS: Readonly<Record<Source, readonly string[]>> = {
  "prod deployment": [],
  "prod sendingState": [],
  "crawler engage health": ["sending_available", "sendable_accounts"],
  "prod sends": ["failed_sends_24h"],
};
export interface DmData {
  now: number;
  sha?: string;
  sending?: Sending;
  sendable?: number;
  failed?: FailedSend[];
  errors: { source: Source; message: string }[];
}

/**
 * The deployed `sendingState` as a module source: the function text plus the one-line top-level constants it names (HEALTH_TIMEOUT_MS in
 * a8f85b4206), with `crawler` taken from setCrawler. Throws when the file has no such function.
 */
export function sendingStateModule(source: string): string {
  const start = source.indexOf("export async function sendingState(");
  const end = start < 0 ? -1 : source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`${ENGAGE_DM} has no sendingState function`);
  const fn = source.slice(start, end + 2);
  const consts = [...new Set(fn.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? [])]
    .map(name => new RegExp(`^(?:export )?const ${name}\\b.*;$`, "m").exec(source)?.[0]?.replace(/^export /, ""))
    .filter((line): line is string => Boolean(line));
  return ["let crawler: (path: string, init?: unknown) => Promise<unknown>;", "export const setCrawler = (fetcher: typeof crawler) => { crawler = fetcher; };",
    "type Sending = 'available' | 'paused' | 'unknown';", ...consts, fn].join("\n");
}

/** Runs the deployed sendingState on one /ops/engage/health answer, shaped the way engage-dm.ts's crawler() returns it. */
export async function runSendingState(source: string, health: { status: number; body: unknown }): Promise<Sending> {
  const dir = await mkdtemp(join(tmpdir(), "dm-outreach-"));
  try {
    const file = join(dir, "sending-state.ts");
    await writeFile(file, sendingStateModule(source));
    const mod = await import(pathToFileURL(file).href) as { setCrawler: (fetcher: () => Promise<unknown>) => void; sendingState: () => Promise<Sending> };
    const body = health.body as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null;
    const ok = health.status >= 200 && health.status < 300 && body?.ok !== false;
    mod.setCrawler(async () => ok ? { ok: true, status: health.status, data: body?.data ?? body }
      : { ok: false, status: health.status, error: { code: body?.error?.code ?? "upstream_unavailable", message: body?.error?.message ?? "" } });
    return await mod.sendingState();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The accounts a new outreach can claim and send from now, from a /ops/engage/health answer; throws when it has no sendable_now. */
export function sendableOf(body: unknown): number {
  const data = (body as { data?: unknown } | null)?.data ?? body;
  const sendable = (data as { sendable_now?: unknown } | null)?.sendable_now;
  if (typeof sendable !== "number" || !Number.isFinite(sendable)) throw new Error("GET /ops/engage/health has no sendable_now");
  return sendable;
}

/** The outbound sends of the last 24 h that did not go out, as one TSV row each: id, status, code, created_at in ms. */
export const FAILED_SQL = `select m.id, m.status, coalesce(nullif(m.last_error_code, ''), nullif(m.error, ''), 'none') as error, round(extract(epoch from m.created_at) * 1000) as at
from ig_engage_messages m join ig_engage_accounts a on a.id = m.account_id
where a.world = 'prod' and m.direction = 'out' and m.status in ('failed', 'delivery_unknown') and m.created_at > now() - interval '24 hours'
  and coalesce(m.last_error_code, m.error, '') not like '${DAILY_LIMIT_CODE}%'
order by m.id`;

/** The short code of a stored error: "WebSendError: ui_no_compose: no New message control" becomes "WebSendError: ui_no_compose". */
export const codeOf = (error: string): string => error.split(": ").slice(0, 2).join(": ").slice(0, 80);

export function failedOf(tsv: string): FailedSend[] {
  return tsv.split("\n").filter(line => line.trim()).map(line => {
    const [id, status, error, at] = line.split("\t");
    if (!id || !status || error === undefined || !at || !Number.isFinite(Number(id)) || !Number.isFinite(Number(at))) throw new Error(`prod sends: unexpected row ${line.slice(0, 80)}`);
    return { id: Number(id), status, code: codeOf(error), at: Number(at) };
  });
}

/** The duty's metrics and flags from what the sources returned. */
export function report(data: DmData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const at = data.now;
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  const unmeasured = new Set<string>();
  for (const error of data.errors) {
    for (const key of FEEDS[error.source]) unmeasured.add(key);
    flagged.push({ at, kind: "source_error", excerpt: `${error.source}: ${error.message}`.slice(0, 300) });
  }
  const sha = data.sha?.slice(0, 10) ?? "unknown";
  if (data.sendable !== undefined) {
    metrics.sending_available = data.sendable >= 1 ? 1 : 0;
    metrics.sendable_accounts = data.sendable;
    if (data.sendable < 1) flagged.push({ at, kind: "no_capacity", excerpt: "no prod account can send a new outreach now: GET /ops/engage/health sendable_now is 0, so no account the outreach claim can take passes the send's egress admission" });
  }
  if (data.sending && data.sendable !== undefined) {
    const page = `sendingState at prod's deployed ${sha} answers ${data.sending} while sendable_now is ${data.sendable}`;
    if (data.sending !== "paused" && data.sendable < 1) flagged.push({ at, kind: "page_offers_start", excerpt: `the prod DM playground keeps Start conversation enabled while nothing can send: ${page}` });
    if (data.sending === "paused" && data.sendable >= 1) flagged.push({ at, kind: "paused", excerpt: `the prod DM playground shows Paused while sends can go: ${page}` });
  }
  if (data.failed) {
    metrics.failed_sends_24h = data.failed.length;
    const codes = new Map<string, number>();
    for (const send of data.failed) codes.set(send.code, (codes.get(send.code) ?? 0) + 1);
    if (data.failed.length) flagged.push({ at, kind: "failed_sends", excerpt: `${data.failed.length} prod DM sends did not go out in 24 h: ${[...codes].map(([code, count]) => `${code} x${count}`).join(", ")}; messages ${data.failed.map(send => `${send.id} ${send.status} ${utc(send.at)}`).join(", ")}`.slice(0, 300) });
  }
  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  return { metrics, flagged };
}

// ---- I/O ----

const sh = (command: string, cwd: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
  execFile("/bin/sh", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal }, (error, stdout, stderr) =>
    error ? reject(new Error(`${error.message.split("\n")[0]} ${String(stderr).trim().slice(-200)}`)) : resolve(stdout));
});

async function measure(now: number, signal: AbortSignal): Promise<DmData> {
  const data: DmData = { now, errors: [] };
  const step = async <T>(source: Source, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const prod = JSON.parse(await readFile(join(REPO, "apps/specs/envs/prod.json"), "utf8")) as { urls: { crawler: string }; keySources: Record<string, { cmd: string }> };
  const [sha, health, failed] = await Promise.all([
    step("prod deployment", async () => {
      const vercel = await import(pathToFileURL(join(REPO, "scripts/repo/env/vercel-blobs.mjs")).href) as {
        vercelApi: (path: string, options: { query: Record<string, string> }) => Promise<{ deployments?: { meta?: { githubCommitSha?: string } }[] }>;
        TEAM_ID: string; APPS: Record<string, { projectId: string }>;
      };
      const answer = await vercel.vercelApi("/v6/deployments", { query: { projectId: vercel.APPS["api-portal"]!.projectId, teamId: vercel.TEAM_ID, target: "production", state: "READY", limit: "1" } });
      const commit = answer.deployments?.[0]?.meta?.githubCommitSha;
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("the newest READY api-portal production deployment names no commit");
      return commit;
    }),
    step("crawler engage health", async () => {
      const key = (await sh(prod.keySources.CRAWLER_API_KEY!.cmd, REPO, signal)).trim();
      const response = await fetch(`${prod.urls.crawler}/ops/engage/health`, { headers: { "X-API-Key": key }, signal });
      const body = await response.json().catch(() => null) as unknown;
      if (response.status !== 200) throw new Error(`GET ${prod.urls.crawler}/ops/engage/health gave HTTP ${response.status}`);
      return { status: response.status, body };
    }),
    step("prod sends", async () => failedOf(await prodReader(grafanaClient(fetch, await readGrafanaAuth(), now, signal))(FAILED_SQL))),
  ]);
  if (sha) data.sha = sha;
  if (failed) data.failed = failed;
  if (health) {
    const sendable = await step("crawler engage health", async () => sendableOf(health.body));
    if (sendable !== undefined) data.sendable = sendable;
  }
  if (sha && health) {
    const sending = await step("prod sendingState", async () => {
      const source = await sh(`git cat-file -e ${sha}^{commit} 2>/dev/null || git fetch --quiet origin main; git show ${sha}:${ENGAGE_DM}`, REPO, signal);
      return runSendingState(source, health);
    });
    if (sending) data.sending = sending;
  }
  return data;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("dm-outreach: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const now = Date.now();
  const result = report(await measure(now, AbortSignal.timeout(SOURCE_DEADLINE_MS)), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`dm-outreach: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
