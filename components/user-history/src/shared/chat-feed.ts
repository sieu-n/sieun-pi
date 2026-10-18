import { messageKey } from "./message-key.ts";
import { isPromptCustom, messageText, toolResults, triggerSummary } from "./turns.ts";
import type { AssistantMessage, ChatWait, CustomMessage, ImagePart, ThreadMessage, ThreadState, UserMessage } from "./types.ts";

/** A message the owner sent from the chat composer that the thread has not echoed back yet. `images` are data URLs for the bubble. */
/** An owner send the thread has not echoed: sending (dim), `sent` (delivered, drawn as a normal bubble), or `failed` with the reason. */
export interface PendingSend { id: string; text: string; images: ImagePart[]; at: number; sent?: true; failed?: string }

/** The tool a chat calls to reach the owner on a turn the owner did not start. Its `text` shows as an agent bubble unless the tool refused it. */
export const TELL_OWNER_TOOL = "tell_owner";
/**
 * A user message the chat server sends on its own: the restart of a failed turn and the job notices (and, in transcripts from before W44, the
 * check-in digest). The feed folds them into updates and the turn they start is not the owner's.
 */
export const CHECK_IN_PREFIX = "[check-in] ";
export const JOB_NOTICE_PREFIX = "[job] ";
/** The note the server sent until 10-18 after an owner-turn reply that failed the reply lint; older transcripts hold it, and the turn it starts is not the owner's. */
export const REPLY_CHECK_PREFIX = "[reply check] ";
/** The server's note after a chat spawned a job whose brief failed the brief check (src/shared/brief-check.ts); the turn it starts is not the owner's. */
export const BRIEF_CHECK_PREFIX = "[brief check] ";
/** The server's one line after an owner message that reads as a correction and no correction_add followed (src/correction-refine.ts); the turn it starts is not the owner's. */
export const CORRECTION_CHECK_PREFIX = "[correction check] ";
/**
 * The server's `[board]` line after a chat's turn read a duty job's board ops and left some unapplied. The server sent it until 10-16; the feed
 * and Chat health still read it in older transcripts as a note the owner did not type.
 */
export const OPS_STEER_PREFIX = "[board] Ops not applied: ";
/**
 * The server's `[board]` line after a chat's turn sent a ruling and added no scratchpad note. The server sent it on 10-15 until the owner removed
 * the scratchpad; the feed still reads it in older transcripts as a note the owner did not type.
 */
const DECISION_STEER_PREFIX = "[board] Decisions not on the scratchpad: ";
const SERVER_NOTES: readonly [string, string][] = [[CHECK_IN_PREFIX, "check-in"], [JOB_NOTICE_PREFIX, "jobs"], [REPLY_CHECK_PREFIX, "reply check"], [BRIEF_CHECK_PREFIX, "brief check"],
  [CORRECTION_CHECK_PREFIX, "corrections"], [OPS_STEER_PREFIX, "board"], [DECISION_STEER_PREFIX, "board"]];
/** In a server note that restarts a failed owner turn: the turn it starts stays the owner's, so the chat's answer is a bubble. */
export const OWNER_RETRY_MARK = "The owner's message is still unanswered: ";
/** The first line of a chat_board result when the chat changed its own check-in; the feed shows that line as a notice. */
export const CHAT_CHECK_IN_LINE = "The chat set its check-in: ";
export const CHAT_NOTICE = "chat_notice";
/**
 * The server's nudge to a thread a stale step waited on, in the asking chat's name: `[from <chat>] your step ...`. The server sent these before
 * W44 (check-in jobs chase threads themselves now); the feed still reads them in older transcripts as notes the owner did not type.
 */
export const NUDGE_PREFIX = "[from ";
/** Who sent a server note ("check-in", "jobs", or the chat a nudge asks for), or undefined for a message the owner typed. */
export function serverNote(text: string): string | undefined {
  if (text.startsWith(NUDGE_PREFIX)) { const end = text.indexOf("]"); return end > NUDGE_PREFIX.length ? text.slice(NUDGE_PREFIX.length, end) : undefined; }
  return SERVER_NOTES.find(([prefix]) => text.startsWith(prefix))?.[1];
}

