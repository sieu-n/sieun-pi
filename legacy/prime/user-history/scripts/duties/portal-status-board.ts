import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { DAY, GRAFANA, REPO, UNMEASURED, readGrafanaAuth } from "./estate-reads.ts";

/**
 * The api-portal agent's "API status board" precheck (`node --import tsx scripts/duties/portal-status-board.ts`). No model call, reads only.
 * The owner asked in #dev-api-portal for an easy status check of the portal (p13, p15, 2026-11-21) and then for "insight on per-platform, and
 * especially endpoints/.. with high latency, error rate" (p19, mww214m1, 2026-11-25). The answer is the Grafana board
 * https://obs.virev.ai/d/virev-api-portal, and this precheck reads what it should show:
 * - slow_endpoints_24h, the endpoints whose p90 over real customers' calls in 24 h is over SLOW_P90_S,
 * - failing_endpoints_24h, the endpoints where over FAILED_PCT of those calls failed on our side,
 * - broken_panels_24h, the live board's panels whose query errors or answers nothing over 24 h.
 * Customer calls are keyed `crawl_read` rows of product.usage_events from orgs outside auto-sns-agent convex/org/houseOrgs.json. The board and
 * this file read Grafana through prod Vent with the grafana-read key: grafana-viewer (Main Org, where the board lives) for the board and its queries.
 */

export const BOARD_UID = "virev-api-portal";
const VIEWER = GRAFANA.replace(/grafana-agents$/, "grafana-viewer");
const CLICKHOUSE = { uid: "estate_ch_prod", type: "grafana-clickhouse-datasource" };
/** The owner's latency bar for an endpoint, from p26 (11-25): youtube/channel_shorts answered p90 25 s and its fix targets 15 s. */
export const SLOW_P90_S = 15;
export const FAILED_PCT = 5;
/** The board's endpoint table skips an endpoint with fewer calls in its range, because a p90 of a few calls is its slowest call. */
export const MIN_CALLS = 20;
/** The 4xx codes that are our refusal, not the caller's mistake: the list of board panel 20 "Which endpoints fail or answer slowly?". */
export const OUR_4XX = ["rate_limited", "crawl_unpaid_paused", "not_cached", "target_refused", "acquisition_credential_unavailable", "scrape_blocked", "login_required"];

export interface HouseOrgs { ids: string[]; prefixes: string[] }
export interface EndpointRow { endpoint: string; calls: number; oursFailed: number; p90S: number; topError: string; lastMs: number }
export interface PanelCheck { id: number; title: string; problem?: "error" | "no_data"; detail?: string }

export function parseHouseOrgs(text: string): HouseOrgs {
  const raw = JSON.parse(text) as { ids?: unknown; prefixes?: unknown };
  const keys = (value: unknown, name: string): string[] => {
    if (!value || typeof value !== "object") throw new Error(`houseOrgs.json has no ${name} map`);
    return Object.keys(value);
  };
  return { ids: keys(raw.ids, "ids"), prefixes: keys(raw.prefixes, "prefixes") };
}

const quote = (value: string): string => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const ourFailure = `http_status >= 500 OR (http_status >= 400 AND error_code IN (${OUR_4XX.map(quote).join(", ")}))`;

export const endpointSql = (house: HouseOrgs): string => [
  "SELECT replaceRegexpOne(route, '^/api/(live/)?', '') AS endpoint, count() AS calls,",
  `countIf(${ourFailure}) AS ours_failed, round(quantile(0.9)(duration_ms) / 1000, 2) AS p90_s,`,
  `topKIf(1)(concat(toString(http_status), ' ', if(error_code = '', 'no code', error_code)), ${ourFailure})[1] AS top_error,`,
  "toUnixTimestamp64Milli(max(ts)) AS last_ms",
  "FROM product.usage_events",
  `WHERE $__timeFilter(ts) AND action = 'crawl_read' AND api_key_id != '' AND org_id NOT IN (${house.ids.map(quote).join(", ")})`,
  ...house.prefixes.map(prefix => `AND NOT startsWith(org_id, ${quote(prefix)})`),
  `GROUP BY endpoint HAVING calls >= ${MIN_CALLS} ORDER BY p90_s DESC`,
].join("\n");

