import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type FiringAlert, readGrafanaAlerts } from "../../src/alert-bridge.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { BRIDGE_FILE, alertsFiring } from "./prod-alerts.ts";
import { readFiringRules } from "../../src/alert-bridge.ts";

/**
 * The precheck of the ops chat's duty "VPS and dev boxes" (`node --import tsx scripts/duties/vps-boxes.ts`). The chat's risk list
 * (infra-risks.json, written with the wiki risk page) names each standing risk of the boxes with the Grafana alert rules that check it.
 * risks_firing counts the risks with a rule in Grafana's firing list, read like the alert bridge does (grafana-alerts.json, a Viewer token).
 * disk_days_min is the fewest days until a disk on us-metal01 (/, /ci, /hdd.raid10) or us-metal02 (/, /drive2) is full at the rate
 * its rule reads (DISK_DAYS_QUERY, the math of the metal-host-disk-fill-30d and metal02-dev-disk-fill-30d rules), and air_runners_online counts the M1 Air's runners up, both from
 * the box Prometheus through Grafana ds/query. disk_days_min replaced root_disk_days on 10-19, which read us-metal01's / only (51 days) while
 * us-metal02's / read 6.9. alerts_firing counts the rules the alert bridge holds as firing for this chat, each held
 * by its triage job (prod-alerts.ts). oom_kills_24h sums the OOM kills on us-metal01 and us-metal02 in the last 24 h from node_vmstat_oom_kill,
 * and reads this box's /proc/vmstat when Prometheus has no series for it; it keeps the hold of p456, after us-metal02 had 45 kills since its
 * 10-14 boot, 40 of them from 13:14Z to 16:52Z on 10-19. It leaves out heavy_scope_kills, the kills on this box inside a scope of the `heavy`
 * wrapper (deploy/linux/memory/heavy), which hit the MemoryMax that job chose, not box pressure: two 8G scopes died at 17:26Z and 17:27Z on 10-19
 * with memory pressure full at 0.00. The user journal names the unit of each kill but not its count, so each heavy scope's line counts as one kill
 * and any other kill counts as outside. The duty file's explainedKills list names, per box, the fix step that explains its kills up to a time, and
 * oom_kills_24h counts only the kills after the newest such time inside the 24 h window, so a fixed cause stops holding the number over 0 for a
 * day (p468: p456's 41 kills up to 16:52Z on 10-19 kept it at 41 until 16:52Z on 10-20). oom_kills_explained counts the kills left out.
 * The owner, 10-18: standing risks live on a risk page that a duty checks, not on the plan.
 */

const DATA_DIR = join(homedir(), ".prime/agent/browser-chat");
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
export const RISKS_FILE = join(DATA_DIR, "duties", CHAT, "infra-risks.json");
const GRAFANA_CONFIG = join(DATA_DIR, "grafana-alerts.json");
const PROMETHEUS = { uid: "estate_prometheus_stg", type: "prometheus" };
const DISK_BOXES = ["us-metal01", "us-metal02"] as const;
const diskSeries = (mount: string): string => `node_filesystem_avail_bytes{job=~"host|devbox-linux",box=~"${DISK_BOXES.join("|")}",fstype=~"ext4|xfs|btrfs",${mount}}`;
const TREND = diskSeries('box="us-metal01",mountpoint!~"/boot|/hdd.raid10|/drive2"');
const METAL02_HIGH = `max_over_time(${diskSeries('box="us-metal02",mountpoint!~"/boot|/drive2"')}[6h])`;
const HDD = diskSeries('mountpoint="/hdd.raid10"');
const DRIVE2 = diskSeries('mountpoint="/drive2"');
/** Each disk at the rate its Grafana rule reads (metal-host-disk-fill-30d, metal02-dev-disk-fill-30d): the 24 h deriv, except
 * us-metal02's /, whose rule takes the 24 h deriv of its 6 h high-water mark of free space, so a scratch rig that takes space and gives it
 * back within 6 h counts for nothing (measured: at 18:15Z on 10-22 the raw deriv read 6.2 days and the rule's rate 15.3), and
 * us-metal01's /hdd.raid10, which divides by what it lost over the last 24 h, because it changes in one OpenSearch snapshot step a
 * night and any 24 h window holds exactly one step, and us-metal02's /drive2, which keeps its rule's 7 d deriv for its batch moves.
 * measured: from 10-18 to 10-21 /hdd.raid10 lost 269, 328 and 514 GB a night while its 24 h deriv read 9 to 739 GB a day. */
