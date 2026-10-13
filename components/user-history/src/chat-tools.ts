import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHECKS, RECHECKS_FILE, realDeps, runChecks, type Deps, type Recheck } from "../scripts/duties/skills-and-tools.ts";
import type { DutyStore } from "./chat-duty-store.ts";
import type { Duty, DutyRunRecord, PrecheckOutput } from "./shared/chat-duties.ts";
import type { ToolCheck, ToolKind, ToolsDailyRun, ToolsRecheck, ToolsView } from "./shared/types.ts";

/** The Skills and tools duty's checks that Settings > Tools and skills runs live, in CHECKS order. websearch_query is a paid Virev search. */
const TOOL_CHECK_IDS = new Set(["aside_tabs", "aside_account", "websearch_kernel", "websearch_query", "cua_permissions", "cua_mcp"]);
const TOOL_CHECKS = CHECKS.filter(check => TOOL_CHECK_IDS.has(check.id));
/** How long one live result serves view(false), so opening the tab again does not pay for another search. */
export const TOOLS_CACHE_MS = 5 * 60_000;

/**
 * Settings > Tools and skills on the server. `view(false)` runs the live checks when the last result is older than TOOLS_CACHE_MS and
 * `view(true)` always runs them; calls during a run share it. The daily duty's newest run is read fresh each time.
 */
export function toolChecks(options: { dutyStore?: DutyStore | undefined; deps?: Deps; now?: () => number }): { view(fresh: boolean): Promise<ToolsView> } {
  const now = options.now ?? Date.now;
  let deps = options.deps;
  let last: { checkedAt: number; checks: ToolCheck[] } | undefined;
  let running: Promise<{ checkedAt: number; checks: ToolCheck[] }> | undefined;

  const run = () => running ??= (async () => {
    const results = await runChecks(deps ??= realDeps(tmpdir()), TOOL_CHECKS);
    const checks = results.map(({ check, outcome, ms }): ToolCheck => ({ id: check.id, kind: check.group as ToolKind, tool: check.tool, status: outcome.status,
      detail: outcome.detail, ...(outcome.status === "fail" ? { fix: outcome.fix } : {}), ms }));
    return last = { checkedAt: now(), checks };
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

/** The newest run of any duty whose precheck runs skills-and-tools.ts, across every chat, with the checks its saved output flagged as failing or off. */
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
    return status && typeof slice.item === "string" ? [{ id: slice.item, status, text: String(slice.excerpt ?? "") }] : [];
  });
  const rechecks = await latestRechecks(join(store.dir, RECHECKS_FILE), record.at);
  for (const problem of problems) { const recheck = rechecks.get(problem.id); if (recheck) problem.recheck = recheck; }
  const checksRun = output?.metrics?.checks_run ?? record.metrics.checks_run?.value;
  return { chatId, dutyId: duty.id, name: duty.name, at: record.at, verdict: record.verdict, summary: record.summary,
    checksRun: typeof checksRun === "number" ? checksRun : null, problems };
}
