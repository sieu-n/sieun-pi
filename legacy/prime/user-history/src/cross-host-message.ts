import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatService, serviceCall } from "./chat-host.ts";
import { DAEMON_WORKER_START_MS } from "./daemon-worker-start.ts";
import { isMain } from "./main-module.ts";

/*
 * Agent messages between root sessions on different boxes. Prime's daemon finds a sibling only among the roots it runs itself, so after the
 * owner moved the chats to us-metal02 on 10-18 (03:20Z on), every send from a box chat to a root still on the Mac (Fable, the release owner,
 * the AI harness chat) failed with 'No sibling matches', and land 37 missed Fable's rerun before its 05:14Z deadline. The chat service
 * lists every box's daemon (src/host-catalogs.ts), so it delivers such a send: message-limit-check.py calls this file's CLI when the
 * local daemon finds no sibling, and adds the other boxes' roots to a root's agent_observe.list_agents roster.
 */

/**
 * A root session on some box of hosts.json. `archived` marks a root its daemon lists as archived that this service shows no chat of: a send
 * still reaches it, since an archived root answers a message (owner 10-12), and the outbox opens it from its file, but no roster lists it.
 */
export interface Root { sessionId: string; activeSessionId?: string; name: string; host: string; status: string; archived?: boolean }

/** A daemon's top-level row as `rootsOf` reads it, its name already the sidebar's title. */
export interface RootRow { sessionId: string; activeSessionId?: string; name: string; host: string; status: string; lifecycle?: string }

/**
 * The roots of every box's rows, the first row of a session id kept. A chat this service shows stays a full root while its daemon lists it
 * archived: on 10-21 the Mac's daemon listed slack green guy (01a11b0b) and frontend bro (01a11ba8) archived between the service's unarchives,
 * and from 08:33Z every send to slack green guy from a us-metal02 session read 'No sibling matches "slack green guy" on any box either'.
 */
export function rootsOf(rows: Iterable<RootRow>, chats: ReadonlySet<string>): Root[] {
  const seen = new Set<string>();
  const roots: Root[] = [];
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    const archived = row.lifecycle === "archived" && !chats.has(row.sessionId);
    roots.push({ sessionId: row.sessionId, ...(row.activeSessionId ? { activeSessionId: row.activeSessionId } : {}), name: row.name, host: row.host,
      status: row.status, ...(archived ? { archived } : {}) });
  }
  return roots;
}

/** What the routes need from the chat service: every box's live roots, and one send_message on the daemon that runs a session. */
export interface RootDirectory {
  roots(): Promise<Root[]> | Root[];
  send(sessionId: string, text: string): Promise<Record<string, unknown>>;
  /** Opens a root from its file with a daemon create (src/reopen-send.ts); false when it has no file to open. */
  reopen(sessionId: string): Promise<boolean>;
  /** The line that refuses a send across a running clean-room trial's wall (`judgeCrossing`), or undefined when it may go. */
  refuse?(from: string, to: string, message: string): Promise<string | undefined>;
}

/** The roster row a root on another box adds to agent_observe.list_agents, in the shape Prime's own rows have. */
export function siblingRow(root: Root): Record<string, unknown> {
  return { sessionId: root.sessionId, ...(root.activeSessionId ? { activeSessionId: root.activeSessionId } : {}), sessionName: root.name,
    runtimeKind: "top-level", relationship: "sibling", status: root.status, host: root.host, crossHost: true };
}

/** The roots on every box other than the one that runs `session`; a session no box lists gets an error. */
export async function otherBoxRoots(directory: RootDirectory, session: string): Promise<Root[]> {
  const roots = await directory.roots();
  const own = roots.find(root => root.sessionId === session || root.activeSessionId === session);
  if (!own) throw new Error(`No box lists root session ${session.slice(0, 8)}.`);
  return roots.filter(root => root.host !== own.host && !root.archived);
}

/**
 * The one root `to` names among `roots`: its session id, an id prefix of 8 or more characters, its active session id or its name (any case).
 * An archived root counts only when no other root matches.
 */
