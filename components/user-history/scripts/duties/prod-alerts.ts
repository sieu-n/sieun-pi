import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFiringRules, type Tracked } from "../../src/alert-bridge.ts";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The precheck of a chat's alert duty (`node --import tsx scripts/duties/prod-alerts.ts <chatId>`): alerts_firing counts the Grafana rules
 * the alert bridge holds as firing for the chat, read from its state (alert-bridge.json), and flags each with the triage job the bridge gave
 * it. The owner, 10-18: a firing alert feeds a duty, "things are meant to be first written in plan -> achieved -> cleared & written on duty
 * for maintanence only", and the bridge stopped filing plan steps for alerts.
 */

export const BRIDGE_FILE = join(homedir(), ".prime/agent/browser-chat/alert-bridge.json");

/** The chat's firing rules as the duty reads them: the count, and one flagged line per rule, oldest first, with its triage job. */
export function alertsFiring(rules: readonly Tracked[], at: number): { count: number; flagged: FlaggedSlice[] } {
  const sorted = [...rules].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { count: rules.length, flagged: sorted.map(rule => ({ at, kind: "alert_firing", excerpt: (`${rule.rule}${rule.rule.includes(rule.alertname) ? "" : ` (${rule.alertname})`} ` +
    `firing since ${rule.startsAt.slice(0, 16)}Z: ${rule.job ? `triage job "${rule.job.name}" (session ${rule.job.id}), given it ${new Date(rule.job.at).toISOString().slice(0, 16)}Z` : "no triage job yet"}`).slice(0, 600) })) };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  const chat = process.argv[2];
  if (!output || !chat) { process.stderr.write("prod-alerts: needs OUTPUT_FILE and a chat id\n"); process.exit(2); }
  const at = Date.now();
  const result: PrecheckOutput = { metrics: {}, flagged: [] };
  try {
    const counted = alertsFiring(await readFiringRules(BRIDGE_FILE, chat), at);
    result.metrics.alerts_firing = counted.count;
    result.flagged!.push(...counted.flagged);
  } catch (error) { result.flagged!.push({ at, kind: "source_error", excerpt: `alerts_firing: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600) }); }
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
