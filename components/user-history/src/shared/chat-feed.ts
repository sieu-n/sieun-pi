import { isPromptCustom, messageText, toolResults, triggerSummary } from "./turns.ts";
import type { AssistantMessage, ChatWait, CustomMessage, ImagePart, ThreadMessage, ThreadState, UserMessage } from "./types.ts";

/** A message the owner sent from the chat composer that the thread has not echoed back yet. `images` are data URLs for the bubble. */
export interface PendingSend { id: string; text: string; images: ImagePart[]; at: number }

/** The tool a chat calls to reach the owner on a turn the owner did not start. Its `text` shows as an agent bubble unless the tool refused it. */
export const TELL_OWNER_TOOL = "tell_owner";
/** The longest text `tell_owner` accepts; the tool refuses longer with "shorter: one or two sentences". */
export const TELL_OWNER_LIMIT = 400;
/** A user message the chat server sends on its own: the check-in digest and the no-report notice. The feed folds them into updates and the turn they start is not the owner's. */
export const CHECK_IN_PREFIX = "[check-in] ";
export const JOB_NOTICE_PREFIX = "[job] ";
const SERVER_NOTES: readonly [string, string][] = [[CHECK_IN_PREFIX, "check-in"], [JOB_NOTICE_PREFIX, "jobs"]];
/** In a server note that restarts a failed owner turn: the turn it starts stays the owner's, so the chat's answer is a bubble and check-ins wait. */
export const OWNER_RETRY_MARK = "The owner's message is still unanswered: ";
/** The first line of a chat_board result when the chat changed its own check-in; the feed shows that line as a notice. */
export const CHAT_CHECK_IN_LINE = "The chat set its check-in: ";
/** A line the server writes into a chat's transcript without starting a turn (the model switch to and from the fallback); the feed shows it as a notice. */
export const CHAT_NOTICE = "chat_notice";
/** Who sent a server note ("check-in", "jobs"), or undefined for a message the owner typed. */
export function serverNote(text: string): string | undefined { return SERVER_NOTES.find(([prefix]) => text.startsWith(prefix))?.[1]; }

/**
 * One message of a chat as a line, before the feed collapses the quiet ones. Who started the turn decides what the chat's own text is:
 * - user: what the owner typed (right side); `pending` until the thread echoes the message back.
 * - agent: what the owner reads from the chat (left side): the chat's text on a turn the owner started, or a `tell_owner` call on any turn
 *   (`told`); `streaming` while the model is still writing it.
 * - job: a message another agent sent the chat; `from` is its display name. `clipped` names the message and part to fetch through
 *   `api/threads/:id/part` when the snapshot holds only the first 2 KiB of the body.
 * - notes: the chat's text on a turn another agent, a check-in or a job notice started. The owner sees it only inside an updates list.
 * - notice: an error, a stopped reply, a restart or a compaction, as one muted line.
 */
export type ChatLine =
  | { kind: "user"; id: string; text: string; images: ImagePart[]; at: number; pending?: true }
  | { kind: "agent"; id: string; text: string; at: number; streaming?: true; told?: true }
  | { kind: "job"; id: string; from: string; title: string; body: string; at: number; clipped?: { message: number; part: number } }
  | { kind: "notes"; id: string; text: string; at: number }
  | { kind: "notice"; id: string; text: string; at: number };
/** The quiet lines: between two visible lines they fold into one updates item. */
export type Update = Extract<ChatLine, { kind: "job" | "notes" }>;
/** One item of the feed on screen: a visible line, or a run of quiet lines folded into one. */
export type ChatItem = Exclude<ChatLine, Update> | { kind: "updates"; id: string; at: number; entries: Update[] };

/** Who started a turn: the owner (a user message, `[board] ` lines included) or something else (an agent message, a check-in, a job notice). */
export type TurnStarter = "owner" | "agent";
/** The display name of a session id in an agent-message header; undefined when the catalog does not list it. */
export type NameOf = (sessionId: string) => string | undefined;

/** A user message echoed by the daemon up to this long before the browser's send time still settles the pending send (clock skew between devices). */
export const PENDING_SKEW_MS = 5 * 60_000;

const imagesOf = (message: UserMessage | CustomMessage): ImagePart[] =>
  typeof message.content === "string" ? [] : message.content.filter((part): part is ImagePart => part.type === "image");

const firstLine = (text: string): string => text.split("\n").map(line => line.trim()).find(Boolean) ?? "";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The display name for an agent-message sender: a job by its name, a session by its catalog name, a raw id nobody lists as "another thread". */
export function senderName(from: string, nameOf: NameOf = () => undefined): string {
  const raw = from.replace(/^(?:child|sibling|parent):/, "").trim();
  if (!raw) return "another thread";
  if (!SESSION_ID.test(raw)) return raw;
  return nameOf(raw)?.trim() || "another thread";
}

