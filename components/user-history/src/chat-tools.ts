import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_TIMEOUT_MS, CHECKS, checkReport, type CheckReport, RECHECKS_FILE, realDeps, realExec, runChecks, searchPath, type Deps, type Recheck } from "../scripts/duties/skills-and-tools.ts";
import { thisBox } from "./chat-hosts.ts";
import type { DutyStore } from "./chat-duty-store.ts";
import { peerReach, readTailscaleStatus, seenAgo } from "./host-reach.ts";
import { HOST_TOOLS, hostTools, loadHosts, selfHost, type Host, type HostsRegistry, type HostTool } from "./hosts.ts";
import type { Duty, DutyRunRecord, PrecheckOutput } from "./shared/chat-duties.ts";
import { effectiveRun } from "./shared/duty-streak.ts";
import type { HostToolsCard, ToolCheck, ToolsDailyRun, ToolsRecheck, ToolsView } from "./shared/types.ts";

/** The Skills and tools duty's checks that Settings > Tools and skills runs live, in CHECKS order. websearch_query is a paid Virev search. */
const TOOL_CHECK_IDS = new Set(["aside_tabs", "aside_account", "box_browser", "websearch_kernel", "websearch_query", "cua_permissions", "cua_mcp"]);
const TOOL_CHECKS = CHECKS.filter(check => TOOL_CHECK_IDS.has(check.id));
const CHECK_IDS = new Set(CHECKS.map(check => check.id));
/** How long one live result serves view(false), so opening the tab again does not pay for another search. */
export const TOOLS_CACHE_MS = 5 * 60_000;
/**
 * One box's `--results` run over ssh. Its checks run side by side, each cut at CHECK_TIMEOUT_MS; measured: the Mac's run of its six checks took
 * 9.4 s over ssh on 10-19, node and tsx starting included, so 30 s on top of the checks' own cap covers the start.
 */
const REMOTE_TIMEOUT_MS = CHECK_TIMEOUT_MS + 30_000;

/** Runs `ids` on another box and returns their results; tests pass a fake. */
export type RemoteChecks = (host: Host, ids: readonly string[]) => Promise<CheckReport[]>;

const toCheck = (report: CheckReport): ToolCheck => ({ id: report.id, tool: report.tool, status: report.status, detail: report.detail,
  ...(report.status === "fail" && report.fix ? { fix: report.fix } : {}), ms: report.ms });
const isReport = (value: unknown): value is CheckReport => typeof value === "object" && value !== null && typeof (value as CheckReport).id === "string"
  && ["pass", "fail", "off"].includes((value as CheckReport).status) && typeof (value as CheckReport).detail === "string";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * The checks on another box: ssh runs that box's own sieun-pi checkout (`sieun-pi source`) with `--results --only <ids>`, so each check runs
 * where its tool lives. ConnectTimeout=10 is the box's `aside` wrapper's (~/.local/bin/aside-mac).
 */
