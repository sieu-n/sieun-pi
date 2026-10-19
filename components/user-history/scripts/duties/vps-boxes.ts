import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type FiringAlert, readGrafanaAlerts } from "../../src/alert-bridge.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { BRIDGE_FILE, alertsFiring } from "./prod-alerts.ts";
import { readFiringRules } from "../../src/alert-bridge.ts";

/**
 * The precheck of the ops chat's duty "VPS and dev boxes" (`node --import tsx scripts/duties/vps-boxes.ts`). The chat's risk list
 * (infra-risks.json, written with the wiki risk page) names each standing risk of the boxes with the Grafana alert rules that check it.
 * risks_firing counts the risks with a rule in Grafana's firing list, read like the alert bridge does (grafana-alerts.json, a Viewer token).
 * disk_days_min is the fewest days until a disk on us-metal01 (/, /ci, /hdd.raid10) or us-metal02 (/, /drive2) is full at its last 24 h rate,
 * the math of the metal-host-disk-fill-30d and metal02-dev-disk-fill-30d rules, and air_runners_online counts the M1 Air's runners up, both from
 * the box Prometheus through Grafana ds/query. disk_days_min replaced root_disk_days on 10-19, which read us-metal01's / only (51 days) while
 * us-metal02's / read 6.9. alerts_firing counts the rules the alert bridge holds as firing for this chat, each held
 * by its triage job (prod-alerts.ts). The owner, 10-18: standing risks live on a risk page that a duty checks, not on the plan.
 */

const DATA_DIR = join(homedir(), ".prime/agent/browser-chat");
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
export const RISKS_FILE = join(DATA_DIR, "duties", CHAT, "infra-risks.json");
const GRAFANA_CONFIG = join(DATA_DIR, "grafana-alerts.json");
const PROMETHEUS = { uid: "estate_prometheus_stg", type: "prometheus" };
const DISK_BOXES = ["us-metal01", "us-metal02"] as const;
const DISKS = `node_filesystem_avail_bytes{job=~"host|devbox-linux",box=~"${DISK_BOXES.join("|")}",fstype=~"ext4|xfs|btrfs",mountpoint!="/boot"}`;
export const DISK_DAYS_QUERY = `${DISKS} / clamp_min(-deriv(${DISKS}[24h]) * 86400, 1)`;
export const AIR_RUNNERS_QUERY = 'sum(devbox_runner_up{job="devbox",box="m1-air"})';

export interface Risk { id: string; line: string; owner: string; alertUids: string[] }
export interface RiskFile { page?: string; risks: Risk[] }

export function parseRisks(value: unknown): RiskFile {
  const record = value as { page?: unknown; risks?: unknown };
  if (!record || !Array.isArray(record.risks)) throw new Error("infra-risks.json needs a risks list");
  const risks = record.risks.map((item: unknown, index): Risk => {
    const risk = item as Partial<Risk>;
    if (typeof risk.line !== "string" || !Array.isArray(risk.alertUids)) throw new Error(`infra-risks.json risk ${index} needs a line and alertUids`);
    return { id: typeof risk.id === "string" ? risk.id : String(index), line: risk.line, owner: typeof risk.owner === "string" ? risk.owner : "unknown",
      alertUids: risk.alertUids.filter((uid): uid is string => typeof uid === "string") };
  });
  return { ...typeof record.page === "string" ? { page: record.page } : {}, risks };
}

const ruleUid = (alert: FiringAlert): string => alert.labels.__alert_rule_uid__ ?? alert.alertname;

/** The risks whose rules fire, one flagged line each with its owner, plus a line for each risk with no rule and each uid Grafana does not know. */
export function countRisks(file: RiskFile, firing: readonly FiringAlert[], knownUids: ReadonlySet<string> | null, at: number): { firing: number; flagged: FlaggedSlice[] } {
  const flagged: FlaggedSlice[] = [];
  let count = 0;
  for (const risk of file.risks) {
    if (!risk.alertUids.length) { flagged.push({ at, kind: "unchecked", excerpt: `${risk.line.replace(/\.$/, "")} (owner ${risk.owner}): no Grafana rule checks it yet` }); continue; }
    const unknown = knownUids ? risk.alertUids.filter(uid => !knownUids.has(uid)) : [];
    if (unknown.length) flagged.push({ at, kind: "gap", excerpt: `${risk.line.replace(/\.$/, "")}: Grafana has no alert rule ${unknown.join(", ")}` });
    const hits = firing.filter(alert => risk.alertUids.includes(ruleUid(alert)));
    if (!hits.length) continue;
    count++;
    const since = new Map<string, string>();
    for (const hit of hits) if (!since.has(hit.alertname) || hit.startsAt < since.get(hit.alertname)!) since.set(hit.alertname, hit.startsAt);
    const rules = [...since].map(([name, start]) => `${name} firing since ${start}`);
    flagged.push({ at, kind: "firing", excerpt: `${risk.line.replace(/\.$/, "")} (owner ${risk.owner}): ${rules.join("; ")}`.slice(0, 600) });
  }
  return { firing: count, flagged };
}

