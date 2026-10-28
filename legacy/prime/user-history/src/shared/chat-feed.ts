import { agentMessageHead } from "../no-report.ts";
import { messageKey } from "./message-key.ts";
import { isPromptCustom, messageText, toolResults, triggerSummary } from "./turns.ts";
import type { AssistantMessage, ChatWait, CustomMessage, ImagePart, SessionRow, ThreadMessage, ThreadState, UserMessage } from "./types.ts";

/** A message the owner sent from the chat composer that the thread has not echoed back yet. `images` are data URLs for the bubble. */
/** An owner send the thread has not echoed: sending (dim), `sent` (delivered, drawn as a normal bubble), or `failed` with the reason. */
export interface PendingSend { id: string; text: string; images: ImagePart[]; at: number; sent?: true; failed?: string }

/** The tool a chat calls to reach the owner on a turn the owner did not start. Its `text` shows as an agent bubble unless the tool refused or held it. */
export const TELL_OWNER_TOOL = "tell_owner";
/**
 * The cases a `tell_owner` call names in `why` to reach the owner on a turn he did not start (c117): an answer to his message or question, a goal
 * he asked for that finished, a decision only he can make, a blocker only he can clear. "update" is anything else, kept as a note on such a turn.
 */
export const TELL_WHY = ["answer", "done", "decision", "blocker", "update"] as const;
export type TellWhy = typeof TELL_WHY[number];
/** How the result of a `tell_owner` call the check kept opens; the feed shows its text in the turn's folded notes, not as a bubble. */
export const TELL_OWNER_HELD = "Kept as a note, not sent";
/**
 * A user message the chat server sends on its own: the restart of a failed turn and the job notices (and, in transcripts from before W44, the
 * check-in digest). The feed folds them and the turn they start is not the owner's.
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
/**
 * The tag that opens the chat system duty's push to a chat, `[d9 push <ISO minute>Z]` (scripts/duties/chat-system.ts), which the duty runner
 * sends as a server notice (`DutyHost.tell`). Until 10-24 the feed read it as the owner's: the 08:03Z push to one chat drew as his bubble and
 * d11 counted it as his unanswered burst.
 */
export const D9_PUSH_PREFIX = "[d9 push ";
/**
 * The gap that ends one burst of the owner's messages in a chat: a message less than this after his previous one is the same burst. d11's
 * unanswered_bursts (owner-messages.ts) wants one reply per burst, and repeat_corrections_7d counts one repeat of a correction per burst.
 */
export const OWNER_BURST_GAP_MS = 10 * 60_000;
const SERVER_NOTES: readonly [string, string][] = [[CHECK_IN_PREFIX, "check-in"], [JOB_NOTICE_PREFIX, "jobs"], [REPLY_CHECK_PREFIX, "reply check"], [BRIEF_CHECK_PREFIX, "brief check"],
  [CORRECTION_CHECK_PREFIX, "corrections"], [OPS_STEER_PREFIX, "board"], [DECISION_STEER_PREFIX, "board"], [D9_PUSH_PREFIX, "d9"],
  ["Prime Agent restarted after an update", "Prime"], ["Watchdog recovery checkpoint", "watchdog"]];
/**
 * Prime's own notes in a user message open with a snake_case tag on its own line: <provider_quota_resumed>, <prime_agent_update_interrupted>,
 * <prime_agent_worker_interrupted>, <ipython_kernel_reset> (prime-agent 0.9.8). On 10-20 from 04:38Z to 05:43Z, 5 chats answered a quota resume
 * in plain text as if he had written to them, and each answer showed as his reply bubble, with no tell_owner check (c117). A tag with no
 * underscore, as in "<b>bold</b> is fine?", is his.
 */
