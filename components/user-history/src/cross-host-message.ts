import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chatService, serviceCall } from "./chat-host.ts";
import { DAEMON_WORKER_START_MS } from "./daemon-worker-start.ts";

/*
 * Agent messages between root sessions on different boxes. Prime's daemon finds a sibling only among the roots it runs itself, so after the
 * owner moved the chats to us-metal02 on 10-18 (03:20Z on), every send from a box chat to a root still on the Mac (Fable, the release owner,
 * the AI harness chat) failed with 'No sibling matches', and land 37 missed Fable's rerun before its 05:14Z deadline. The chat service
 * lists every box's daemon (src/host-catalogs.ts), so it delivers such a send: message-limit-check.py calls this file's CLI when the
 * local daemon finds no sibling, and adds the other boxes' roots to a root's agent_observe.list_agents roster.
 */

/** A root session on some box of hosts.json. */
export interface Root { sessionId: string; activeSessionId?: string; name: string; host: string; status: string }

/** What the routes need from the chat service: every box's live roots, and one send_message on the daemon that runs a session. */
export interface RootDirectory {
  roots(): Promise<Root[]> | Root[];
  send(sessionId: string, text: string): Promise<Record<string, unknown>>;
  /** Opens a root from its file with a daemon create (src/reopen-send.ts); false when it has no file to open. */
  reopen(sessionId: string): Promise<boolean>;
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
  return roots.filter(root => root.host !== own.host);
}

/** The one root `to` names among `roots`: its session id, an id prefix of 8 or more characters, its active session id or its name (any case). */
export function pickRoot(roots: readonly Root[], to: string): Root | { error: string } {
  const wanted = to.trim();
  const lower = wanted.toLowerCase();
  const exact = roots.filter(root => root.sessionId === wanted || root.activeSessionId === wanted);
  const named = exact.length ? exact : roots.filter(root => root.name.trim().toLowerCase() === lower ||
    (wanted.length >= 8 && root.sessionId.startsWith(wanted)));
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

/** `node cross-host-message.ts send|siblings|reopen` with {from, to, message} or {session} and the chat's dataDir on stdin prints the answer or {error}. */
async function cli(op: string): Promise<unknown> {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const dataDir = typeof input.dataDir === "string" ? input.dataDir : join(homedir(), ".prime/agent/browser-chat");
  const service = await chatService(dataDir);
  if (!service) throw new Error("No chat service is set up on this box or in hosts.json.");
  if (op === "send") return await serviceCall(service, "api/agent/message", { from: input.from, to: input.to, message: input.message }, AbortSignal.timeout(60_000));
  if (op === "reopen") return await serviceCall(service, "api/agent/reopen", { from: input.from, to: input.to }, AbortSignal.timeout(DAEMON_WORKER_START_MS));
  if (op === "siblings") return await serviceCall(service, `api/agent/siblings?session=${encodeURIComponent(String(input.session))}`);
  throw new Error(`Unknown op ${op}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv[2] ?? "").then(
    answer => process.stdout.write(`${JSON.stringify(answer ?? { error: "The chat service has no cross-host route (404)." })}\n`),
    error => process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`));
}
