import { readFile } from "node:fs/promises";
import { setProdTurns, type ProdRecord } from "./chat-pool.ts";
import { parseState } from "./alert-bridge.ts";

/**
 * Prod turns: this service tells pi-pool which trees and chat sessions are on prod work, and the pool runs their turns at once, ahead of its
 * turn queue (`pi-pool prod set`, components/pi-pool/pool/prod.py). The pool knows nothing of deploys or alerts. Two signals make prod work:
 *
 * - A run of a prod deploy workflow (`PROD_DEPLOY_OWNERS`) that GitHub has not completed, read from the CI cache (checkin-load.ts `trainFile`).
 *   Every turn of each owner's tree is a prod turn until the run completes.
 * - An open rule of the alert bridge (alert-bridge.json) for a prod alert: the chat the bridge woke for it gets prod turns until the rule
 *   resolves, and its jobs queue as before.
 *
 * Why: on 10-15 the prod crawler was down from 09:16Z and ingress closed at 09:58Z during promote 10 try 3 (promote.yml run 38708750431,
 * 08:52Z to 10:37Z). At the critical limit of 12 the release owner 01a10810 sat 58th of 60 in the queue at 09:59Z and metal 01a11d24 63rd
 * of 69 at 10:00:38Z.
 */
export const PROD_DEPLOY_OWNERS: Readonly<Record<string, readonly string[]>> = {
  // The release owner dispatches promote.yml, and metal deploys what promote ships and runs metal-deploy.yml.
  "promote.yml": ["01a10810-34b5-710f-88fe-3d369f89a8c9", "01a11d24-ac9b-757d-ac51-9b2b7598782f"],
  "metal-deploy.yml": ["01a11d24-ac9b-757d-ac51-9b2b7598782f"],
};
/** ci-cache rewrites ci-runs.json every 30 s (its intervalSeconds), so one read a tick sees each change within a minute. */
export const PROD_EVERY_MS = 30_000;
/** The record holds two ticks, so one slow tick never drops it and a stopped service leaves no tree marked past a minute. */
export const PROD_HOLD_MS = 2 * PROD_EVERY_MS;
const ALERT_PROD = /\b(prod|production)\b/i;
const ALERT_NOT_PROD = /\b(staging|stg|dev)\b/i;
export const prodAlert = (name: string): boolean => ALERT_PROD.test(name) && !ALERT_NOT_PROD.test(name);

/**
 * {workflow file: run ids} for the runs of `workflows` that GitHub has not completed, from the raw ci-runs.json. The file was 72 MB on 10-15, so
 * this parses only the run objects whose workflow path matches, the way pi-pool did (80 ms a read).
 */
export function runningDeploys(blob: string, workflows: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (!workflows.length) return found;
  const names = workflows.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  for (const match of blob.matchAll(new RegExp(`"path":\\s*"\\.github/workflows/(${names})"`, "g"))) {
    const id = blob.lastIndexOf('"id":', match.index);
    const start = blob.lastIndexOf("{", Math.max(0, id));
    if (id < 0 || start < 0) continue;
    const run = objectAt(blob, start);
    if (run?.path === `.github/workflows/${match[1]}` && run.status !== "completed") found.set(match[1]!, [...found.get(match[1]!) ?? [], String(run.id)]);
  }
  return found;
}

/** The JSON object that opens at `start`, by brace depth outside strings; null when it does not parse. */
function objectAt(blob: string, start: number): Record<string, unknown> | null {
  let depth = 0, inString = false;
  for (let i = start; i < blob.length; i++) {
    const ch = blob[i];
    if (inString) { if (ch === "\\") i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { const value: unknown = JSON.parse(blob.slice(start, i + 1)); return typeof value === "object" && value !== null ? value as Record<string, unknown> : null; } catch { return null; }
    }
  }
  return null;
}

/** {chat session: "alert <name>"} for the bridge's open rules of prod alerts; none when the state does not read. */
export function firingProdAlerts(bridge: unknown): Record<string, string> {
  let rules;
  try { rules = Object.values(parseState(bridge).rules); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const rule of rules) if (rule.resolvedAt === undefined && prodAlert(rule.alertname) && !(rule.chat in out)) out[rule.chat] = `alert ${rule.alertname}`;
  return out;
}

/** The prod record for the pool, or null when nothing is on prod work. */
export function prodRecord(runsBlob: string | null, bridge: unknown, now: number): ProdRecord | null {
  const trees: Record<string, string> = {};
  for (const [workflow, ids] of runningDeploys(runsBlob ?? "", Object.keys(PROD_DEPLOY_OWNERS))) {
    for (const tree of PROD_DEPLOY_OWNERS[workflow] ?? []) trees[tree] ??= `${workflow} run ${ids[0]}`;
  }
  const sessions = firingProdAlerts(bridge);
  return Object.keys(trees).length || Object.keys(sessions).length ? { trees, sessions, until: Math.round((now + PROD_HOLD_MS) / 1000) } : null;
}

export interface ProdTurnsDeps { runsFile: string; bridgeFile: string; log: (line: string) => void; set?: (record: ProdRecord | null) => Promise<void> }

/** Sends the prod record every PROD_EVERY_MS while something is on prod work, and one clear when it ends. Returns the stop function. */
export function startProdTurns(deps: ProdTurnsDeps, everyMs = PROD_EVERY_MS): () => void {
  const set = deps.set ?? setProdTurns;
  let sent = false, running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const [blob, bridge] = await Promise.all([readFile(deps.runsFile, "utf8").catch(() => null),
        readFile(deps.bridgeFile, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null)]);
      const record = prodRecord(blob, bridge, Date.now());
      if (record || sent) await set(record);
      sent = record !== null;
    } catch (error) {
      deps.log(`prod turns: ${error instanceof Error ? error.message : String(error)}`);
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
