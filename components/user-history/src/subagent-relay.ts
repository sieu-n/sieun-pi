import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SessionSummary } from "prime-agent";

/**
 * A stopped subagent and the sessions above it. The daemon finds a subagent only while its tree's worker holds it, and the chat service's
 * idle unload and its restarts drop subagents from that worker. A send to one then answers "Unknown active session", but a message from
 * its parent's rlm handle (agent_message) reopens it in the parent's tree. On 10-18 at 05:00Z the wake ticker dropped the wakes of five
 * Crawler VP subagents this way (01a14d00, 01a1421b, 01a14c6e, 01a14cb4 and 01a14cce).
 */
export interface StoppedSubagent {
  id: string;
  /** The rlm handle name its parent messages it by. */
  name: string;
  /** The session ids above it, its parent first; a walk of its files lists them up to the tree's root. */
  parents: string[];
}

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** The subagent whose file is `file`, `<id>.jsonl` in a `sub-` folder under `<artifacts>/<root>`, or null for a root's file or a folder with no spawn record. */
export async function stoppedSubagent(file: string): Promise<StoppedSubagent | null> {
  let folder = dirname(file);
  if (!basename(folder).startsWith("sub-")) return null;
  const record = await readFile(join(folder, "rlm-subagent.json"), "utf8").then(text => JSON.parse(text) as { sessionName?: unknown }, () => null);
  const name = typeof record?.sessionName === "string" && record.sessionName ? record.sessionName : null;
  if (!name) return null;
  const parents: string[] = [];
  for (folder = dirname(folder); basename(folder).startsWith("sub-"); folder = dirname(folder)) {
    const own = (await readdir(folder).catch(() => [] as string[])).find(entry => SESSION_FILE.test(entry));
    if (!own) return null;
    parents.push(own.slice(0, -".jsonl".length));
  }
  parents.push(basename(folder));
  return { id: basename(file, ".jsonl"), name, parents };
}

/**
 * A subagent from its daemon row, as any box lists it: its rlm handle name and its parent. It serves a subagent whose file is on another box,
 * since this box's copy of that file has no spawn record (`rlm-subagent.json`) beside it.
 */
export function rowSubagent(row: Pick<SessionSummary, "sessionId" | "sessionName" | "runtimeKind" | "parentSessionId" | "parentSessionPath"> | undefined): StoppedSubagent | null {
  if (row?.runtimeKind !== "subagent" || !row.sessionName) return null;
  const parent = row.parentSessionId ?? (row.parentSessionPath ? basename(row.parentSessionPath, ".jsonl") : undefined);
  return parent ? { id: row.sessionId, name: row.sessionName, parents: [parent] } : null;
}

/** The message for the parent of `child`: send `text` on to it through the rlm handle. */
export function relayNote(child: Pick<StoppedSubagent, "id" | "name">, text: string): string {
  return `[relay] Your subagent "${child.name}" (${child.id}) is stopped, so the chat service could not reach it. ` +
    `Send it the message below with agent_message.send(message, receiver_role="child", receiver_name=${JSON.stringify(child.name)}), ` +
    "which reopens it in your tree. Skip it only if you stopped that subagent on purpose.\n\n" + text;
}

/**
 * The second hop of a relay: once a subagent that the outbox reached through its parent (`relayNote`) runs again after the relay, one line says
 * so and how long after, and its record goes, since the job cleanup needs it only until that run. From 10-19 to 10-22 768 messages to 263
 * stopped subagents went this way, and no record said whether or when a parent passed one on. A record that stays names a relay never passed on.
 */
export async function relayHops(record: { all(): Promise<Record<string, number>>; done(session: string, at: number): Promise<void> },
  rows: Iterable<{ sessionId?: string; sessionName?: string; lastActivityAt?: number }>, log: (line: string) => void): Promise<void> {
  const relayed = await record.all();
  for (const row of rows) {
    const at = row.sessionId ? relayed[row.sessionId] : undefined;
    if (at === undefined || row.lastActivityAt === undefined || row.lastActivityAt <= at) continue;
    await record.done(row.sessionId!, at);
    log(`relay: ${row.sessionId!.slice(0, 8)}${row.sessionName ? ` (${row.sessionName})` : ""} ran at ${new Date(row.lastActivityAt).toISOString()}, ` +
      `${Math.round((row.lastActivityAt - at) / 1000)} s after its message went through its parent`);
  }
}