export function pickRoot(roots: readonly Root[], to: string): Root | { error: string } {
  const wanted = to.trim();
  const lower = wanted.toLowerCase();
  const match = (among: readonly Root[]): Root[] => {
    const exact = among.filter(root => root.sessionId === wanted || root.activeSessionId === wanted);
    return exact.length ? exact : among.filter(root => root.name.trim().toLowerCase() === lower || (wanted.length >= 8 && root.sessionId.startsWith(wanted)));
  };
  const listed = match(roots.filter(root => !root.archived));
  const named = listed.length ? listed : match(roots.filter(root => root.archived));
  if (named.length === 1) return named[0]!;
  if (!named.length) return { error: `No sibling matches "${wanted}" on any box either.` };
  return { error: `"${wanted}" names ${named.length} roots on other boxes (${named.map(root => `${root.name} ${root.sessionId.slice(0, 8)} on ${root.host}`).join(", ")}); send to one session id.` };
}

/** The delivered text: the daemon heads it with the chat service's client id only, so it names the sender and how to answer. */
export function crossHostText(from: Root, message: string): string {
  return `[cross-host message from ${from.name} (${from.sessionId}) on ${from.host}; answer with agent_message.send(text, receiver_role="sibling", ` +
    `receiver_name=${JSON.stringify(from.sessionId)})]\n\n${message}`;
}

/** Sends `message` from root `from` to the root `to` names on another box; the receipt is the daemon's with the target's box added. */
export async function sendCrossHost(directory: RootDirectory, from: string, to: string, message: string): Promise<Record<string, unknown>> {
  const roots = await directory.roots();
  const sender = roots.find(root => root.sessionId === from || root.activeSessionId === from);
  if (!sender) throw new Error(`No box lists root session ${from.slice(0, 8)}.`);
  const target = pickRoot(roots.filter(root => root.host !== sender.host), to);
  if ("error" in target) throw new Error(target.error);
  const refused = await directory.refuse?.(sender.sessionId, target.sessionId, message);
  if (refused) throw new Error(refused);
  const receipt = await directory.send(target.sessionId, crossHostText(sender, message));
  return { ...receipt, host: target.host, crossHost: true };
}

/**
 * Opens the root `to` names, on any box, from its file. The sender's kernel asks for it when its own daemon answered a sibling send with
 * "Session worker is failed" or "Unknown active session" (message-limit-check.py), then sends once more itself.
 */
export async function reopenSibling(directory: RootDirectory, from: string, to: string): Promise<{ reopened: boolean; sessionId: string; host: string }> {
  const roots = await directory.roots();
  const target = pickRoot(roots.filter(root => root.sessionId !== from && root.activeSessionId !== from), to);
  if ("error" in target) throw new Error(target.error.replace(" on any box either", ""));
  return { reopened: await directory.reopen(target.sessionId), sessionId: target.sessionId, host: target.host };
}

/** `node cross-host-message.ts send|siblings|reopen|queue|route` with {from, to, message} or {session} and the chat's dataDir on stdin prints the answer or {error}. */
async function cli(op: string): Promise<unknown> {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const dataDir = typeof input.dataDir === "string" ? input.dataDir : join(homedir(), ".prime/agent/browser-chat");
  const service = await chatService(dataDir);
  if (!service) throw new Error("No chat service is set up on this box or in hosts.json.");
  if (op === "send") return await serviceCall(service, "api/agent/message", { from: input.from, to: input.to, message: input.message }, AbortSignal.timeout(60_000));
  // A send the sender's daemon refused for the target's pending limit, kept in the service's agent outbox (src/agent-outbox.ts `queue`).
  if (op === "queue") return await serviceCall(service, "api/agent/queue", { from: input.from, to: input.to, role: input.role, message: input.message,
    pending: input.pending, limit: input.limit, behind: input.behind, root: input.root }, AbortSignal.timeout(60_000));
  // A root's sibling send while a clean-room trial runs: whether the trial's wall refuses it (src/clean-room-subjects.ts).
  if (op === "route") return await serviceCall(service, "api/agent/route", { from: input.from, fromName: input.fromName, to: input.to, message: input.message });
  if (op === "reopen") return await serviceCall(service, "api/agent/reopen", { from: input.from, to: input.to }, AbortSignal.timeout(DAEMON_WORKER_START_MS));
  if (op === "siblings") return await serviceCall(service, `api/agent/siblings?session=${encodeURIComponent(String(input.session))}`);
  throw new Error(`Unknown op ${op}.`);
}

if (isMain(import.meta.url)) {
  cli(process.argv[2] ?? "").then(
    answer => process.stdout.write(`${JSON.stringify(answer ?? { error: "The chat service has no cross-host route (404)." })}\n`),
    error => process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`));
}
