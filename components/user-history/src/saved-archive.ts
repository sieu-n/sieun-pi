import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { createConnection } from "node:net";

/**
 * The owner archive of a saved session no worker holds: Prime close-keeps-jobs (3e0130b, mem.4.1) keeps a root's heartbeats and cron jobs
 * through an idle unload, so an archive of an unloaded chat must cancel them with `archive_saved_session`, or they stay armed and wake it. The
 * daemon cancels the scheduled jobs of the saved session tree and appends `owner_archive`, and never opens the session (contract from metal
 * agent runtime, p8-metal/saved-session-archive-contract.md). Prime 0.9.8's DaemonClient has no such command, so this sends it on a connection
 * of its own, and only under that connection's hello.
 */
export const SAVED_SESSION_ARCHIVE = "saved_session_archive";
/** The daemon's refusal when a worker holds the file; the caller stops that session with a kill instead. */
export const RESIDENT_REFUSAL = "Cannot archive a resident session";

const PROTOCOL = "prime-agent.daemon";
/** archive_saved_session's minProtocol in DAEMON_COMMAND_COMPATIBILITY; Prime 0.9.8 speaks the same version. */
const PROTOCOL_VERSION = 7;

/**
 * `stopPending`: Prime archived the session and cancelled its scheduled jobs, but could not read a receipt of a service the session handed off
 * (`ownership_unresolved` with `sessionArchived`, detached handoff contract addendum 2026-10-19T01:07Z). That service still runs, and Prime
 * keeps a lasting stop intent that it finishes itself, so nothing here retries the archive. `unresolved` names each receipt and its error.
 */
export type SavedArchive =
  | { kind: "archived" }
  | { kind: "stopPending"; unresolved: string }
  | { kind: "unsupported" }
  | { kind: "resident" }
  | { kind: "failed"; error: string };

/** An archive that holds on the chat service (the row is hidden, a chat stays in archived-chats.json) with part of its stop still open; the archive route answers 502 with the message. */
export class ArchiveLeftWork extends Error {}
/** The session's daemon did not confirm that its scheduled jobs were cancelled, such as when its box is offline. */
export class ScheduledJobsLeft extends ArchiveLeftWork {}
/** The jobs are cancelled and the session archived, and only Prime's stop of a handed-off service waits on a receipt it could not read. */
export class ServicesStopPending extends ArchiveLeftWork {}

/** The receipts an `ownership_unresolved` answer names, as `handoffId: errorClass`. */
function unresolvedOf(info: Record<string, unknown>): string {
  const entries = Array.isArray(info.unresolved) ? info.unresolved.filter(isRecord) : [];
  return entries.map(entry => `${typeof entry.handoffId === "string" ? entry.handoffId : "the receipts folder"}: ${typeof entry.errorClass === "string" ? entry.errorClass : "unreadable"}`).join(", ") || "a receipt";
}

type Hello = { serverCapabilities?: readonly string[]; protocol?: { version?: number } };

/** Whether a daemon hello takes `archive_saved_session`: protocol 7 or later and the capability, as the daemon's own client checks. */
export function takesSavedArchive(hello: Hello | undefined): boolean {
  return (hello?.protocol?.version ?? 0) >= PROTOCOL_VERSION && (hello?.serverCapabilities ?? []).includes(SAVED_SESSION_ARCHIVE);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseHello(message: Record<string, unknown>): Hello {
  const protocol = isRecord(message.protocol) && typeof message.protocol.version === "number" ? { version: message.protocol.version } : undefined;
  const capabilities = Array.isArray(message.serverCapabilities) ? message.serverCapabilities.filter((item): item is string => typeof item === "string") : [];
  return { serverCapabilities: capabilities, ...(protocol ? { protocol } : {}) };
}

const envelope = (command: { id: string; type: string; [field: string]: unknown }, clientId: string, version: number): string =>
  `${JSON.stringify({ type: "command", id: command.id, protocol: { name: PROTOCOL, version }, clientId, command })}\n`;

/**
 * Sends `archive_saved_session { sessionPath }` to the daemon at `socketPath` (this box's daemon socket, or another box's bridge socket) once
 * that connection's hello lists SAVED_SESSION_ARCHIVE, and acknowledges the answer. A hello without it gets nothing and reads `unsupported`.
 * A link that closes or stays silent reads `failed`, since the daemon may not have cancelled anything. It is never replayed.
 */
export function archiveSavedSession(socketPath: string, sessionPath: string, timeoutMs: number): Promise<SavedArchive> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const clientId = `sieun-pi-archive-${randomUUID()}`;
    const id = `archive_${randomUUID()}`;
    let version = PROTOCOL_VERSION;
    let settled = false;
    const done = (result: SavedArchive, last?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (last) socket.end(last); else socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done({ kind: "failed", error: `The daemon did not answer archive_saved_session within ${timeoutMs} ms.` }), timeoutMs);
    socket.once("error", error => done({ kind: "failed", error: error.message }));
    socket.once("close", () => done({ kind: "failed", error: "The daemon connection closed before its answer to archive_saved_session." }));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0 && !settled; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (!isRecord(message)) continue;
        if (message.type === "daemon_hello") {
          const hello = parseHello(message);
          if (!takesSavedArchive(hello)) { done({ kind: "unsupported" }); return; }
          version = Math.min(hello.protocol?.version ?? PROTOCOL_VERSION, PROTOCOL_VERSION);
          socket.write(envelope({ id, type: "archive_saved_session", sessionPath }, clientId, version));
        } else if (message.type === "response" && message.id === id) {
          const ackId = `ack_${randomUUID()}`;
          const ack = envelope({ id: ackId, type: "ack_result", commandId: id }, clientId, version);
          if (message.success === true) { done({ kind: "archived" }, ack); return; }
          const info = isRecord(message.errorInfo) ? message.errorInfo : {};
          if (info.code === "ownership_unresolved" && info.sessionArchived === true) { done({ kind: "stopPending", unresolved: unresolvedOf(info) }, ack); return; }
          const error = typeof message.error === "string" ? message.error : "archive_saved_session failed with no error text.";
          done(error.startsWith(RESIDENT_REFUSAL) ? { kind: "resident" } : { kind: "failed", error }, ack);
        }
      }
    });
  });
}