export function report(rows: EndpointRow[], panels: PanelCheck[], errors: string[]): PrecheckOutput {
  const slow = rows.filter(row => row.p90S > SLOW_P90_S);
  const failing = rows.filter(row => (100 * row.oursFailed) / row.calls > FAILED_PCT);
  const broken = panels.filter(panel => panel.problem);
  const failedPct = (row: EndpointRow): number => Math.round((1000 * row.oursFailed) / row.calls) / 10;
  const line = (row: EndpointRow): string => `${row.endpoint}: ${row.calls} customer calls in 24 h, p90 ${row.p90S} s, ${failedPct(row)}% failed on our side` +
    `${row.topError ? ` (most often ${row.topError})` : ""}.`;
  const newest = (list: EndpointRow[]): number | undefined => list.length ? Math.max(...list.map(row => row.lastMs)) : undefined;
  const sourceDown = (name: string): boolean => errors.some(error => error.startsWith(name));
  const metrics = {
    slow_endpoints_24h: sourceDown("endpoints") ? UNMEASURED : slow.length,
    failing_endpoints_24h: sourceDown("endpoints") ? UNMEASURED : failing.length,
    broken_panels_24h: sourceDown("board") ? UNMEASURED : broken.length,
  };
  const flagged: FlaggedSlice[] = [
    ...slow.map(row => ({ kind: "slow_endpoint", excerpt: line(row) })),
    ...failing.map(row => ({ kind: "failing_endpoint", excerpt: line(row) })),
    ...broken.map(panel => ({ kind: `panel_${panel.problem}`, excerpt: `Panel ${panel.id} "${panel.title}" on https://obs.virev.ai/d/${BOARD_UID}: ${panel.detail ?? panel.problem}`.slice(0, 300) })),
    ...errors.map(error => ({ kind: "source_error", excerpt: error.slice(0, 300) })),
  ];
  const lastEventAt: Record<string, number> = {};
  const slowAt = newest(slow);
  const failingAt = newest(failing);
  if (slowAt) lastEventAt.slow_endpoints_24h = slowAt;
  if (failingAt) lastEventAt.failing_endpoints_24h = failingAt;
  return { metrics, flagged, lastEventAt, windowMs: { slow_endpoints_24h: DAY, failing_endpoints_24h: DAY } };
}

interface Frame { schema: { fields: { name: string }[] }; data: { values: unknown[][] } }
interface Panel { id: number; type: string; title: string; repeat?: string; timeFrom?: string; panels?: Panel[];
  targets?: Record<string, unknown>[]; fieldConfig?: { defaults?: { noValue?: string } } }

/** One Grafana query of the Main Org over [from, to]: its frames, or the error text Grafana gave. */
type Query = (target: Record<string, unknown>, from: number, to: number) => Promise<{ frames: Frame[] } | { error: string }>;

const frameRows = (frames: readonly Frame[]): Record<string, unknown>[] => frames.flatMap(frame => {
  const names = frame.schema.fields.map(field => field.name);
  const columns = frame.data.values;
  return Array.from({ length: columns[0]?.length ?? 0 }, (_, row) => Object.fromEntries(names.map((name, column) => [name, columns[column]?.[row]])));
});

/** A panel's own relative range such as "1h", else 24 h. */
export const panelSpanMs = (timeFrom: string | undefined): number => {
  const match = /^(\d+)([mhd])$/.exec(timeFrom ?? "");
  return match ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: DAY }[match[2] as "m" | "h" | "d"] : DAY;
};

const substitute = (value: unknown, vars: Record<string, string>): unknown => typeof value !== "string" ? value
  : value.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced: string | undefined, bare: string | undefined) => vars[braced ?? bare ?? ""] ?? whole);

