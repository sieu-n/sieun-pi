import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "prime-agent";
import { isTopLevel } from "./chat-catalog.ts";
import { DAEMON_WORKER_START_MS } from "./daemon-worker-start.ts";
import { sessionFileOf } from "./send-once.ts";

/*
 * A session whose worker died, or that the daemon dropped, takes no message until something opens it again: each send answers "Session
 * worker is failed" or "Unknown active session". On 10-18 the roots "runner reviewer" (01a11d25) and "verify-dev speed" (01a14b7a) sat failed
 * on the Mac, every send to them was refused, and each workflow change waited on them until a job ran a daemon create with each file by
 * hand (05:37Z and 05:45Z). So a send that gets one of these answers opens the session again and goes out once more: a root through a daemon
 * create with its file, a subagent of a chat tree moved to this box through the spawn-ledger edges adopt-moved-subagents.py appends (on
 * 10-18 us-metal02 answered "Unknown active session" for 94 children of 10 moved chats). A subagent that is still unreachable is left to the
 * caller's relay through its parent (src/subagent-relay.ts).
 */

/** The daemon answers that a reopen clears. */
export const REOPENABLE = /Session worker is failed|Unknown active session/;

/**
 * The active id of the worker that the daemon says already runs a session it was asked to open or reach ("Session is already active in
 * 0aceb76b0e2b: <file>"), else undefined. On 10-20 the Mac's daemon held job 01a156cd ("virev mcp db tools ship") twice: as an inactive
 * subagent of its chat's tree and as a resident worker 0aceb76b0e2b. A send by its session id went to the subagent entry, whose lease that
 * worker held, and the outbox sent it again every 30 s from 03:35Z on, 186 refusals, while a send to 0aceb76b0e2b went through.
 */
export function activeIn(error: string): string | undefined {
  return /Session is already active in ([0-9a-f]{12}):/.exec(error)?.[1];
}

/** The daemon's refusal of a create whose file two of its workers claim, one running it (`activeIn` has the same cause). */
export const AMBIGUOUS = /Ambiguous resident session path/;

export const isReopenable = (error: unknown): boolean => REOPENABLE.test(error instanceof Error ? error.message : String(error));

export type DaemonAnswer = { success: true; data?: unknown } | { success: false; error: string };

type Daemon = { request(command: Record<string, unknown>, timeoutMs: number, options: { recoverable: boolean }): Promise<DaemonAnswer> };

/** What a reopen needs from the chat service's catalog: the session's row, the box and path its own daemon knows, and that daemon. */
export interface ReopenCatalog {
  summary(sessionId: string): Promise<SessionSummary | undefined>;
  daemonPath(summary: Pick<SessionSummary, "sessionId" | "sessionFile">): string | undefined;
  hostOf(id: string): string | null;
  daemonFor(id: string): Promise<Daemon>;
  hostClient(name?: string | null): Promise<Daemon>;
  refresh(): Promise<unknown>;
}

/** This box's Prime folder and the spawn-ledger fix for a moved tree's subagents; `adopt` resolves how many edges it appended. */
export interface ReopenBox {
  agentDir: string;
  adopt?: (root: string) => Promise<number>;
}

const ADOPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prime-relay", "adopt-moved-subagents.py");

/** adopt-moved-subagents.py --apply for one root's tree, one run at a time, since two runs at once would both append the same edges. */
let adopting: Promise<unknown> = Promise.resolve();
export function adoptMoved(root: string, agentDir: string): Promise<number> {
  const run = adopting.then(() => new Promise<number>((resolve, reject) => {
    execFile("python3", ["-B", ADOPT, "--apply", "--root", root], { env: { ...process.env, PRIME_AGENT_DIR: agentDir } }, (error, _stdout, stderr) => {
      if (error) { reject(new Error(`adopt-moved-subagents.py --root ${root.slice(0, 8)}: ${stderr.trim().slice(-300) || error.message}`)); return; }
      resolve(Number(/appended (\d+) edges/.exec(stderr)?.[1] ?? 0));
    });
  }));
  adopting = run.catch(() => {});
  return run;
}

