import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The api portal vp chat's "Portal stays up" precheck (`node --import tsx scripts/duties/portal-uptime.ts`). No model call.
 * It reads the prod api probe gauges from Prometheus through Grafana's ds/query on obs.virev.ai (uid estate_prometheus), the way
 * auto-sns-agent scripts/duties/crawler/crawler-pipeline.mjs does. The Convex cron "api health probe" (apps/virev-demo/convex/apiPortal/healthProbe.ts)
 * probes crawler /health, crawler /health/schema and the portal's /openapi.json every minute (every 5 min before auto-sns-agent 2e687fa79), and Prometheus scrapes the result every 60 s
 * from job api-portal-health with the label env="production" (labels checked on 2026-10-12: env, instance, job, target).
 * The 24 h uptime and its newest failed round come from the probe rows in prod Convex instead (PROD_CONVEX below), which an outage of
 * us-metal01, where that Prometheus runs, cannot hide.
 * It also makes one free signed-out GET of https://api.virev.ai/openapi.json as a second view that does not depend on Convex.
 * It makes one more signed-out GET of https://api.virev.ai/docs and counts a page that is not the Scalar reference into probes_down_now,
 * because board goal p110 put the public docs on the same Scalar reference as /dashboard/docs and this duty keeps it there (owner rule c110).
 * It reads the api-portal env files apps/api-portal/.env and .env.staging from GitHub at main (what prod runs) and dev/sieun (what the next
 * promote ships) and counts the key names staging has and prod lacks. Each deploy decrypts its tier's blob (scripts/repo/env/vercel-blobs.mjs),
 * so a staging-only key is a value prod code runs without, as BATCH_WORKER_SECRET is on main on 10-18 (board p9). Key names only, never values.
 * For main, prod's side is the .env the live prod Vercel blob was pushed from, found by the blob's `dotenvx-blob sha256:` comment
 * (auto-sns-agent scripts/repo/env/vercel-blobs.mjs), because a blob push can run ahead of a promote: on 10-18 the p9 job pushed
 * the blob from sieun/dev's .env at 176874bc12, so prod ran with BATCH_WORKER_SECRET while main's .env still lacked it.
 * Staging's side is the .env.staging at that same commit, because a key both tiers dropped together is not a gap: on 10-19 the prod
 * blob was pushed from 2bb4d95732, which drops CLERK_SECRET_KEY, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET from every tier
 * (Clerk and Stripe go through Vent), and main's older .env.staging still listed them, so the count read 3 for keys no tier wants.
 * The note's dm_senders_prod metric is left out: the owner chose reader accounts that send (board p12) over buying aiograpi senders (p6 dropped).
 * A source it cannot read gives 999999 for its counts and -1 for its share, a source_errors count and a flagged slice, never a good-looking value.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const GRAFANA = "https://obs.virev.ai/api/ds/query";
const PROM_UID = "estate_prometheus";
const PORTAL_OPENAPI = "https://api.virev.ai/openapi.json";
export const PUBLIC_DOCS = "https://api.virev.ai/docs";
/**
 * What the server-rendered /docs holds when it is the Scalar reference (p110): the stylesheet chunk of ApiDocsExplorer, which bundles
 * @scalar/api-reference/style.css, and the placeholder that component shows until Scalar mounts. Scalar itself renders in the browser, so the
 * HTML carries no Scalar markup of its own. Read on 2026-10-29 from staging-api.virev.ai/docs, which had both, while prod's hand-built page had neither.
 */