/**
 * One message of a chat as a line, before the feed collapses the quiet ones. Who started the turn decides what the chat's own text is:
 * - user: what the owner typed (right side); `pending` while it is on its way, `failed` with the reason when it cannot go.
 * - agent: what the owner reads from the chat (left side): the chat's text on a turn the owner started, or a `tell_owner` call on any turn
 *   (`told`); `streaming` while the model is still writing it.
 * - job: a message another agent sent the chat; `from` is its display name. `clipped` names the message and part to fetch through
 *   `api/threads/:id/part` when the snapshot holds only the first 2 KiB of the body.
 * - notes: the chat's text on a turn another agent, a check-in or a job notice started. The owner sees it only inside an updates list.
 * - notice: an error, a stopped reply, a restart or a compaction, as one muted line.
 */
export type ChatLine =
  | { kind: "user"; id: string; text: string; images: ImagePart[]; at: number; pending?: true; failed?: string; replies?: string[] }
  | { kind: "agent"; id: string; text: string; at: number; streaming?: true; told?: true; replyTo?: ReplyQuote }
  | { kind: "job"; id: string; from: string; title: string; body: string; at: number; clipped?: { message: number; part: number } }
  | { kind: "notes"; id: string; text: string; at: number }
  | { kind: "notice"; id: string; text: string; at: number };
/**
 * An agent line that answers one owner message: that message's feed line id and its text. The owner line lists the agent lines that answer it
 * in `replies`, oldest first, for its "See reply" button.
 */
export interface ReplyQuote { id: string; text: string }

/**
 * The id the model reads after each owner message (`[message id: <id>]`, src/chat-guard.ts withMessageIds) and passes back as `reply_to`: the
 * message's timestamp in base 36, so it survives compaction and needs no index. The feed finds the owner line by its `at`.
 */
export const ownerMessageId = (at: number): string => at.toString(36);
/**
 * The note after an owner message in the model's view that gives its id and when to quote it. Clean room dm-replies/run-4 (10-18 07:30Z)
 * quoted the owner's latest message on its own direct answer, under a brief and tool text that said not to (c104).
 */
export const messageIdNote = (at: number): string => `[message id: ${ownerMessageId(at)}; reply_to it only after he sends a newer message]`;
/** The marker line a chat's text reply opens with to answer an older owner message: `reply_to: <id>`, then the reply. */
export const REPLY_TO_MARKER = "reply_to:";
const MARKER_LINE = /^reply_to:[ \t]*(\S*)[ \t]*(?:\n+|$)/;

/** A text reply with its `reply_to:` line taken off: the id it names (null without the line) and the text the owner reads. */
export function splitReplyTo(text: string): { replyTo: string | null; text: string } {
  const match = MARKER_LINE.exec(text);
  return match ? { replyTo: match[1]!, text: text.slice(match[0].length).trim() } : { replyTo: null, text };
}

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
/** The owner message a `reply_to` id names, recorded on it as answered by the agent line `answer`; undefined for an unknown id. */
type Answer = (replyTo: unknown, answer: string) => ReplyQuote | undefined;

/** Every owner line seen so far by its `ownerMessageId`, and the linker that ties an agent line to one of them. */
function replyLinks(): { owner: (line: Extract<ChatLine, { kind: "user" }>) => void; answer: Answer } {
  const owners = new Map<string, Extract<ChatLine, { kind: "user" }>>();
  return {
    owner: line => { if (Number.isFinite(line.at)) owners.set(ownerMessageId(line.at), line); },
    answer: (replyTo, answer) => {
      const line = typeof replyTo === "string" ? owners.get(replyTo.trim()) : undefined;
      if (!line) return undefined;
      (line.replies ??= []).push(answer);
      return { id: line.id, text: line.text };
    },
  };
}

/** The text of a `tell_owner` call the tool did not refuse; "" for any other part. */
function toldText(part: AssistantMessage["content"][number], refused: Refused): string {
  if (part.type !== "toolCall" || part.name !== TELL_OWNER_TOOL || refused(part.id)) return "";
  return typeof part.arguments.text === "string" ? part.arguments.text.trim() : "";
}