export function sshChecks(exec: Deps["exec"] = realExec(searchPath(homedir()))): RemoteChecks {
  return async (host, ids) => {
    if (!host.ssh) throw new Error(`hosts.json gives ${host.name} no ssh target`);
    const command = `PATH="$HOME/.local/bin:$PATH"; cd "$(sieun-pi source)/components/user-history" && exec node --import tsx scripts/duties/skills-and-tools.ts --results --only ${ids.join(",")}`;
    const result = await exec("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, command], { timeoutMs: REMOTE_TIMEOUT_MS });
    if (result.code === 124) throw new Error(`the checks on ${host.name} ran past ${REMOTE_TIMEOUT_MS / 1000} s`);
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    let reports: unknown;
    try { reports = JSON.parse(line); } catch { reports = undefined; }
    if (result.code !== 0 || !Array.isArray(reports) || !reports.every(isReport))
      throw new Error(`ssh ${host.name} exit ${result.code}: ${(result.stderr || result.stdout).replace(/\s+/g, " ").trim().slice(0, 300) || "no output"}`);
    return reports;
  };
}

export interface ToolsOptions {
  dutyStore?: DutyStore | undefined;
  /** This box's checks run in-process with these deps. */
  deps?: Deps;
  now?: () => number;
  load?: () => Promise<HostsRegistry>;
  remote?: RemoteChecks;
  /** This box's `tailscale status --json`, null when it cannot be read; another box Tailscale reads offline is not dialed. */
  tailscale?: () => Promise<string | null>;
}

/**
 * Settings > Tools and skills on the server: per box in hosts.json, the tools it is meant to have (its `tools`), each checked on that box, this
 * box in-process and every other box over ssh, all at once. A tool a box is not meant to have is listed as unused and never checked.
 * `view(false)` runs the checks when the last result is older than TOOLS_CACHE_MS and `view(true)` always runs them; calls during a run share it.
 * The daily duty's newest run is read fresh each time.
 */
export function toolChecks(options: ToolsOptions): { view(fresh: boolean): Promise<ToolsView> } {
  const { now = Date.now, load = loadHosts, tailscale = readTailscaleStatus } = options;
  let deps = options.deps;
  const remote = options.remote ?? sshChecks();
  type Live = Omit<ToolsView, "daily">;
  let last: Live | undefined;
  let running: Promise<Live> | undefined;

  const rows = (tools: readonly HostTool[], reports: readonly CheckReport[]): HostToolsCard["tools"] =>
    HOST_TOOLS.map(tool => tools.includes(tool)
      ? { tool, used: true, checks: reports.filter(report => TOOL_CHECKS.find(check => check.id === report.id)?.hostTool === tool).map(toCheck) }
      : { tool, used: false });
  const idsFor = (tools: readonly HostTool[]) => TOOL_CHECKS.filter(check => check.hostTool && tools.includes(check.hostTool)).map(check => check.id);

  async function selfCard(host: Host | null): Promise<HostToolsCard> {
    const tools = hostTools(host);
    const ids = new Set(idsFor(tools));
    const results = await runChecks(deps ??= realDeps(tmpdir()), TOOL_CHECKS.filter(check => ids.has(check.id)));
    return { name: host?.name ?? thisBox(), self: true, state: "checked", checkedAt: now(), tools: rows(tools, results.map(checkReport)) };
  }

  async function remoteCard(host: Host, status: string | null): Promise<HostToolsCard> {
    const tools = hostTools(host);
    const base = { name: host.name, self: false, tools: rows(tools, []) };
    const reach = status === null ? { online: true as const } : peerReach(status, host.address);
    if (!reach.online) return { ...base, state: "unreachable", checkedAt: now(), error: `offline (Tailscale last seen ${seenAgo(now(), reach.lastSeen)})` };
    const ids = idsFor(tools);
    if (!ids.length) return { ...base, state: "checked", checkedAt: now() };
    try { return { ...base, state: "checked", checkedAt: now(), tools: rows(tools, await remote(host, ids)) }; }
    catch (error) { return { ...base, state: "unreachable", checkedAt: now(), error: message(error) }; }
  }

  const run = () => running ??= (async () => {
    let registry: HostsRegistry | null = null, registryError: string | null = null;
    try { registry = await load(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") registryError = message(error); }
    const self = registry ? selfHost(registry) : null;
    const others = registry?.hosts.filter(host => host.name !== self?.name) ?? [];
    const status = others.length ? await tailscale().catch(() => null) : null;
    const hosts = await Promise.all([selfCard(self), ...others.map(host => remoteCard(host, status))]);
    return last = { checkedAt: now(), hosts, registryError };
  })().finally(() => { running = undefined; });

  return {
    async view(fresh) {
      const live = !fresh && last && now() - last.checkedAt < TOOLS_CACHE_MS ? last : await run();
      return { ...live, daily: options.dutyStore ? await dailyRun(options.dutyStore) : null };
    },
  };
}

/** Each check's newest re-check after `since`, from the duty's re-check file; a missing file or a bad line counts as no re-check. */
async function latestRechecks(file: string, since: number): Promise<Map<string, ToolsRecheck>> {
  const latest = new Map<string, ToolsRecheck>();
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    let entry: Partial<Recheck>;
    try { entry = JSON.parse(line) as Partial<Recheck>; } catch { continue; }
    if (typeof entry.at !== "number" || entry.at <= since || !Array.isArray(entry.results)) continue;
    for (const result of entry.results)
      if (typeof result?.id === "string" && entry.at > (latest.get(result.id)?.at ?? 0)) latest.set(result.id, { at: entry.at, status: result.status, detail: String(result.detail ?? "") });
  }
  return latest;
}

/**
 * The newest run of any duty whose precheck runs skills-and-tools.ts, across every chat, with the checks its saved output flagged as failing or off.
 * A flagged check that CHECKS no longer has is dropped, so a removed check (paper_mcp, 10-19) leaves the panel at once instead of after the next run.
 */
export async function dailyRun(store: DutyStore): Promise<ToolsDailyRun | null> {
  let newest: { chatId: string; duty: Duty; record: DutyRunRecord } | undefined;
  for (const chatId of await store.chats()) {
    const duties = (await store.list(chatId).catch(() => [] as Duty[])).filter(duty => duty.precheck.command.join(" ").includes("skills-and-tools.ts"));
    if (!duties.length) continue;
    for (const record of await store.runs(chatId)) {
      const duty = duties.find(item => item.id === record.duty);
      if (duty && (!newest || record.at > newest.record.at)) newest = { chatId, duty, record };
    }
  }
  if (!newest) return null;
  const { chatId, duty, record } = newest;
  const output = record.detail ? await readFile(record.detail, "utf8").then(text => JSON.parse(text) as Partial<PrecheckOutput> | null).catch(() => undefined) : undefined;
  const problems = (Array.isArray(output?.flagged) ? output.flagged : []).flatMap((slice): ToolsDailyRun["problems"] => {
    const status = slice?.kind === "off" ? "off" : slice?.kind === "fail_agent" || slice?.kind === "fail_owner" ? "fail" : undefined;
    return status && typeof slice.item === "string" && CHECK_IDS.has(slice.item) ? [{ id: slice.item, status, text: String(slice.excerpt ?? "") }] : [];
  });
  const rechecks = await latestRechecks(join(store.dir, RECHECKS_FILE), record.at);
  for (const problem of problems) { const recheck = rechecks.get(problem.id); if (recheck) problem.recheck = recheck; }
  const judged = effectiveRun(record);
  const checksRun = output?.metrics?.checks_run ?? judged.metrics.checks_run?.value;
  return { chatId, dutyId: duty.id, name: duty.name, at: record.at, verdict: judged.verdict, summary: judged.summary,
    checksRun: typeof checksRun === "number" ? checksRun : null, problems };
}