export const SCALAR_MARKERS = ["ApiDocsExplorer", "Loading interactive reference"] as const;
/** True when a /docs page is the Scalar reference: it carries at least one of SCALAR_MARKERS. */
export const docsIsScalar = (html: string): boolean => SCALAR_MARKERS.some(marker => html.includes(marker));
/** The signed-out GET of PUBLIC_DOCS: its status, time, whether the page is Scalar, and the fetch error when it got no answer. */
export interface DocsCheck { status: number; ms: number; scalar: boolean; error?: string }
/** The refs whose api-portal env files are compared: prod's branch and the branch the next promote takes, us-metal02's dev/sieun (c119). */
export const DEV_REF = "dev/sieun";
export const ENV_REFS = ["main", DEV_REF] as const;
/** The "could not measure" value, the same one auto-sns-agent scripts/duties/ci/ci-guarantees.mjs prints, so a missing source can never look on target. */
export const UNMEASURED = 999999;
/** The "could not measure" value of a share: below any target, so an unread uptime never looks on target the way 999999% would. */
export const UNMEASURED_PCT = -1;
export const TARGETS = ["crawler_health", "crawler_schema", "portal_openapi"] as const;
const SEL = 'env="production",job="api-portal-health"';
/**
 * The 24 h uptime and the newest failed round come from the prod Convex table apiPortalHealthProbes, which the probe cron writes and keeps
 * 7 days, not from Prometheus. On 10-29 the docker move on us-metal01 stopped the crawler and the estate Prometheus beside it from 02:55 to
 * 05:01Z, the Convex rows hold 127 failed rounds per crawler target, and avg_over_time(api_probe_up[24h]) still read 99.92% because it
 * skips a gap with no scrapes. The rows live on Convex's own hosts, so an outage of us-metal01 cannot hide in them.
 */
export const PROD_CONVEX = "befitting-sparrow-356";
export const PROBE_TABLE = "apiPortalHealthProbes";
/** One probe run per minute for each target, so 24 h holds at most this many rows (apps/virev-demo/convex/crons.ts "api health probe", every minute). */
export const ROWS_24H = 1440 * 3;
const DAY_MS = 24 * 3_600_000;
/** The PromQL per measure. `age` adds the time since the last scrape, so a scrape that stopped still ages the probe. */
export const QUERIES = {
  up: `api_probe_up{${SEL}}`,
  age: `api_probe_age_seconds{${SEL}} + (time() - timestamp(api_probe_age_seconds{${SEL}}))`,
  p90: `quantile_over_time(0.9, api_probe_latency_ms{${SEL},target="portal_openapi"}[24h])`,
} as const;
export type QueryName = keyof typeof QUERIES;
/** Every measure: the Prometheus queries plus the two read from the Convex probe rows. */
export type Measure = QueryName | "uptime" | "lastDown";
/** What each measure reads, for a flagged row that says which source gave no answer. */
export const SOURCES: Record<Measure, string> = {
  ...QUERIES,
  uptime: `the ${PROBE_TABLE} rows of the last 24 h on Convex ${PROD_CONVEX} (passing rows over all rows, per target)`,
  lastDown: `the newest failed ${PROBE_TABLE} row of the last 24 h on Convex ${PROD_CONVEX}`,
};

/** One Prometheus series from an instant query: its labels and its value. */
export interface Series { labels: Record<string, string>; value: number }
/** The answer to each measure, or the error text when its source gave none. */
export type Answers = Record<Measure, Series[] | { error: string }>;

/** One apiPortalHealthProbes row, the fields the uptime needs. */
export interface ProbeRow { target: string; ok: boolean; createdAt: number }

/**
 * Per target, the share of passing probe rows in the 24 h before `now` (uptime) and the unix second of the newest failed one (lastDown,
 * no series when none failed). A target with no row in the window has no uptime series, so the duty flags it as missing.
 */
export function rowUptime(rows: readonly ProbeRow[], now: number): { uptime: Series[]; lastDown: Series[] } {
  const uptime: Series[] = [];
  const lastDown: Series[] = [];
  for (const target of TARGETS) {
    const mine = rows.filter(row => row.target === target && row.createdAt > now - DAY_MS && row.createdAt <= now);
    if (!mine.length) continue;
    const failed = mine.filter(row => !row.ok);
    uptime.push({ labels: { target }, value: (mine.length - failed.length) / mine.length });
    if (failed.length) lastDown.push({ labels: { target }, value: Math.max(...failed.map(row => row.createdAt)) / 1000 });
  }
  return { uptime, lastDown };
}
/**
 * Sources for the targets in portal-uptime.duty.json (the JSON cannot hold comments):
 * - probes_down_now <= 0 and probe_uptime_24h_pct >= 100: the Grafana rule api-portal-probe-down (auto-sns-agent apps/infra/grafana/alerts.yaml)
 *   treats any api_probe_up below 1 as a failing target. No measurement or vendor limit allows a lower share; the portal's Terms give no uptime figure.
 * - probe_age_min <= 15: the rule api-portal-probe-stale fires when api_probe_age_seconds is over 900 s (the cron probes every 300 s).
 * - env_keys_staging_only <= 0: a key the staging blob has and the prod blob lacks is a prod setting that is missing, so none is allowed.
 * source_errors goes to the run detail: a query with no answer already fails the metric that needed it.
 * probe_uptime_24h_pct gives `lastEventAt`, the epoch ms of the newest minute with a failed probe round it counts (QUERIES.lastDown, to the
 * minute), and none when it reads 100 or was not read. On 10-23 d9 asked for it because the 24 h share stayed red 44 runs in a row after the
 * 10-22 pg_wal cutovers were fixed, so a share no new failure lowered now reads quiet and a fresh failure reads live, as d4's counts do.
 * The note's portal_openapi_p90_ms <= 2000 is printed for the job but not scored, because no measurement or incident backs 2000 ms
 * (measured p90 on 2026-10-12 was 360 ms). The note's dm_senders_prod is left out, see the header.
 */
