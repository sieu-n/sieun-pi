/**
 * The durable inbox: every agent message a session accepts is written here before Pi queues it, and stays until the message is in the
 * session's transcript. A session that starts again after a kill, an abort followed by a kill, or a host crash replays what its transcript
 * lacks, with the same message id, so each message lands once.
 *
 * Pi keeps steers and follow-ups in memory only, which is why this file exists. It plays the part of Prime's agent outbox.
 * The file is `<agent dir>/agent-bus/inbox/<session id>.jsonl`, one queued record per line, rewritten without the landed ones at each
 * `agent_end`, and removed when nothing is left.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hostApi } from "../../../pi-host/src/api.ts";
import * as registry from "@sieun-pi/pi-family/registry";
import type { customMessage } from "./message.ts";

export interface InboxRecord {
  id: string;
  sessionId: string;
  sessionFile?: string;
  deliverAs: "steer" | "followUp";
  message: ReturnType<typeof customMessage>;
  at: number;
}

export function inboxDir(): string {
  return process.env.PI_AGENT_BUS_INBOX ?? join(getAgentDir(), "agent-bus", "inbox");
}

function fileOf(sessionId: string): string {
  return join(inboxDir(), `${sessionId}.jsonl`);
}

export function record(rec: InboxRecord): void {
  mkdirSync(inboxDir(), { recursive: true });
  appendFileSync(fileOf(rec.sessionId), `${JSON.stringify(rec)}\n`);
}

export function records(sessionId: string): InboxRecord[] {
  const file = fileOf(sessionId);
  if (!existsSync(file)) return [];
  const out: InboxRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as InboxRecord);
    } catch {
      // A torn last line from a crash mid-append holds no message Pi was given, because the append runs before the send.
    }
  }
  return out;
}

/** Keeps only the records whose id `landed` does not hold, and removes the file when none is left. Returns what is left. */
export function keepUnlanded(sessionId: string, landed: ReadonlySet<string>): InboxRecord[] {
  const all = records(sessionId);
  const left = all.filter(rec => !landed.has(rec.id));
  if (left.length === all.length) return left;
  const file = fileOf(sessionId);
  if (left.length === 0) {
    unlinkSync(file);
  } else {
    writeFileSync(`${file}.tmp`, left.map(rec => `${JSON.stringify(rec)}\n`).join(""));
    renameSync(`${file}.tmp`, file);
  }
  return left;
}

/** Drops every queued record of a session. pi-host calls it after `clear_queue`, so a cleared message does not come back on a restore. */
export function clearInbox(sessionId: string): void {
  const file = fileOf(sessionId);
  if (existsSync(file)) unlinkSync(file);
}

/** The ids of every agent message in a session's transcript. */
export function landedIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const e = entry as { type?: string; customType?: string; details?: { id?: unknown } };
    if (e.type === "custom_message" && e.customType === "agent_message" && typeof e.details?.id === "string") ids.add(e.details.id);
  }
  return ids;
}

/**
 * Opens every session that still has queued messages and is not loaded, so its `session_start` replays them. pi-host calls it once at start.
 * Returns the ids it opened.
 */
export async function recoverInboxes(): Promise<string[]> {
  const dir = inboxDir();
  if (!existsSync(dir)) return [];
  const opened: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    const recs = records(sessionId);
    if (recs.length === 0 || registry.get(sessionId)) continue;
    const dormant = registry.dormantOf(sessionId);
    const host = hostApi();
    const file = recs.find(rec => rec.sessionFile && existsSync(rec.sessionFile))?.sessionFile;
    if (dormant) await dormant.wake();
    else if (host) await host.restore(file ?? sessionId);
    else continue;
    opened.push(sessionId);
  }
  return opened;
}