/** Each panel of the board, its repeat copies run once per value, with the first error or "no data" when nothing came back. */
export async function checkPanels(dashboard: { panels: Panel[]; templating?: { list?: Record<string, unknown>[] } }, query: Query, now: number): Promise<PanelCheck[]> {
  const vars: Record<string, string> = {};
  const repeats: Record<string, string[]> = {};
  for (const variable of dashboard.templating?.list ?? []) {
    const name = String(variable.name);
    if (variable.type === "constant") vars[name] = String(variable.query);
  }
  for (const variable of dashboard.templating?.list ?? []) {
    if (variable.type !== "query") continue;
    const name = String(variable.name);
    const answer = await query({ datasource: variable.datasource, rawSql: substitute(variable.query, vars), format: 1 }, now - DAY, now);
    repeats[name] = "error" in answer ? [] : frameRows(answer.frames).map(row => String(Object.values(row)[0]));
  }
  const flat = (panels: Panel[]): Panel[] => panels.flatMap(panel => [panel, ...flat(panel.panels ?? [])]);
  const checks: PanelCheck[] = [];
  for (const panel of flat(dashboard.panels).filter(panel => panel.type !== "row" && panel.targets?.length)) {
    const copies = panel.repeat ? (repeats[panel.repeat] ?? []).map(value => ({ ...vars, [panel.repeat!]: value })) : [vars];
    const title = String(substitute(panel.title, copies[0] ?? vars));
    if (!copies.length) { checks.push({ id: panel.id, title, problem: "no_data", detail: `its repeat variable ${panel.repeat} has no values` }); continue; }
    let problem: PanelCheck | undefined;
    for (const copy of copies) {
      let rows = 0;
      for (const target of panel.targets!) {
        const run = Object.fromEntries(Object.entries(target).map(([key, value]) => [key, substitute(value, copy)]));
        const answer = await query({ intervalMs: 3_600_000, maxDataPoints: 500, ...run }, now - panelSpanMs(panel.timeFrom), now);
        if ("error" in answer) { problem = { id: panel.id, title, problem: "error", detail: answer.error }; break; }
        rows += frameRows(answer.frames).length;
      }
      if (problem) break;
      // A panel with a noValue text answers "nothing happened" on purpose, such as "No customer call failed by our fault in the last 24 h".
      if (!rows && !panel.fieldConfig?.defaults?.noValue) {
        problem = { id: panel.id, title, problem: "no_data", detail: `no rows over the last ${panelSpanMs(panel.timeFrom) / 3_600_000} h${panel.repeat ? ` for ${panel.repeat}=${copy[panel.repeat]}` : ""}` };
        break;
      }
    }
    checks.push(problem ?? { id: panel.id, title });
  }
  return checks;
}

export async function measure(now: number): Promise<PrecheckOutput> {
  const errors: string[] = [];
  let rows: EndpointRow[] = [];
  let panels: PanelCheck[] = [];
  const auth = await readGrafanaAuth().catch((error: unknown) => { errors.push(`endpoints and board: grafana-read key: ${String(error)}`); return null; });
  if (!auth) return report([], [], ["endpoints: no grafana-read key", "board: no grafana-read key", ...errors]);
  const query: Query = async (target, from, to) => {
    const response = await fetch(`${VIEWER}/api/ds/query`, {
      method: "POST", signal: AbortSignal.timeout(60_000), headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ ...target, refId: "A" }], from: String(from), to: String(to) }),
    });
    const body = await response.json().catch(() => null) as { results?: { A?: { error?: string; frames?: Frame[] } }; message?: string } | null;
    const result = body?.results?.A;
    return !response.ok || !result || result.error ? { error: `Grafana HTTP ${response.status}: ${String(result?.error ?? body?.message ?? "no result").slice(0, 200)}` } : { frames: result.frames ?? [] };
  };
  try {
    const house = parseHouseOrgs(await readFile(join(REPO, "convex/org/houseOrgs.json"), "utf8"));
    const answer = await query({ datasource: CLICKHOUSE, rawSql: endpointSql(house), format: 1 }, now - DAY, now);
    if ("error" in answer) throw new Error(answer.error);
    rows = frameRows(answer.frames).map(row => ({ endpoint: String(row.endpoint), calls: Number(row.calls), oursFailed: Number(row.ours_failed),
      p90S: Number(row.p90_s), topError: String(row.top_error ?? ""), lastMs: Number(row.last_ms) }));
  } catch (error) { errors.push(`endpoints: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const response = await fetch(`${VIEWER}/api/dashboards/uid/${BOARD_UID}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GET dashboard ${BOARD_UID} answered ${response.status}`);
    panels = await checkPanels(((await response.json()) as { dashboard: Parameters<typeof checkPanels>[0] }).dashboard, query, now);
  } catch (error) { errors.push(`board: ${error instanceof Error ? error.message : String(error)}`); }
  return report(rows, panels, errors);
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("portal-status-board: OUTPUT_FILE is not set\n"); process.exit(2); }
  await writeFile(output, JSON.stringify(await measure(Date.now()), null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) await main();