/** The direct GET gives up at 15 s. measured: the slowest Convex probe of portal_openapi in the 7 d to 2026-10-22 took 2.2 s (api_probe_latency_ms). */
const PROBE_TIMEOUT_MS = 15_000;
/** api-portal-probe-stale's 900 s, in minutes. */
const STALE_MIN = 15;

/** The series in a Grafana ds/query instant result: one frame per series, the value in the last cell of the second field. */
export function framesToSeries(frames: unknown): Series[] {
  if (!Array.isArray(frames)) return [];
  const out: Series[] = [];
  for (const frame of frames as { schema?: { fields?: { labels?: Record<string, string> }[] }; data?: { values?: unknown[][] } }[]) {
    const fields = frame.schema?.fields ?? [];
    const values = frame.data?.values?.[1];
    if (fields.length < 2 || !Array.isArray(values) || !values.length) continue;
    const value = Number(values.at(-1));
    if (Number.isFinite(value)) out.push({ labels: fields[1]!.labels ?? {}, value });
  }
  return out;
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

/** dotenv key names of one env file, without dotenvx's own DOTENV_* keys. */
export const envKeys = (text: string): Set<string> =>
  new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]!).filter(name => !name.startsWith("DOTENV_")));

/** The api-portal env files at one ref, or the error text when GitHub gave none. */
export type EnvFiles = Record<string, { prod: string; staging: string } | { error: string }>;
/** The api-portal .env the live prod Vercel blob was pushed from, the .env.staging at the same commit, and that commit, or why none was found. */
export type LiveProd = { ref: string; text: string; staging: string } | { error: string };

/** vercel-blobs.mjs blobFingerprint: sha256 of the file with its trailing whitespace dropped and one final newline, first 16 hex. */
export const blobFingerprint = (text: string): string =>
  createHash("sha256").update(`${text.replace(/\s+$/, "")}\n`).digest("hex").slice(0, 16);