/** Prime's custom message types that start a turn: a message from another agent, and a heartbeat job's prompt (src/core/messages.ts). */
const AGENT_MESSAGE = "agent_message";
const HEARTBEAT_PROMPT = "heartbeat_prompt";

/**
 * What started turns in a session after `since`. `accepted`: another agent session sent it a message with `agent_message.send`, which the
 * daemon records with the sender's session id and family relationship, so the session answered an authorized message, as an archived chat
 * may (Chats.archive). `unproven`: a user prompt, which a plain cron run writes the same way as a person's message, or an agent message
 * with no sending session. The chat service's own sends (board.wake, brief keeper, alerts, a held send its agent outbox delivers later, a
 * message relayed from another box) go through the daemon's `send_message` with no sender session, so the daemon names only the client id,
 * and such a message may be an automatic wake or one older than the archive. `scheduled`: only heartbeat prompts, which kept jobs fire on
 * their own. `none`: nothing. The owner's own send to an archived chat reopens it through the chat service (`supersede`), never through this
 * file.
 */
export type ResumeSince = "accepted" | "unproven" | "scheduled" | "none";

const RANK: Readonly<Record<ResumeSince, number>> = { none: 0, scheduled: 1, unproven: 2, accepted: 3 };

/** Prime's AgentFamilyRelationship, which the daemon sets only when a session sent the message. */
const FAMILY: ReadonlySet<unknown> = new Set(["parent", "sibling", "child"]);

/** An agent message whose sender the daemon names as another session in the receiver's family, as `agent_message.send` from a kernel makes it. */
function fromSession(details: unknown, self: string): boolean {
  if (!isRecord(details) || !isRecord(details.from) || !FAMILY.has(details.fromRelationship)) return false;
  return typeof details.from.sessionId === "string" && details.from.sessionId !== "" && details.from.sessionId !== self;
}

function trigger(entry: Record<string, unknown>, self: string): ResumeSince {
  const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
  if (message?.role === "user") return "unproven";
  const custom = entry.type === "custom_message" ? entry : message?.role === "custom" ? message : undefined;
  if (custom?.customType === AGENT_MESSAGE) return fromSession(custom.details, self) ? "accepted" : "unproven";
  if (custom?.customType === HEARTBEAT_PROMPT) return "scheduled";
  return "none";
}

/**
 * Classifies the entries stamped after `since` in the JSONL file at `path` of session `self`, read from the end; it throws when the file does
 * not read.
 */
export async function resumeSince(path: string, since: number, self: string): Promise<ResumeSince> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    let found: ResumeSince = "none";
    let end = size;
    let carry = Buffer.alloc(0);
    for (let chunk = 1 << 20; end > 0; chunk *= 2) {
      const start = Math.max(0, end - chunk);
      const read = Buffer.alloc(end - start);
      await file.read(read, 0, read.length, start);
      const bytes = Buffer.concat([read, carry]);
      const cut = start > 0 ? bytes.indexOf(0x0a) : -1;
      end = start;
      if (start > 0 && cut < 0) { carry = bytes; continue; }
      carry = bytes.subarray(0, Math.max(cut, 0));
      const lines = bytes.subarray(cut + 1).toString("utf8").split("\n");
      let older = false;
      for (const line of lines.reverse()) {
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!isRecord(entry) || typeof entry.timestamp !== "string") continue;
        if (Date.parse(entry.timestamp) <= since) { older = true; break; }
        const kind = trigger(entry, self);
        if (kind === "accepted") return kind;
        if (RANK[kind] > RANK[found]) found = kind;
      }
      if (older) break;
    }
    return found;
  } finally { await file.close(); }
}