type Refused = (toolCallId: string) => boolean;
/** The check-in line a tool result opens with, when the chat changed its check-in; undefined otherwise. */
type CheckInChanged = (toolCallId: string) => string | undefined;
function assistantLines(message: AssistantMessage, id: string, starter: TurnStarter, streaming: boolean, refused: Refused, checkInChanged: CheckInChanged = () => undefined): ChatLine[] {
  const lines: ChatLine[] = [];
  const text = messageText(message).trim();
  if (text && starter === "owner") lines.push({ kind: "agent", id, text, at: message.timestamp, ...(streaming ? { streaming: true } : {}) });
  else if (text && !streaming) lines.push({ kind: "notes", id, text, at: message.timestamp });
  if (streaming) return lines;
  message.content.forEach((part, index) => {
    const changed = part.type === "toolCall" ? checkInChanged(part.id) : undefined;
    if (changed) lines.push({ kind: "notice", id: `${id}-c${index}`, text: changed, at: message.timestamp });
    if (part.type !== "toolCall" || part.name !== TELL_OWNER_TOOL || refused(part.id)) return;
    const told = typeof part.arguments.text === "string" ? part.arguments.text.trim() : "";
    if (told) lines.push({ kind: "agent", id: `${id}-t${index}`, text: told, at: message.timestamp, told: true });
  });
  if (message.stopReason === "aborted") lines.push({ kind: "notice", id: id + "-stop", text: "Reply stopped", at: message.timestamp });
  else if (message.stopReason === "error") lines.push({ kind: "notice", id: id + "-error", text: "Error: " + (message.errorMessage?.trim() || "the model returned an error"), at: message.timestamp });
  return lines;
}

function customLines(message: CustomMessage, id: string, index: number, nameOf: NameOf): ChatLine[] {
  if (message.customType === "agent_message") {
    const summary = triggerSummary(message);
    const from = senderName(summary.detail.replace(/^from\s+/, ""), nameOf);
    const part = typeof message.content === "string" ? -1 : message.content.findIndex(entry => entry.type === "text" && entry.truncated);
    return [{ kind: "job", id, from, title: firstLine(summary.body) || "(empty message)", body: summary.body, at: message.timestamp, ...(part >= 0 ? { clipped: { message: index, part } } : {}) }];
  }
  if (message.customType === "prime-agent.update_restart") return [{ kind: "notice", id, text: "Prime Agent restarted", at: message.timestamp }];
  if (message.customType === CHAT_NOTICE) return [{ kind: "notice", id, text: messageText(message).trim(), at: message.timestamp }];
  return [];
}

/**
 * Every committed message as lines, in order, with the turn tracked the way `buildTurns` does: a user message starts an owner turn; a
 * wake-up custom (agent message, heartbeat, job notice, background completion) starts an agent turn when the last run had settled, and
 * joins the running turn otherwise. The chat's text is an agent line on an owner turn and a notes line on an agent turn; a `tell_owner` call
 * is an agent line on either, unless the tool refused the text. Check-ins, job notices and background completions themselves produce nothing: what the chat told the owner
 * about them is the line. toolResult, bashExecution, branchSummary and non-prompt customs produce nothing.
 */
export function chatLines(messages: readonly ThreadMessage[], nameOf: NameOf = () => undefined): ChatLine[] {
  const lines: ChatLine[] = [];
  const track = turnTracker();
  const results = toolResults(messages);
  const refused: Refused = toolCallId => results.get(toolCallId)?.isError === true;
  const checkInChanged: CheckInChanged = toolCallId => {
    const result = results.get(toolCallId);
    if (!result || result.isError) return undefined;
    const first = messageText(result).split("\n", 1)[0]!.trim();
    return first.startsWith(CHAT_CHECK_IN_LINE) ? first : undefined;
  };
  messages.forEach((message, index) => {
    const id = "m" + index;
    const starter = track(message);
    switch (message.role) {
      case "user": {
        const text = messageText(message).trim();
        const from = serverNote(text);
        if (from) { const body = text.slice(text.indexOf("]") + 1).trim(); lines.push({ kind: "job", id, from, title: firstLine(body), body, at: message.timestamp }); return; }
        lines.push({ kind: "user", id, text, images: imagesOf(message), at: message.timestamp });
        return;
      }
      case "assistant": lines.push(...assistantLines(message, id, starter, false, refused, checkInChanged)); return;
      case "custom": lines.push(...customLines(message, id, index, nameOf)); return;
      case "compactionSummary": lines.push({ kind: "notice", id, text: "Older messages were summarized to free space", at: message.timestamp }); return;
      case "toolResult":
      case "bashExecution":
      case "branchSummary":
        return;
    }
  });
  return lines;
}

/** Feeds each message in order and answers who started the turn it belongs to. */
function turnTracker(): (message: ThreadMessage) => TurnStarter {
  let starter: TurnStarter = "owner";
  let settled = true;
  return message => {
    if (message.role === "user" && messageText(message).includes(OWNER_RETRY_MARK) && serverNote(messageText(message).trim())) { starter = "owner"; settled = false; }
    else if (message.role === "user" && serverNote(messageText(message).trim())) { if (settled) starter = "agent"; settled = false; }
    else if (message.role === "user") { starter = "owner"; settled = false; }
    else if (message.role === "assistant") settled = message.stopReason !== "toolUse";
    else if (message.role === "custom" && isPromptCustom(message)) { if (settled) starter = "agent"; settled = false; }
    return starter;
  };
}