/** The duty's metrics from the query answers, the direct GET and the env files, with a flagged slice for each down target, gap and unread source. */
export function uptimeMetrics(answers: Answers, direct: { status: number; ms: number; error?: string }, at: number, env: EnvFiles = {}, live?: LiveProd, docs?: DocsCheck): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  let sourceErrors = 0;
  /** The series of one measure, or undefined after flagging why there are none. */
  const read = (name: Measure, needTargets: readonly string[]): Series[] | undefined => {
    const answer = answers[name];
    if ("error" in answer) { sourceErrors++; flagged.push({ at, kind: "source_error", excerpt: `no answer from ${SOURCES[name]}: ${answer.error}`.slice(0, 300) }); return undefined; }
    const missing = needTargets.filter(target => !answer.some(series => series.labels.target === target));
    if (!answer.length || missing.length) {
      sourceErrors++;
      flagged.push({ at, kind: "series_missing", excerpt: `${SOURCES[name]} has no series${missing.length ? ` for ${missing.join(", ")}` : ""}; the api-portal-health scrape or the Convex cron "api health probe" may have stopped` });
      return undefined;
    }
    return answer;
  };
  const metrics: Record<string, number> = {};

  const up = read("up", TARGETS);
  const offline = direct.status === 0 && Object.values(answers).every(answer => "error" in answer && !answer.error.startsWith("HTTP "));
  const docsDown = !offline && docs !== undefined && (docs.status !== 200 || !docs.scalar);
  metrics.probes_down_now = up ? up.filter(series => series.value < 1).length + (docsDown ? 1 : 0) : UNMEASURED;
  for (const series of up ?? []) if (series.value < 1) flagged.push({ at, kind: "down", excerpt: `prod api probe ${series.labels.target} fails now (api_probe_up 0)` });
  if (docs && docsDown) {
    const saw = docs.status === 200 ? `HTTP 200 with no Scalar reference (neither ${SCALAR_MARKERS.map(marker => `"${marker}"`).join(" nor ")} in the HTML)` : docs.error ?? `HTTP ${docs.status}`;
    flagged.push({ at, kind: "public_docs_scalar", excerpt: `public_docs_scalar: signed-out GET ${PUBLIC_DOCS} gave ${saw} after ${docs.ms} ms. Until the portal promote that carries p110 runs, prod /docs is not Scalar yet; it ships with the next portal promote. After that promote a miss here is a regression to fix on staging.` });
  }

  const uptime = read("uptime", TARGETS);
  metrics.probe_uptime_24h_pct = uptime ? round(100 * uptime.reduce((sum, series) => sum + series.value, 0) / uptime.length, 2) : UNMEASURED_PCT;
  for (const series of uptime ?? []) if (series.value < 1) flagged.push({ at, kind: "uptime", excerpt: `prod api probe ${series.labels.target} passed ${round(100 * series.value, 2)}% of its probe rounds over 24 h` });
  const lastEventAt: Record<string, number> = {};
  const lastDown = answers.lastDown;
  if (uptime && metrics.probe_uptime_24h_pct < 100) {
    if ("error" in lastDown) { sourceErrors++; flagged.push({ at, kind: "source_error", excerpt: `no answer from ${SOURCES.lastDown}: ${lastDown.error}`.slice(0, 300) }); }
    else if (lastDown.length) lastEventAt.probe_uptime_24h_pct = 1000 * Math.max(...lastDown.map(series => series.value));
  }

  const age = read("age", TARGETS);
  metrics.probe_age_min = age ? round(Math.min(...age.map(series => series.value)) / 60) : UNMEASURED;
  if (age && metrics.probe_age_min > STALE_MIN) flagged.push({ at, kind: "stale", excerpt: `the newest prod api probe is ${metrics.probe_age_min} min old; the Convex cron runs every minute` });

  const p90 = read("p90", ["portal_openapi"]);
  metrics.portal_openapi_p90_ms = p90 ? Math.round(p90[0]!.value) : UNMEASURED;

  metrics.portal_openapi_direct_ms = direct.ms;
  if (offline) {
    flagged.push({ at, kind: "mac_offline", excerpt: `this Mac reached neither obs.virev.ai nor api.virev.ai (${direct.error ?? "no answer"}), so the run measured nothing about prod; the prod series keep running and the next run reads them` });
  } else if (direct.status !== 200) {
    flagged.push({ at, kind: "direct_down", excerpt: `GET ${PORTAL_OPENAPI} from this Mac gave ${direct.error ?? `HTTP ${direct.status}`} after ${direct.ms} ms` });
    if (up?.find(series => series.labels.target === "portal_openapi")?.value === 1) flagged.push({ at, kind: "disagree", excerpt: "the Convex probe says portal_openapi is up while the direct GET failed" });
  }
  const stagingOnly = new Set<string>();
  let envRead = true;
  for (const ref of ENV_REFS) {
    const files = env[ref];
    if (!files || "error" in files) {
      envRead = false;
      sourceErrors++;
      flagged.push({ at, kind: "source_error", excerpt: `GitHub gave no apps/api-portal/.env or .env.staging at ${ref}: ${files && "error" in files ? files.error : "not read"}`.slice(0, 300) });
      continue;
    }
    const liveText = ref === "main" && live && "text" in live ? live : undefined;
    if (ref === "main" && live && "error" in live) flagged.push({ at, kind: "env_live_unread", excerpt: `the live prod blob's source was not found (${live.error}), so apps/api-portal/.env at main stands in for prod`.slice(0, 300) });
    const prod = envKeys(liveText ? liveText.text : files.prod);
    const prodName = liveText ? `the live prod blob (apps/api-portal/.env at ${liveText.ref})` : `apps/api-portal/.env at ${ref}`;
    const stagingRef = liveText ? liveText.ref : ref;
    const missing = [...envKeys(liveText ? liveText.staging : files.staging)].filter(name => !prod.has(name));
    for (const name of missing) stagingOnly.add(name);
    if (missing.length) flagged.push({ at, kind: "env_staging_only", excerpt: `apps/api-portal/.env.staging at ${stagingRef} has ${missing.join(", ")}, which ${prodName} lacks, so prod runs without ${missing.length > 1 ? "them" : "it"}` });
  }
  metrics.env_keys_staging_only = envRead ? stagingOnly.size : UNMEASURED;
  metrics.source_errors = sourceErrors;
  return { metrics, flagged, ...Object.keys(lastEventAt).length ? { lastEventAt } : {} };
}