export const DISK_DAYS_QUERY = `${TREND} / clamp_min(-deriv(${TREND}[24h]) * 86400, 1) or ${METAL02_HIGH} / clamp_min(-deriv(${METAL02_HIGH}[24h:10m]) * 86400, 1) or ${HDD} / clamp_min(${HDD} offset 24h - ${HDD}, 1) or ${DRIVE2} / clamp_min(-deriv(${DRIVE2}[7d]) * 86400, 1)`;
const OOM = `node_vmstat_oom_kill{box=~"${DISK_BOXES.join("|")}"}`;
export const OOM_KILLS_QUERY = `round(increase(${OOM}[1d]))`;
export const OOM_LAST_QUERY = `max_over_time(timestamp(changes(${OOM}[2m]) > 0)[1d:1m])`;
export const oomSinceQuery = (box: string, seconds: number): string => `round(increase(node_vmstat_oom_kill{box="${box}"}[${seconds}s]))`;
export const DUTY_FILE = join(dirname(fileURLToPath(import.meta.url)), "vps-boxes.duty.json");
export const AIR_RUNNERS_QUERY = 'sum(devbox_runner_up{job="devbox",box="m1-air"})';

/** match narrows a shared rule to this risk: each key the alert carries must match its pattern, and an alert without the key still counts.
 * measured: on 10-26 metal-host-disk-fill-30d fired on us-metal01's / and /ci, and the cold-disk risk read as firing with /hdd.raid10 at 7.6 TB free. */
export interface Risk { id: string; line: string; owner: string; alertUids: string[]; match?: Record<string, string> }
export interface RiskFile { page?: string; risks: Risk[] }

export function parseRisks(value: unknown): RiskFile {
  const record = value as { page?: unknown; risks?: unknown };
  if (!record || !Array.isArray(record.risks)) throw new Error("infra-risks.json needs a risks list");
  const risks = record.risks.map((item: unknown, index): Risk => {
    const risk = item as Partial<Risk>;
    if (typeof risk.line !== "string" || !Array.isArray(risk.alertUids)) throw new Error(`infra-risks.json risk ${index} needs a line and alertUids`);
    return { id: typeof risk.id === "string" ? risk.id : String(index), line: risk.line, owner: typeof risk.owner === "string" ? risk.owner : "unknown",
      alertUids: risk.alertUids.filter((uid): uid is string => typeof uid === "string"),
      ...risk.match && typeof risk.match === "object" ? { match: risk.match } : {} };
  });
  return { ...typeof record.page === "string" ? { page: record.page } : {}, risks };
}

const ruleUid = (alert: FiringAlert): string => alert.labels.__alert_rule_uid__ ?? alert.alertname;
const matches = (risk: Risk, alert: FiringAlert): boolean =>
  Object.entries(risk.match ?? {}).every(([key, pattern]) => alert.labels[key] === undefined || new RegExp(`^(?:${pattern})$`).test(alert.labels[key]));