async function grafana(path: string, init?: RequestInit): Promise<unknown> {
  const config = JSON.parse(await readFile(GRAFANA_CONFIG, "utf8")) as { url: string; token: string };
  const response = await fetch(new URL(path, config.url), { ...init, headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Grafana ${path} answered ${response.status}`);
  return response.json();
}

export interface DiskDays { box: string; mountpoint: string; days: number }

const diskName = (disk: DiskDays): string => `${disk.box}'s ${disk.mountpoint} (${Math.round(disk.days * 10) / 10} days)`;

/** The fewest days to full over every disk, and one line naming the disks under the 30-day target lowest first, or the lowest disk when none is. */
export function diskDaysMin(disks: readonly DiskDays[], at: number): { days: number; flagged: FlaggedSlice } {
  const missing = DISK_BOXES.filter(box => !disks.some(disk => disk.box === box));
  if (missing.length) throw new Error(`Prometheus has no disk of ${missing.join(" or ")}`);
  const sorted = [...disks].sort((a, b) => a.days - b.days);
  const low = sorted.filter(disk => disk.days < 30);
  const excerpt = low.length ? `fills within 30 days at the last 24 h rate: ${low.map(diskName).join(", ")}` : `every disk has 30 days or more; the lowest is ${diskName(sorted[0]!)}`;
  return { days: Math.round(sorted[0]!.days * 10) / 10, flagged: { at, kind: "disk", excerpt } };
}

type Frame = { schema?: { fields?: { labels?: Record<string, string> }[] }; data?: { values?: unknown[][] } };

async function query(expr: string): Promise<Frame[]> {
  const now = Date.now();
  const body = await grafana("/api/ds/query", { method: "POST",
    body: JSON.stringify({ queries: [{ refId: "A", datasource: PROMETHEUS, expr, instant: true, range: false }], from: String(now - 300_000), to: String(now) }) }) as
    { results?: { A?: { error?: string; frames?: Frame[] } } };
  const result = body.results?.A;
  if (!result || result.error) throw new Error(`${expr}: ${result?.error ?? "no result"}`);
  return result.frames ?? [];
}

async function instant(expr: string): Promise<number> {
  const value = (await query(expr))[0]?.data?.values?.[1]?.at(-1);
  if (typeof value !== "number") throw new Error(`${expr}: no sample`);
  return value;
}

async function disks(): Promise<DiskDays[]> {
  return (await query(DISK_DAYS_QUERY)).flatMap((frame): DiskDays[] => {
    const labels = frame.schema?.fields?.[1]?.labels ?? {};
    const days = frame.data?.values?.[1]?.at(-1);
    return typeof days === "number" && labels.box && labels.mountpoint ? [{ box: labels.box, mountpoint: labels.mountpoint, days }] : [];
  });
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("vps-boxes: OUTPUT_FILE is not set\n"); process.exit(2); }
  const at = Date.now();
  const result: PrecheckOutput = { metrics: {}, flagged: [] };
  const flag = (kind: string, excerpt: string) => result.flagged!.push({ at, kind, excerpt: excerpt.slice(0, 600) });
  try {
    const file = parseRisks(JSON.parse(await readFile(RISKS_FILE, "utf8")));
    const firing = await readGrafanaAlerts(GRAFANA_CONFIG);
    if (!firing) throw new Error(`${GRAFANA_CONFIG} is missing`);
    const rules = await grafana("/api/v1/provisioning/alert-rules").catch(() => null) as { uid: string }[] | null;
    const counted = countRisks(file, firing, rules ? new Set(rules.map(rule => rule.uid)) : null, at);
    result.metrics.risks_firing = counted.firing;
    result.flagged!.push(...counted.flagged);
    if (file.page) flag("page", `risk page: ${file.page}`);
  } catch (error) { flag("source_error", `risks_firing: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const counted = alertsFiring(await readFiringRules(BRIDGE_FILE, CHAT), at);
    result.metrics.alerts_firing = counted.count;
    result.flagged!.push(...counted.flagged);
  } catch (error) { flag("source_error", `alerts_firing: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const counted = diskDaysMin(await disks(), at);
    result.metrics.disk_days_min = counted.days;
    result.flagged!.push(counted.flagged);
  } catch (error) { flag("source_error", `disk_days_min: ${error instanceof Error ? error.message : String(error)}`); }
  try { result.metrics.air_runners_online = await instant(AIR_RUNNERS_QUERY); }
  catch (error) { flag("source_error", `air_runners_online: ${error instanceof Error ? error.message : String(error)}`); }
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