/** Grafana basic auth from auto-sns-agent apps/infra/aws/secrets.env, as crawler-pipeline.mjs reads it. */
export function grafanaAuth(secrets: string): string {
  const get = (key: string) => {
    const value = new RegExp(`^${key}=(.*)$`, "m").exec(secrets)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!value || value.startsWith("encrypted:")) throw new Error(`${key} missing or encrypted in apps/infra/aws/secrets.env`);
    return value;
  };
  return `Basic ${Buffer.from(`${get("GRAFANA_ADMIN_USER")}:${get("GRAFANA_ADMIN_PASSWORD")}`).toString("base64")}`;
}

/** A fetch error with its network code, so "fetch failed" from an offline Mac reads as ENETUNREACH or ENOTFOUND. */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; errors?: { code?: string }[] } | undefined;
  const code = cause?.code ?? cause?.errors?.find(item => item.code)?.code;
  return code ? `${error.message} (${code})` : error.message;
}

async function instant(auth: string, expr: string, now: number): Promise<Series[]> {
  const response = await fetch(GRAFANA, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    // ds/query needs a from and a to; an instant query evaluates at `to` only, so the hour before it changes nothing.
    body: JSON.stringify({ queries: [{ refId: "A", datasource: { uid: PROM_UID }, expr, range: false, instant: true }], from: String(now - 3_600_000), to: String(now) }),
  });
  const body = await response.json().catch(() => null) as { results?: { A?: { frames?: unknown; error?: string } }; message?: string } | null;
  const result = body?.results?.A;
  if (!response.ok || !result || result.error) throw new Error(`HTTP ${response.status}: ${String(result?.error ?? body?.message ?? "no result").slice(0, 160)}`);
  return framesToSeries(result.frames);
}