/** The risks whose rules fire, one flagged line each with its owner, plus a line for each risk with no rule and each uid Grafana does not know. */
export function countRisks(file: RiskFile, firing: readonly FiringAlert[], knownUids: ReadonlySet<string> | null, at: number): { firing: number; flagged: FlaggedSlice[] } {
  const flagged: FlaggedSlice[] = [];
  let count = 0;
  for (const risk of file.risks) {
    if (!risk.alertUids.length) { flagged.push({ at, kind: "unchecked", excerpt: `${risk.line.replace(/\.$/, "")} (owner ${risk.owner}): no Grafana rule checks it yet` }); continue; }
    const unknown = knownUids ? risk.alertUids.filter(uid => !knownUids.has(uid)) : [];
    if (unknown.length) flagged.push({ at, kind: "gap", excerpt: `${risk.line.replace(/\.$/, "")}: Grafana has no alert rule ${unknown.join(", ")}` });
    const hits = firing.filter(alert => risk.alertUids.includes(ruleUid(alert)) && matches(risk, alert));
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
  const excerpt = low.length ? `fills within 30 days at its rule's rate: ${low.map(diskName).join(", ")}` : `every disk has 30 days or more; the lowest is ${diskName(sorted[0]!)}`;
  return { days: Math.round(sorted[0]!.days * 10) / 10, flagged: { at, kind: "disk", excerpt } };
}

export interface Explained { box: string; until: number; step: string }
export interface OomKills { box: string; kills: number; lastAt?: number; sinceBootAt?: number; heavy?: number; units?: string[]; outsideAt?: number; explained?: number; by?: Explained }

/** The newest entry per box of the duty file's explainedKills list: the fix step that explains the box's OOM kills up to `until`. */
export function parseExplained(value: unknown): Map<string, Explained> {
  const list = (value as { explainedKills?: unknown } | null)?.explainedKills ?? [];
  if (!Array.isArray(list)) throw new Error("explainedKills needs to be a list");
  const newest = new Map<string, Explained>();
  list.forEach((item: unknown, index) => {
    const entry = item as { box?: unknown; until?: unknown; step?: unknown };
    const until = typeof entry.until === "string" ? Date.parse(entry.until) : NaN;
    if (typeof entry.box !== "string" || typeof entry.step !== "string" || !Number.isFinite(until)) throw new Error(`explainedKills ${index} needs a box, an until time and a step`);
    if ((newest.get(entry.box)?.until ?? -Infinity) < until) newest.set(entry.box, { box: entry.box, until, step: entry.step });
  });
  return newest;
}
export interface OomLine { at: number; unit: string }

const OOM_LINE = /^(\d+)(?:\.\d+)? \S+ systemd\[\d+\]: (\S+): The kernel OOM killer killed some processes in this unit\.$/;
const HEAVY_START = /^Started (run-\S+\.scope) - \[systemd-run\] \S*choom -n 500 -- /;

/**
 * The kills of the journal's OOM lines inside heavy scopes, the other leaf units it names, and the time of the newest of those other lines;
 * a slice line only echoes a kill below it.
 */
export function splitOomLines(journal: string, starts: string): { heavy: number; units: string[]; outsideAt?: number } {
  const heavyScopes = new Set(starts.split("\n").flatMap(line => HEAVY_START.exec(line)?.[1] ?? []));
  const lines = journal.split("\n").flatMap((line): OomLine[] => {
    const match = OOM_LINE.exec(line);
    return match ? [{ at: Number(match[1]) * 1000, unit: match[2]! }] : [];
  });
  const outside = lines.filter(line => !line.unit.endsWith(".slice") && !heavyScopes.has(line.unit));
  const units = new Set(outside.map(line => line.unit));
  return { heavy: lines.filter(line => heavyScopes.has(line.unit)).length, units: [...units], ...outside.length ? { outsideAt: Math.max(...outside.map(line => line.at)) } : {} };
}

const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)}Z on ${new Date(ms).toISOString().slice(5, 10)}`;

/**
 * The OOM kills of both boxes outside heavy scopes and after the time a fix step explains summed, the heavy scope and explained kills apart, and
 * one line for each box with a kill outside or an explained kill, naming its count, its last kill, the units the journal names and the step.
 * `lastEventAt` is the newest counted kill over the boxes with one: the newest outside journal line on this box, else the box's newest kill in
 * Prometheus, else this run when only /proc/vmstat counts it. A count of 0 gives none. AI harness d9 asked for it on 10-22, because without it
 * a count of old kills read the same as a fresh one.
 */
export function oomKills24h(boxes: readonly OomKills[], at: number): { kills: number; heavy: number; explained: number; flagged: FlaggedSlice[]; lastEventAt?: number } {
  const missing = DISK_BOXES.filter(box => !boxes.some(entry => entry.box === box));
  if (missing.length) throw new Error(`no node_vmstat_oom_kill of ${missing.join(" or ")}`);
  const counted = boxes.map(entry => ({ ...entry, outside: Math.max(0, entry.kills - (entry.explained ?? 0) - (entry.heavy ?? 0)) }));
  const flagged = counted.flatMap((entry): FlaggedSlice[] => {
    const heavy = entry.heavy ? ` and ${entry.heavy} more inside heavy scopes` : "";
    const units = entry.units?.length ? `; the journal names ${entry.units.join(", ")}` : "";
    const fix = entry.explained && entry.by ? `${entry.by.step} explains ${entry.explained === 1 ? "the 1 kill" : `the ${entry.explained} kills`} up to ${stamp(entry.by.until)}` : "";
    if (!entry.outside && fix) return [{ at, kind: "oom_explained", excerpt: `${entry.box}: no OOM kill outside heavy scopes${entry.heavy ? ` (${entry.heavy} inside)` : ""} since ${stamp(entry.by!.until)}; ${fix}` }];
    if (!entry.outside) return entry.heavy ? [{ at, kind: "oom_heavy", excerpt: `${entry.box}: ${entry.heavy} OOM kills in the last 24 h, all inside heavy scopes that hit their own MemoryMax` }] : [];
    const window = entry.sinceBootAt ? ` in /proc/vmstat since its boot at ${stamp(entry.sinceBootAt)}, because Prometheus has no node_vmstat_oom_kill for it`
      : `${fix ? ` since ${stamp(entry.by!.until)}` : " in the last 24 h"}${entry.lastAt ? `, the last kill of any kind at about ${stamp(entry.lastAt)}` : ""}`;
    return [{ at, kind: "oom", excerpt: `${entry.box}: ${entry.outside} OOM kills outside heavy scopes${heavy}${window}${units}${fix ? `; ${fix}` : ""}` }];
  });
  const sum = (pick: (entry: typeof counted[number]) => number) => counted.reduce((total, entry) => total + pick(entry), 0);
  const newest = counted.filter(entry => entry.outside).map(entry => entry.outsideAt ?? entry.lastAt ?? at);
  return { kills: sum(entry => entry.outside), heavy: sum(entry => entry.heavy ?? 0), explained: sum(entry => entry.explained ?? 0), flagged,
    ...newest.length ? { lastEventAt: Math.max(...newest) } : {} };
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

async function byBox(expr: string): Promise<Map<string, number>> {
  return new Map((await query(expr)).flatMap((frame): [string, number][] => {
    const box = frame.schema?.fields?.[1]?.labels?.box;
    const value = frame.data?.values?.[1]?.at(-1);
    return box && typeof value === "number" ? [[box, value]] : [];
  }));
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile(command, args, { maxBuffer: 16 << 20 }, (error, stdout) =>
    error && (error as { code?: unknown }).code !== 1 ? fail(error) : done(stdout)));
}

async function procOomKills(box: string): Promise<OomKills> {
  const kills = Number(/^oom_kill (\d+)$/m.exec(await readFile("/proc/vmstat", "utf8"))?.[1]);
  const uptime = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
  if (!Number.isFinite(kills)) throw new Error("/proc/vmstat has no oom_kill line");
  return { box, kills, sinceBootAt: Date.now() - uptime * 1000 };
}

/** Splits each box's 24 h kills at the newest time a fix step explains: the kills up to it are explained, the rest are read again after it. */
async function explain(boxes: OomKills[], explained: Map<string, Explained>, at: number): Promise<void> {
  await Promise.all(boxes.map(async entry => {
    const by = explained.get(entry.box);
    if (!by || entry.sinceBootAt || by.until <= at - 86_400_000) return;
    const after = by.until >= at ? 0 : Math.min(entry.kills, Math.max(0, (await byBox(oomSinceQuery(entry.box, Math.max(60, Math.floor((at - by.until) / 1000))))).get(entry.box) ?? 0));
    Object.assign(entry, { explained: entry.kills - after, by });
  }));
}

async function oomBoxes(at: number): Promise<OomKills[]> {
  const [kills, last, explained] = await Promise.all([byBox(OOM_KILLS_QUERY), byBox(OOM_LAST_QUERY), readFile(DUTY_FILE, "utf8").then(text => parseExplained(JSON.parse(text)))]);
  const boxes: OomKills[] = [...kills].map(([box, count]) => ({ box, kills: count, ...last.has(box) ? { lastAt: last.get(box)! * 1000 } : {} }));
  await explain(boxes, explained, at);
  const here = hostname().split(".")[0]!;
  if (!(DISK_BOXES as readonly string[]).includes(here)) return boxes;
  if (!kills.has(here)) boxes.push(await procOomKills(here));
  const entry = boxes.find(box => box.box === here)!;
  const journal = (args: string[]): Promise<string> => run("journalctl", ["--user", "--no-pager", ...args]);
  const since = entry.sinceBootAt ? new Date(entry.sinceBootAt).toISOString() : entry.explained !== undefined ? new Date(entry.by!.until).toISOString() : "-24h";
  const [lines, starts] = await Promise.all([journal(["--since", since, "-o", "short-unix",
    "-g", "OOM killer killed some processes in this unit"]), journal(["--since", "-7d", "-o", "cat", "-g", "^Started run-.*choom -n 500"])]);
  Object.assign(entry, splitOomLines(lines, starts));
  return boxes;
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
  try {
    const counted = oomKills24h(await oomBoxes(at), at);
    result.metrics.oom_kills_24h = counted.kills;
    result.metrics.heavy_scope_kills = counted.heavy;
    result.metrics.oom_kills_explained = counted.explained;
    if (counted.lastEventAt !== undefined) result.lastEventAt = { oom_kills_24h: counted.lastEventAt };
    result.flagged!.push(...counted.flagged);
  } catch (error) { flag("source_error", `oom_kills_24h: ${error instanceof Error ? error.message : String(error)}`); }
  try { result.metrics.air_runners_online = await instant(AIR_RUNNERS_QUERY); }
  catch (error) { flag("source_error", `air_runners_online: ${error instanceof Error ? error.message : String(error)}`); }
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