const PRIME_NOTE = /^<[a-z]+(?:_[a-z]+)+>\s/;
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
/** Whether the owner typed the message, which the feed draws as his bubble ("user" item, linesOf), and so as the first row a window may draw (settledFrom). */
export const ownerTyped = (message: ThreadMessage): boolean => message.role === "user" && serverNote(messageText(message).trim()) === undefined;

/** Who sent a server note ("check-in", "jobs", or the chat a nudge asks for), or undefined for a message the owner typed. */
export function serverNote(text: string): string | undefined {
  if (text.startsWith(NUDGE_PREFIX)) { const end = text.indexOf("]"); return end > NUDGE_PREFIX.length ? text.slice(NUDGE_PREFIX.length, end) : undefined; }
  if (PRIME_NOTE.test(text)) return "Prime";
  return SERVER_NOTES.find(([prefix]) => text.startsWith(prefix))?.[1];
}

/**
 * One message of a chat as a line, before the feed collapses the quiet ones. Who started the turn decides what the chat's own text is:
 * - user: what the owner typed (right side); `pending` while it is on its way, `failed` with the reason when it cannot go.
 * - agent: what the owner reads from the chat (left side): the chat's text on a turn the owner started, or a `tell_owner` call on any turn
 *   (`told`); `streaming` while the model is still writing it.
 * - job: a message another agent sent the chat; `from` is its display name. `clipped` names the message and part to fetch through
 *   `api/threads/:id/part` when the snapshot holds only the first 2 KiB of the body.
 * - notes: the chat's text on a turn another agent, a check-in or a job notice started. The owner sees it only inside a fold.
 * - notice: a line the owner needs on its own: the error that ended his turn with no answer after it, or the live wait `chatFeed` adds.
 * - quiet: a background notice that folds: a wait for a Claude account (`wait`), a stopped reply, a restart, a compaction, a check-in change,
 *   an error on a turn he did not start or one an answer followed.
 */
export type ChatLine =
  | { kind: "user"; id: string; text: string; images: ImagePart[]; at: number; pending?: true; failed?: string; replies?: string[] }
  | { kind: "agent"; id: string; text: string; at: number; streaming?: true; told?: true; replyTo?: ReplyQuote }
  | { kind: "job"; id: string; from: string; title: string; body: string; at: number; clipped?: { message: number; part: number } }
  | { kind: "notes"; id: string; text: string; at: number; full?: string }
  | { kind: "notice"; id: string; text: string; at: number }
  | { kind: "quiet"; id: string; text: string; at: number; wait?: true };
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

/** The background lines: between two visible lines they fold into one row. */
export type FoldEntry = Extract<ChatLine, { kind: "job" | "notes" | "quiet" }>;
/**
 * A run of background lines as one row, keyed by its first line so its id holds when a line lands below it. `at` is the first line's time.
 * Of the account waits only the latest stays in `entries`, since each one says the same thing with a later time.
 */
export type Fold = { kind: "fold"; id: string; at: number; entries: FoldEntry[] };
/** One item of the feed on screen: a visible line, or a fold. */
export type ChatItem = Exclude<ChatLine, FoldEntry> | Fold;

/** Who started a turn: the owner (a user message, `[board] ` lines included) or something else (an agent message, a check-in, a job notice). */
export type TurnStarter = "owner" | "agent";
/** The display name of a session id or a live agent id in an agent-message header; undefined when the catalog does not list it. */
export type NameOf = (id: string) => string | undefined;

/** A user message echoed by the daemon up to this long before the browser's send time still settles the pending send (clock skew between devices). */
export const PENDING_SKEW_MS = 5 * 60_000;

const imagesOf = (message: UserMessage | CustomMessage): ImagePart[] =>
  typeof message.content === "string" ? [] : message.content.filter((part): part is ImagePart => part.type === "image");

const firstLine = (text: string): string => text.split("\n").map(line => line.trim()).find(Boolean) ?? "";