/** `shown` is how the message's text shows: a reply bubble, or notes (a wake-up, or an owner turn the chat answered with tell_owner). */
function assistantLines(message: AssistantMessage, id: string, shown: "reply" | "notes", streaming: boolean, refused: Refused, answer: Answer, checkInChanged: CheckInChanged = () => undefined): ChatLine[] {
  const lines: ChatLine[] = [];
  const raw = messageText(message).trim();
  const { replyTo, text } = streaming && REPLY_TO_MARKER.startsWith(raw) ? { replyTo: null, text: "" } : splitReplyTo(raw);
  if (text && shown === "reply") {
    const quote = answer(replyTo, id);
    lines.push({ kind: "agent", id, text, at: message.timestamp, ...(streaming ? { streaming: true } : {}), ...(quote ? { replyTo: quote } : {}) });
  } else if (text && !streaming) lines.push({ kind: "notes", id, text, at: message.timestamp });
  if (streaming) return lines;
  message.content.forEach((part, index) => {
    const changed = part.type === "toolCall" ? checkInChanged(part.id) : undefined;
    if (changed) lines.push({ kind: "notice", id: `${id}-c${index}`, text: changed, at: message.timestamp });
    const told = toldText(part, refused);
    if (!told || part.type !== "toolCall") return;
    const quote = answer(part.arguments.reply_to, `${id}-t${index}`);
    lines.push({ kind: "agent", id: `${id}-t${index}`, text: told, at: message.timestamp, told: true, ...(quote ? { replyTo: quote } : {}) });
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
 * joins the running turn otherwise. The chat's text is an agent line on an owner turn and a notes line on an agent turn, or on an owner turn
 * with a `tell_owner` call the tool accepted (the told text is the reply); a `tell_owner` call is an agent line on either, unless the tool
 * refused the text. Check-ins, job notices and background completions themselves produce nothing: what the chat told the owner
 * about them is the line. toolResult, bashExecution, branchSummary and non-prompt customs produce nothing.
 */
export function chatLines(messages: readonly ThreadMessage[], nameOf: NameOf = () => undefined): ChatLine[] {
  return linesOf(messages, nameOf).lines;
}

/**
 * `chatLines` with the reply linker and how the running turn's text shows (`current`), for the streaming reply that follows them. An agent
 * line whose `reply_to` names an earlier owner message (`ownerMessageId`) quotes it; an unknown id is dropped.
 */
function linesOf(messages: readonly ThreadMessage[], nameOf: NameOf): { lines: ChatLine[]; answer: Answer; current: "reply" | "notes" } {
  const lines: ChatLine[] = [];
  const links = replyLinks();
  const track = turnTracker();
  const results = toolResults(messages);
  const refused: Refused = toolCallId => results.get(toolCallId)?.isError === true;
  const checkInChanged: CheckInChanged = toolCallId => {
    const result = results.get(toolCallId);
    if (!result || result.isError) return undefined;
    const first = messageText(result).split("\n", 1)[0]!.trim();
    return first.startsWith(CHAT_CHECK_IN_LINE) ? first : undefined;
  };
  const told = toldTurns(messages, refused);
  let current: "reply" | "notes" = "reply";
  messages.forEach((message, index) => {
    const id = lineId(messages, index);
    const { starter, turn } = track(message);
    current = starter === "owner" && !told.has(turn) ? "reply" : "notes";
    switch (message.role) {
      case "user": {
        const text = messageText(message).trim();
        const from = serverNote(text);
        if (from) { const body = text.slice(text.indexOf("]") + 1).trim(); lines.push({ kind: "job", id, from, title: firstLine(body), body, at: message.timestamp }); return; }
        const line = { kind: "user" as const, id, text, images: imagesOf(message), at: message.timestamp };
        links.owner(line);
        lines.push(line);
        return;
      }
      case "assistant": lines.push(...assistantLines(message, id, current, false, refused, links.answer, checkInChanged)); return;
      case "custom": lines.push(...customLines(message, id, index, nameOf)); return;
      case "compactionSummary": lines.push({ kind: "notice", id, text: "Older messages were summarized to free space", at: message.timestamp }); return;
      case "toolResult":
      case "bashExecution":
      case "branchSummary":
        return;
    }
  });
  return { lines, answer: links.answer, current };
}

/**
 * A message's feed line id, `m<timestamp>.<n>` from its `messageKey`: an index would change when an older page is put in front, and every keyed
 * bubble of the feed would draw again.
 */
export function lineId(messages: readonly ThreadMessage[], index: number): string {
  const { at, n } = messageKey(messages, index);
  return `m${at}.${n}`;
}

/**
 * Feeds each message in order and answers who started the turn it belongs to and the turn's number: each owner message starts a turn, and a
 * wake-up starts one when the last run had settled.
 */
function turnTracker(): (message: ThreadMessage) => { starter: TurnStarter; turn: number } {
  let starter: TurnStarter = "owner";
  let settled = true;
  let turn = 0;
  const start = (who: TurnStarter) => { starter = who; settled = false; turn++; };
  return message => {
    if (message.role === "user" && messageText(message).includes(OWNER_RETRY_MARK) && serverNote(messageText(message).trim())) start("owner");
    else if (message.role === "user" && serverNote(messageText(message).trim())) { if (settled) start("agent"); settled = false; }
    else if (message.role === "user") start("owner");
    else if (message.role === "assistant") settled = message.stopReason !== "toolUse";
    else if (message.role === "custom" && isPromptCustom(message)) { if (settled) start("agent"); settled = false; }
    return { starter, turn };
  };
}

/** The turns (by `turnTracker` number) with a `tell_owner` call the tool accepted: the chat's text on such an owner turn is notes. */
function toldTurns(messages: readonly ThreadMessage[], refused: Refused): Set<number> {
  const track = turnTracker();
  const told = new Set<number>();
  for (const message of messages) {
    const { turn } = track(message);
    if (message.role === "assistant" && message.content.some(part => toldText(part, refused) !== "")) told.add(turn);
  }
  return told;
}

/** Who started the turn the thread is on now: the owner until something else wakes a settled chat. */
export function turnStarter(messages: readonly ThreadMessage[]): TurnStarter {
  const track = turnTracker();
  let starter: TurnStarter = "owner";
  for (const message of messages) starter = track(message).starter;
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

/**
 * Ids of the pending sends a user message in `messages` has settled: same text, and not from before the send (minus clock skew). Each message
 * settles at most one. A failed send never went, so no message settles it.
 */
export function settledPending(messages: readonly ThreadMessage[], pending: readonly PendingSend[]): Set<string> {
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message).trim();
    const match = pending.find(send => send.failed === undefined && !settled.has(send.id) && send.text === text && message.timestamp >= send.at - PENDING_SKEW_MS);
    if (match) settled.add(match.id);
  }
  return settled;
}

/**
 * The whole chat, oldest first: every message as lines with the quiet runs folded, then the streaming reply when the owner started the turn
 * and the chat has not answered it with tell_owner, then the sends the thread has not echoed yet.
 */
export function chatFeed(state: Pick<ThreadState, "messages" | "streaming" | "wait">, pending: readonly PendingSend[] = [], nameOf: NameOf = () => undefined): ChatItem[] {
  const { lines, answer, current } = linesOf(state.messages, nameOf);
  if (state.streaming) lines.push(...assistantLines(state.streaming, "streaming", current, true, () => true, answer));
  const items = collapseUpdates(lines);
  const settled = settledPending(state.messages, pending);
  for (const send of pending) {
    if (settled.has(send.id)) continue;
    items.push({ kind: "user", id: "p" + send.id, text: send.text, images: send.images, at: send.at,
      ...(send.failed !== undefined ? { failed: send.failed } : send.sent ? {} : { pending: true as const }) });
  }
  if (state.wait) items.push({ kind: "notice", id: "wait", text: waitText(state.wait), at: items.at(-1)?.at ?? 0 });
  return items;
}

const clock = (at: number): string => { const date = new Date(at); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
/** The line under the owner's unanswered message while the server waits to restart its failed turn, in the reader's local time. */
export function waitText(wait: ChatWait): string {
  if (wait.kind === "retry") return `Turn failed (${wait.error}). Retrying at ${clock(wait.at)}.`;
  return wait.until === null ? "Waiting for a Claude account. Your selected model stays unchanged." : `Waiting for a Claude account until ${clock(wait.until)}. Your selected model stays unchanged.`;
}

/** A code fence line: a reply's diagram or code block starts and ends with one. */
export const FENCE = /^\s*(?:```|~~~)/;