/** Who started the turn the thread is on now: the owner until something else wakes a settled chat. */
export function turnStarter(messages: readonly ThreadMessage[]): TurnStarter {
  const track = turnTracker();
  let starter: TurnStarter = "owner";
  for (const message of messages) starter = track(message);
  return starter;
}

const isUpdate = (line: ChatLine): line is Update => line.kind === "job" || line.kind === "notes";

/** The lines with every run of quiet ones (job messages, the chat's notes) folded into one updates item, keyed by its first line. */
export function collapseUpdates(lines: readonly ChatLine[]): ChatItem[] {
  const items: ChatItem[] = [];
  let group: Extract<ChatItem, { kind: "updates" }> | null = null;
  for (const line of lines) {
    if (isUpdate(line)) {
      if (!group) { group = { kind: "updates", id: "u" + line.id, at: line.at, entries: [] }; items.push(group); }
      group.entries.push(line);
      continue;
    }
    group = null;
    items.push(line);
  }
  return items;
}

/** How many feed rows the owner has not read: the chat's replies and folded update runs with a message after `since` (the read marker, ms). */
export function unreadCount(messages: readonly ThreadMessage[], since: number, nameOf: NameOf = () => undefined): number {
  return collapseUpdates(chatLines(messages, nameOf)).filter(item =>
    item.kind === "agent" ? item.at > since : item.kind === "updates" ? item.entries.some(entry => entry.at > since) : false).length;
}

/** A session titled by its first message can run long; the folded line clips each name to this. */
const NAME_LIMIT = 32;
const clipName = (name: string): string => name.length > NAME_LIMIT ? name.slice(0, NAME_LIMIT - 1).trimEnd() + "\u2026" : name;

/** "4 updates" and the senders in the order they wrote, up to three, for the folded line. */
export function updatesLabel(item: Extract<ChatItem, { kind: "updates" }>): { count: string; names: string } {
  const count = item.entries.length === 1 ? "1 update" : `${item.entries.length} updates`;
  const names = [...new Set(item.entries.flatMap(entry => entry.kind === "job" ? [entry.from] : []))].map(clipName);
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  return { count, names: more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ") };
}

/** Ids of the pending sends a user message in `messages` has settled: same text, and not from before the send (minus clock skew). Each message settles at most one. */
export function settledPending(messages: readonly ThreadMessage[], pending: readonly PendingSend[]): Set<string> {
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message).trim();
    const match = pending.find(send => !settled.has(send.id) && send.text === text && message.timestamp >= send.at - PENDING_SKEW_MS);
    if (match) settled.add(match.id);
  }
  return settled;
}

/**
 * The whole chat, oldest first: every message as lines with the quiet runs folded, then the streaming reply when the owner started the turn,
 * then the sends the thread has not echoed yet.
 */
export function chatFeed(state: Pick<ThreadState, "messages" | "streaming" | "wait">, pending: readonly PendingSend[] = [], nameOf: NameOf = () => undefined): ChatItem[] {
  const lines = chatLines(state.messages, nameOf);
  if (state.streaming) lines.push(...assistantLines(state.streaming, "streaming", turnStarter(state.messages), true, () => true));
  const items = collapseUpdates(lines);
  const settled = settledPending(state.messages, pending);
  for (const send of pending) {
    if (settled.has(send.id)) continue;
    items.push({ kind: "user", id: "p" + send.id, text: send.text, images: send.images, at: send.at, pending: true });
  }
  if (state.wait) items.push({ kind: "notice", id: "wait", text: waitText(state.wait), at: items.at(-1)?.at ?? 0 });
  return items;
}

const clock = (at: number): string => { const date = new Date(at); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
/** The line under the owner's unanswered message while the server waits to restart its failed turn, in the reader's local time. */
export function waitText(wait: ChatWait): string {
  if (wait.kind === "retry") return `Turn failed (${wait.error}). Retrying at ${clock(wait.at)}.`;
  return wait.until === null ? "Waiting for a Claude account." : `Waiting for a Claude account until ${clock(wait.until)}.`;
}

/** An owner-turn reply longer than this many words shows only its first ones, with "More" to show the rest. */
export const REPLY_FOLD_WORDS = 60;
const FENCE = /^\s*(?:```|~~~)/;
/**
 * The part of an owner-turn reply shown before "More": the text up to its `limit`-th word, then "…"; `folded` false when the reply has no
 * more words than that. Words are counted outside code fences (a diagram is not words), so a cut never falls inside a fence.
 */
export function foldReply(text: string, limit = REPLY_FOLD_WORDS): { shown: string; folded: boolean } {
  let words = 0, offset = 0, fence = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (FENCE.test(line)) fence = !fence;
    else if (!fence) {
      for (const match of line.matchAll(/\S+/g)) {
        if (!/[\p{L}\p{N}]/u.test(match[0]) || ++words <= limit) continue;
        return { shown: text.slice(0, offset + match.index!).trimEnd().replace(/[\s,;:—-]+$/, "") + "…", folded: true };
      }
    }
    offset += line.length;
  }
  return { shown: text, folded: false };
}