/**
 * Opens `session` again. A root opens from its file with a daemon create, as the chat Resume does; a root whose failed worker is on another
 * box while this box holds its file too (a chat moved here, 17 such roots on the Mac on 10-18) opens here, so no second copy runs there. A
 * subagent of a tree on this box gets its missing spawn-ledger edges. False when there is nothing to open (no file, a subagent with every
 * edge, another box's subagent); throws when the daemon refuses the create.
 */
export async function reopenSession(catalog: ReopenCatalog, box: ReopenBox, session: string, exists: (path: string) => boolean = existsSync): Promise<boolean> {
  const summary = await catalog.summary(session);
  const host = catalog.hostOf(session);
  const here = join(box.agentDir, "sessions", `${session}.jsonl`);
  if (summary && isTopLevel(summary) && summary.sessionFile) {
    if (!host && !exists(summary.sessionFile)) return false;
    const local = !host || exists(here);
    const sessionPath = !host ? summary.sessionFile : local ? here : catalog.daemonPath(summary) ?? summary.sessionFile;
    const daemon = local ? await catalog.hostClient(null) : await catalog.daemonFor(session);
    const response = await daemon.request({ type: "create", lifecycle: "resident", sessionPath }, DAEMON_WORKER_START_MS, { recoverable: false });
    if (!response.success) throw new Error(`reopen of ${session.slice(0, 8)} from ${sessionPath}: ${response.error}`);
    await catalog.refresh().catch(() => {});
    return true;
  }
  if (host || !box.adopt) return false;
  const root = treeRoot(box.agentDir, summary?.sessionFile ?? await sessionFileOf(session, box.agentDir) ?? undefined);
  return root !== null && await box.adopt(root) > 0;
}

/**
 * The owner's unarchive of a root whose file is on another box. This box writes the active state only into its own files (ThreadHub
 * setSessionState), so on 10-18 the app's Unarchive answered ok for the Mac's runner reviewer (01a11d25) and its file stayed archived. A create
 * on its own daemon opens it there and writes the active state. A root that box already runs needs nothing. False for a session on this box.
 */
export async function unarchiveOnItsBox(catalog: ReopenCatalog, box: ReopenBox, session: string): Promise<boolean> {
  if (!catalog.hostOf(session)) return false;
  try { return await reopenSession(catalog, box, session); } catch (error) {
    if (/already.active/i.test(error instanceof Error ? error.message : String(error))) return true;
    throw error;
  }
}

/** The root id of a subagent file `<agentDir>/session-artifacts/<root>/sub-.../<id>.jsonl`, else null. */
export function treeRoot(agentDir: string, file: string | undefined): string | null {
  if (!file) return null;
  const parts = relative(join(agentDir, "session-artifacts"), file).split(sep);
  return parts.length >= 3 && parts[0] && !parts[0].startsWith("..") && parts[1]!.startsWith("sub-") && basename(file).endsWith(".jsonl") ? parts[0] : null;
}

/**
 * `send` to `session`, and when the daemon answers "Session worker is failed" or "Unknown active session", `reopen` and `send` once more. The
 * first answer stands when `reopen` finds nothing to open. A send the daemon refuses because another worker already runs the session goes to
 * that worker (`activeIn`).
 */
export async function sendReopening(session: string, send: (target: string) => Promise<DaemonAnswer>, reopen: (session: string) => Promise<boolean>,
  log?: (line: string) => void): Promise<DaemonAnswer> {
  const first = await send(session);
  if (first.success) return first;
  const running = activeIn(first.error);
  if (running) {
    const moved = await send(running);
    log?.(`send: ${session.slice(0, 8)} answered that worker ${running} runs it; sent there: ${moved.success ? "sent" : moved.error}`);
    return moved;
  }
  if (!REOPENABLE.test(first.error)) return first;
  if (!await reopen(session)) return first;
  const again = await send(session);
  log?.(`reopen: ${session.slice(0, 8)} answered "${first.error}"; opened it again and sent again: ${again.success ? "sent" : again.error}`);
  return again;
}