/** A session id, or the 12-hex id the daemon gives a live agent (`SessionRow.agent`); a relay names its sender by either. */
const THREAD_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12})$/i;
/** The display name for an agent-message sender: a job by its name, a thread id by its catalog name, an id nobody lists as "another thread". */
export function senderName(from: string, nameOf: NameOf = () => undefined): string {
  const raw = from.replace(/^(?:child|sibling|parent):/, "").trim();
  if (!raw) return "another thread";
  if (!THREAD_ID.test(raw)) return raw;
  return nameOf(raw)?.trim() || "another thread";
}

let lastNames: { names: Map<string, string>; nameOf: NameOf } | null = null;
/**
 * The catalog's names by session id and by live agent id. On 10-22 the owner's feed showed senders as "0c8dc51ba931" and "34415a8288c4". The page
 * gets a new rows array on every sessions frame, so the same names give back the same function and a feed built on it is not built again.
 */
export function catalogNames(rows: readonly SessionRow[]): NameOf {
  const names = new Map<string, string>();
  for (const row of rows) {
    names.set(row.id, row.name);
    if (row.agent) names.set(row.agent, row.name);
  }
  const last = lastNames;
  if (last && last.names.size === names.size && [...names].every(([id, name]) => last.names.get(id) === name)) return last.nameOf;
  const nameOf: NameOf = id => names.get(id);
  lastNames = { names, nameOf };
  return nameOf;
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

/** The most a closing text on a turn the owner did not start shows of itself: one sentence of c104's size. */
export const QUIET_NOTE_WORDS = 25;
/** A sentence that speaks to the owner or names a For you todo: on a turn he did not start it is a reminder or a relay, never news (c117). */
const TO_OWNER = /\b(?:you|your|yours)\b|\bt\d{1,4}\b|\bfor you\b/i;
/**
 * What the owner's page shows of the chat's closing text on a turn he did not start: its first sentence that neither speaks to him nor names
 * a todo, cut to QUIET_NOTE_WORDS, with tables, bullets and headings left out; "" when none is left. The c117 clean room showed the text rule
 * alone does not hold: run1 on release-18b73ec closed 13 such turns with recaps of up to 21 sentences, and run2 on release-db3b622 still closed
 * 7 with 2 or 3 sentences and once with "Your answers on t2 and t3 are still open."
 */
export function quietNote(text: string): string {
  const lines = text.replace(/```[\s\S]*?```/g, "\n").split("\n")
    .filter(line => !/^\s*(?:\||#{1,6}\s|[-*+\u2022]\s|\d{1,2}[.)]\s)/.test(line)).join("\n");
  const sentences = lines.split(/\n+/).flatMap(line => line.replace(/\b(vs|e\.g|i\.e|approx|etc)\.(?=\s)/gi, "$1").split(/(?<=[.!?])["')\]]*\s+(?=\S)/))
    .map(part => part.replace(/\*\*/g, "").trim()).filter(part => /[\p{L}\p{N}]/u.test(part));
  const first = sentences.find(part => !TO_OWNER.test(part));
  if (!first) return "";
  const words = first.split(/\s+/);
  return words.length > QUIET_NOTE_WORDS ? words.slice(0, QUIET_NOTE_WORDS).join(" ") + "\u2026" : first;
}

/**
 * The turn a message belongs to: `shown` is how the chat's text shows, a reply bubble or notes (a wake-up, or an owner turn the chat answered with
 * tell_owner), and `owner` says the owner started it, so an error that ends it shows on its own.
 */
type Turn = { shown: "reply" | "notes"; owner: boolean };

function assistantLines(message: AssistantMessage, id: string, turn: Turn, streaming: boolean, refused: Refused, answer: Answer, checkInChanged: CheckInChanged = () => undefined, held: Refused = () => false): ChatLine[] {
  const lines: ChatLine[] = [];
  const raw = messageText(message).trim();
  const { replyTo, text } = streaming && REPLY_TO_MARKER.startsWith(raw) ? { replyTo: null, text: "" } : splitReplyTo(raw);
  if (text && turn.shown === "reply") {
    const quote = answer(replyTo, id);
    lines.push({ kind: "agent", id, text, at: message.timestamp, ...(streaming ? { streaming: true } : {}), ...(quote ? { replyTo: quote } : {}) });
  } else if (text && !streaming) {
    const shown = turn.owner ? text : quietNote(text);
    if (shown) lines.push({ kind: "notes", id, text: shown, at: message.timestamp, ...(shown === text ? {} : { full: text }) });
  }
  if (streaming) return lines;
  message.content.forEach((part, index) => {
    const changed = part.type === "toolCall" ? checkInChanged(part.id) : undefined;
    if (changed) lines.push({ kind: "quiet", id: `${id}-c${index}`, text: changed, at: message.timestamp });
    const kept = part.type === "toolCall" && held(part.id) ? toldText(part, () => false) : "";
    if (kept) { lines.push({ kind: "notes", id: `${id}-t${index}`, text: kept, at: message.timestamp }); return; }
    const told = toldText(part, refused);
    if (!told || part.type !== "toolCall") return;
    const quote = answer(part.arguments.reply_to, `${id}-t${index}`);
    lines.push({ kind: "agent", id: `${id}-t${index}`, text: told, at: message.timestamp, told: true, ...(quote ? { replyTo: quote } : {}) });
  });
  if (message.stopReason === "aborted") lines.push({ kind: "quiet", id: id + "-stop", text: "Reply stopped", at: message.timestamp });
  else if (message.stopReason === "error") lines.push(failureLine(message.errorMessage, id + "-error", message.timestamp, turn.owner));
  return lines;
}

/** A failed assistant message as a line: a pool wait folds as a wait, an error stays visible on the owner's turn and folds on any other. */
function failureLine(error: string | undefined, id: string, at: number, owner: boolean): ChatLine {
  const text = failureText(error);
  if (poolSlot(error ?? "") !== null) return { kind: "quiet", id, text, at, wait: true };
  return { kind: owner ? "notice" : "quiet", id, text, at };
}

/** The note pi-pool's extension adds to a failure it turned into a wait for the session's own slot or backoff time (`waitFailure`). */
const POOL_SLOT = / pi-pool: [\s\S]*?this session waits for its slot at (\d{4}-\d\d-\d\dT[\d:.]+Z)/;
/** The slot (epoch ms) the pool gave the session in a failure's text, or null when the text carries none. */
export function poolSlot(error: string): number | null {
  const at = Date.parse(POOL_SLOT.exec(error)?.[1] ?? "");
  return Number.isFinite(at) ? at : null;
}
/**
 * How a failed assistant message reads. A pool wait is no failure: Prime sleeps until the slot and continues the turn itself, so it reads
 * as a wait with its time. On 10-18 at 08:32Z a Mac session waiting 23 min for its slot showed "Error: Failed to resolve API key".
 */
export function failureText(error: string | undefined): string {
  const slot = poolSlot(error ?? "");
  return slot === null ? "Error: " + (error?.trim() || "the model returned an error") : `Waiting for a Claude account until ${clock(slot)}.`;
}

function customLines(message: CustomMessage, id: string, index: number, nameOf: NameOf): ChatLine[] {
  if (message.customType === "agent_message") {
    const summary = triggerSummary(message);
    const head = agentMessageHead(messageText(message));
    const from = senderName(head?.name ?? summary.detail.replace(/^from\s+/, ""), nameOf);
    const body = head?.body.trim() ?? summary.body;
    const part = typeof message.content === "string" ? -1 : message.content.findIndex(entry => entry.type === "text" && entry.truncated);
    return [{ kind: "job", id, from, title: firstLine(body) || "(empty message)", body, at: message.timestamp, ...(part >= 0 ? { clipped: { message: index, part } } : {}) }];
  }
  if (message.customType === "prime-agent.update_restart") return [{ kind: "quiet", id, text: "Prime Agent restarted", at: message.timestamp }];
  if (message.customType === CHAT_NOTICE) return [{ kind: "quiet", id, text: messageText(message).trim(), at: message.timestamp }];
  return [];
}

/**
 * Every committed message as lines, in order, with the turn tracked the way `buildTurns` does: a user message starts an owner turn; a
 * wake-up custom (agent message, heartbeat, job notice, background completion) starts an agent turn when the last run had settled, and
 * joins the running turn otherwise. The chat's text is an agent line on an owner turn and a notes line on an agent turn, or on an owner turn
 * with a `tell_owner` call the tool accepted (the told text is the reply); a `tell_owner` call is an agent line on either, unless the tool
 * refused the text, and a notes line when the tool held it (`TELL_OWNER_HELD`). Check-ins, job notices and background completions themselves produce nothing: what the chat told the owner
 * about them is the line. toolResult, bashExecution, branchSummary and non-prompt customs produce nothing.
 */
export function chatLines(messages: readonly ThreadMessage[], nameOf: NameOf = () => undefined): ChatLine[] {
  return linesOf(messages, nameOf).lines;
}

/**
 * `chatLines` with the reply linker and the running turn (`current`), for the streaming reply that follows them. An agent line whose `reply_to`
 * names an earlier owner message (`ownerMessageId`) quotes it; an unknown id is dropped.
 */
function linesOf(messages: readonly ThreadMessage[], nameOf: NameOf): { lines: ChatLine[]; answer: Answer; current: Turn } {
  const lines: ChatLine[] = [];
  const links = replyLinks();
  const track = turnTracker();
  const results = toolResults(messages);
  const held: Refused = toolCallId => {
    const result = results.get(toolCallId);
    return result !== undefined && !result.isError && messageText(result).startsWith(TELL_OWNER_HELD);
  };
  const refused: Refused = toolCallId => results.get(toolCallId)?.isError === true || held(toolCallId);
  const checkInChanged: CheckInChanged = toolCallId => {
    const result = results.get(toolCallId);
    if (!result || result.isError) return undefined;
    const first = messageText(result).split("\n", 1)[0]!.trim();
    return first.startsWith(CHAT_CHECK_IN_LINE) ? first : undefined;
  };
  const told = toldTurns(messages, refused);
  let current: Turn = { shown: "reply", owner: true };
  messages.forEach((message, index) => {
    const id = lineId(messages, index);
    const { starter, turn } = track(message);
    current = { shown: starter === "owner" && !told.has(turn) ? "reply" : "notes", owner: starter === "owner" };
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
      case "assistant": lines.push(...assistantLines(message, id, current, false, refused, links.answer, checkInChanged, held)); return;
      case "custom": lines.push(...customLines(message, id, index, nameOf)); return;
      case "compactionSummary": lines.push({ kind: "quiet", id, text: "Older messages were summarized to free space", at: message.timestamp }); return;
      case "toolResult":
      case "bashExecution":
      case "branchSummary":
        return;
    }
  });
  return { lines: settleAnswered(lines), answer: links.answer, current };
}

/** Turns each error on the owner's turn that an agent line followed before his next message into a quiet line: the chat went on and answered him. */
function settleAnswered(lines: ChatLine[]): ChatLine[] {
  let answered = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.kind === "user") answered = false;
    else if (line.kind === "agent") answered = true;
    else if (line.kind === "notice" && answered) lines[index] = { kind: "quiet", id: line.id, text: line.text, at: line.at };
  }
  return lines;
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

const isFoldEntry = (line: ChatLine): line is FoldEntry => line.kind === "job" || line.kind === "notes" || line.kind === "quiet";
const isWait = (entry: FoldEntry): boolean => entry.kind === "quiet" && entry.wait === true;

/**
 * The lines with every run of background ones folded into one row. Owner's ask, 10-22: chats that ran in the background became illegible, so
 * job messages, notes, waits and restarts between two replies collapse to one row with the most recent line.
 */
export function foldLines(lines: readonly ChatLine[]): ChatItem[] {
  const items: ChatItem[] = [];
  let fold: Fold | null = null;
  for (const line of lines) {
    if (!isFoldEntry(line)) { fold = null; items.push(line); continue; }
    if (!fold) { fold = { kind: "fold", id: "f" + line.id, at: line.at, entries: [] }; items.push(fold); }
    if (isWait(line)) { const earlier = fold.entries.findIndex(isWait); if (earlier >= 0) fold.entries.splice(earlier, 1); }
    fold.entries.push(line);
  }
  return items;
}

/**
 * How many feed rows the owner has not read: the lines the chat sent him (owner-turn replies and `tell_owner` messages) after `since` (the read
 * marker, ms). A fold never counts, since its job messages and the chat's notes on turns he did not start were never sent to him (c117). On
 * 10-27 api portal vp ended about 11 such turns from 13:07Z to 18:43Z with a status recap that reminded him of todo t4, each fold lit the chat
 * as unread, and he wrote "이딴거 마구 쳐 보내지마".
 */
export function unreadCount(messages: readonly ThreadMessage[], since: number, nameOf: NameOf = () => undefined): number {
  return chatLines(messages, nameOf).filter(line => line.kind === "agent" && line.at > since).length;
}

/** A session titled by its first message can run long; the fold row clips each name to this. */
const NAME_LIMIT = 32;
const clipName = (name: string): string => name.length > NAME_LIMIT ? name.slice(0, NAME_LIMIT - 1).trimEnd() + "\u2026" : name;

/** One fold entry as one line: a job message by its sender and first line, the chat's notes by their first line, a notice as it reads. */
export function entryLine(entry: FoldEntry): string {
  switch (entry.kind) {
    case "job": return `${entry.from}: ${entry.title}`;
    case "notes": return firstLine(entry.text);
    case "quiet": return entry.text;
  }
}

/** What a fold row says: its most recent line, "4 updates", and the senders newest first, up to three. */
export function foldLabel(fold: Fold): { latest: string; count: string; names: string } {
  const last = fold.entries.at(-1);
  const count = fold.entries.length === 1 ? "1 update" : `${fold.entries.length} updates`;
  const names = [...new Set(fold.entries.flatMap(entry => entry.kind === "job" ? [entry.from] : []).reverse())].map(clipName);
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  return { latest: last ? entryLine(last) : "", count, names: more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ") };
}

/** A visible item this long after the visible item before it gets a time stamp above it. */
const STAMP_GAP_MS = 15 * 60_000;
/**
 * The ids of the items the feed puts a time stamp above: the first visible item, and each one STAMP_GAP_MS after the visible item before it.
 * A fold gets none and does not count, so stamps never sit between folded rows and the time between two replies shows.
 */
export function stampedItems(feed: readonly ChatItem[]): Set<string> {
  const stamped = new Set<string>();
  let last: number | null = null;
  for (const item of feed) {
    if (item.kind === "fold") continue;
    if (last === null || item.at - last > STAMP_GAP_MS) stamped.add(item.id);
    last = item.at;
  }
  return stamped;
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
 * The whole chat, oldest first: every message as lines with the background runs folded, then the streaming reply when the owner started the turn
 * and the chat has not answered it with tell_owner, then the sends the thread has not echoed yet.
 */
export function chatFeed(state: Pick<ThreadState, "messages" | "streaming" | "wait">, pending: readonly PendingSend[] = [], nameOf: NameOf = () => undefined): ChatItem[] {
  const { lines, answer, current } = linesOf(state.messages, nameOf);
  if (state.streaming) lines.push(...assistantLines(state.streaming, "streaming", current, true, () => true, answer));
  const items = foldLines(lines);
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