/** One gh api GET on sieu-n/auto-sns-agent, through the gh login. */
const ghApi = (path: string, accept: string) => new Promise<string>((resolve, reject) => {
  execFile("gh", ["api", "-H", `Accept: ${accept}`, `repos/sieu-n/auto-sns-agent/${path}`],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => error ? reject(new Error(`${path}: ${String(stderr).trim().slice(-160) || error.message}`)) : resolve(stdout));
});
/** One file of sieu-n/auto-sns-agent at a ref. */
const githubRaw = (path: string, ref: string) => ghApi(`contents/${path}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw");

/** How many past versions of dev/sieun's apps/api-portal/.env are tried against the live blob's fingerprint. */
const LIVE_HISTORY = 20;

/** The .env the live prod api-portal blob was pushed from: the newest of main's, dev/sieun's and dev/sieun's recent versions whose fingerprint is the blob's comment, with the .env.staging beside it. */
async function liveProdSource(env: EnvFiles): Promise<LiveProd> {
  try {
    const blobs = await import(pathToFileURL(join(REPO, "scripts/repo/env/vercel-blobs.mjs")).href) as { blobRow(app: string, tier: string): Promise<{ comment?: string } | null> };
    const row = await blobs.blobRow("api-portal", "production");
    const want = /dotenvx-blob sha256:([0-9a-f]{16})/.exec(row?.comment ?? "")?.[1];
    if (!want) return { error: `the prod API_PORTAL_DOTENVX_ENV row has no dotenvx-blob comment (${row ? "row found" : "no row"})` };
    for (const ref of ENV_REFS) {
      const files = env[ref];
      if (files && "prod" in files && blobFingerprint(files.prod) === want) return { ref, text: files.prod, staging: files.staging };
    }
    const commits = JSON.parse(await ghApi(`commits?path=apps/api-portal/.env&sha=${encodeURIComponent(DEV_REF)}&per_page=${LIVE_HISTORY}`, "application/vnd.github+json")) as { sha: string }[];
    for (const { sha } of commits) {
      const text = await githubRaw("apps/api-portal/.env", sha);
      if (blobFingerprint(text) === want) return { ref: sha.slice(0, 10), text, staging: await githubRaw("apps/api-portal/.env.staging", sha) };
    }
    return { error: `no apps/api-portal/.env at main, ${DEV_REF} or its last ${LIVE_HISTORY} versions has sha256:${want}` };
  } catch (error) { return { error: errorText(error) }; }
}

/** The env the Convex CLI runs with: no self-hosted or deployment keys, so --deployment-name picks the cloud deployment from the Convex login. */
const cloudEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of ["CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY"]) delete env[key];
  return env;
};

/**
 * The newest ROWS_24H apiPortalHealthProbes rows on prod Convex, through the auto-sns-agent Convex CLI and the Convex login in
 * ~/.convex/config.json. It runs from the home folder, because the checkout's .env.local names the self-hosted local backend and the CLI
 * then refuses --deployment-name. measured: 4320 rows were 967,955 bytes and 2.8 s on 10-29 from us-metal02.
 */
export const probeRows = () => new Promise<ProbeRow[]>((resolve, reject) => {
  execFile(join(REPO, "node_modules/.bin/convex"), ["data", PROBE_TABLE, "--deployment-name", PROD_CONVEX, "--limit", String(ROWS_24H), "--order", "desc", "--format", "jsonLines"],
    // measured: 967,955 bytes for 4320 rows on 10-29, so 8 MiB holds eight times that.
    { cwd: homedir(), env: cloudEnv(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`convex data ${PROBE_TABLE}: ${String(stderr).trim().slice(-160) || error.message}`));
      resolve(stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as ProbeRow));
    });
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("portal-uptime: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const names = Object.keys(QUERIES) as QueryName[];
  let answers: Answers;
  try {
    const auth = grafanaAuth(await readFile(join(REPO, "apps/infra/aws/secrets.env"), "utf8"));
    const settled = await Promise.all(names.map(name => instant(auth, QUERIES[name], now).catch((error: unknown) => ({ error: errorText(error) }))));
    answers = Object.fromEntries(names.map((name, index) => [name, settled[index]!])) as Answers;
  } catch (error) {
    const message = errorText(error);
    answers = Object.fromEntries(names.map(name => [name, { error: message }])) as Answers;
  }
  try {
    Object.assign(answers, rowUptime(await probeRows(), now));
  } catch (error) {
    const message = errorText(error);
    Object.assign(answers, { uptime: { error: message }, lastDown: { error: message } });
  }
  const start = Date.now();
  const direct = await fetch(PORTAL_OPENAPI, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    .then(async response => { await response.arrayBuffer(); return { status: response.status, ms: Date.now() - start }; },
      (error: unknown) => ({ status: 0, ms: Date.now() - start, error: errorText(error) }));
  const docsStart = Date.now();
  const docs: DocsCheck = await fetch(PUBLIC_DOCS, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    .then(async response => ({ status: response.status, scalar: docsIsScalar(await response.text()), ms: Date.now() - docsStart }),
      (error: unknown) => ({ status: 0, scalar: false, ms: Date.now() - docsStart, error: errorText(error) }));
  const env: EnvFiles = Object.fromEntries(await Promise.all(ENV_REFS.map(async ref => {
    try {
      const [prod, staging] = await Promise.all([".env", ".env.staging"].map(file => githubRaw(`apps/api-portal/${file}`, ref)));
      return [ref, { prod: prod!, staging: staging! }] as const;
    } catch (error) { return [ref, { error: errorText(error) }] as const; }
  })));
  await writeFile(output, JSON.stringify(uptimeMetrics(answers, direct, now, env, await liveProdSource(env), docs), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
