import { randomBytes } from "node:crypto";
import { chatLines, CHECK_IN_PREFIX, messageIdNote, ownerMessageId, serverNote, TELL_OWNER_HELD, TELL_OWNER_TOOL, TELL_WHY, type TellWhy, turnStarter } from "./shared/chat-feed.ts";
import { messageText } from "./shared/turns.ts";
import type { ThreadMessage } from "./shared/types.ts";
import { ALLOWED_SHELL, SHELL_LIST } from "./chat-brief.ts";
import { fileLines } from "./file-lines.ts";
import { SHOP_TALK_MARK, shopTalk } from "./shared/reply-lint.ts";

/** What makes a session a chat and what a chat may run: the chat_mode marker, its tools, the tell_owner tool, the owner message ids, and the shell guard. */

/** The extension flag the chat server sets on `create`. The extension turns it into the session entry at the first session_start. */
export const CHAT_FLAG = "chat";
/**
 * The extension flag the chat server sets on a thread the owner starts with his first message: such a thread is no job, so the extension skips
 * the job registry lookups, which on the Mac read the box's 125 KB registry twice over a new TLS link, about 1.4 s of each Mac create on 10-20.
 */
export const OWNER_THREAD_FLAG = "owner-thread";
/** The session entry that defines "this session is a chat". Children get their own session files, so it never reaches them. */
export const CHAT_MODE_ENTRY = "chat_mode";
/** The board tool. Its promptGuidelines carry the brief, so it is active only in a marked root. */
export const CHAT_BOARD_TOOL = "chat_board";
/** The only way the chat reaches the owner on a turn the owner did not start; active with the board tool. The feed reads its calls from the transcript. */
export const CHAT_TOOLS: readonly string[] = [CHAT_BOARD_TOOL, TELL_OWNER_TOOL];
export const TELL_OWNER_DONE = "told the owner";

/** A chat with no name from the owner gets one, so a create_session root can reply to it by name. */
export function chatName(): string { return `chat-${randomBytes(2).toString("hex")}`; }

export function hasChatMarker(entries: ReadonlyArray<{ type: string; customType?: string }>): boolean {
  return entries.some(entry => entry.type === "custom" && entry.customType === CHAT_MODE_ENTRY);
}

/**
 * Whether a session file carries the chat_mode entry. The entry is written at the first session_start, before the first message, so the scan
 * stops at the first message entry and reads only the head of a long session.
 */
export async function fileHasChatMarker(sessionFile: string): Promise<boolean> {
  const lines = fileLines(sessionFile);
  try {
    for await (const line of lines) {
      if (line.startsWith('{"type":"message"')) return false;
      if (!line.includes(`"customType":"${CHAT_MODE_ENTRY}"`)) continue;
      try { if (hasChatMarker([JSON.parse(line)])) return true; } catch { continue; }
    }
    return false;
  } catch { return false; }
}

/** The archive reasons Prime writes for the owner's stop or archive; idle_unload and a forced shutdown are the daemon's own. */
const OWNER_STOPS: ReadonlySet<string> = new Set(["owner_stop", "owner_archive"]);

/**
 * The owner's stop or archive that a session file records after its last active state, as "<reason> at <time>", or null. On 10-20 06:25:25Z a
 * clean-room setup archived stray chat 01a157fb (owner_stop), and the scan re-adopted and resumed it at 06:25:28Z from its chat_mode entry.
 */
export async function ownerStopSinceActive(sessionFile: string): Promise<string | null> {
  let stop: string | null = null;
  try {
    for await (const line of fileLines(sessionFile)) {
      if (!line.includes('"type":"session_state"')) continue;
      let entry: { type?: unknown; timestamp?: unknown; state?: { status?: unknown; reason?: unknown } };
      try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
      if (entry.type !== "session_state") continue;
      if (entry.state?.status === "active") stop = null;
      else if (entry.state?.status === "archived" && typeof entry.state.reason === "string" && OWNER_STOPS.has(entry.state.reason)) stop = `${entry.state.reason} at ${String(entry.timestamp)}`;
    }
  } catch { return null; }
  return stop;
}

/** What the extension does at session_start: write the marker (flagged root, not marked yet) and whether the brief tool is active. */
export function chatModeAt(input: { depth: number; flagged: boolean; marked: boolean }): { mark: boolean; active: boolean } {
  if (input.depth !== 0) return { mark: false, active: false };
  const mark = input.flagged && !input.marked;
  return { mark, active: input.marked || mark };
}

/** The active tool list with the chat tools (board, tell_owner) added or removed; null when it is already right. Extension tools start active in every session. */
export function withChatTool(active: readonly string[], on: boolean): string[] | null {
  const missing = CHAT_TOOLS.filter(name => !active.includes(name));
  if (on) return missing.length ? [...active, ...missing] : null;
  return missing.length === CHAT_TOOLS.length ? null : active.filter(name => !CHAT_TOOLS.includes(name));
}

type ContextMessage = { role: string; content?: unknown; timestamp?: unknown };
/**
 * The model's view of a chat with each owner message's id (`messageIdNote`) after it, so the chat can pass it to tell_owner as `reply_to`;
 * undefined when no owner message has a timestamp. Every note depends only on its own message, so the cached prefix holds.
 */
export function withMessageIds<M extends ContextMessage>(messages: readonly M[]): M[] | undefined {
  let changed = false;
  const view = messages.map(message => {
    const content = message.content;
    if (message.role !== "user" || typeof message.timestamp !== "number" || !(typeof content === "string" || Array.isArray(content))) return message;
    const text = messageText({ content: content as string | { type: string; text?: string }[] }).trim();
    if (!text || serverNote(text)) return message;
    changed = true;
    const id = { type: "text", text: messageIdNote(message.timestamp) };
    return { ...message, content: typeof content === "string" ? [{ type: "text", text: content }, id] : [...content, id] };
  });
  return changed ? view : undefined;
}

/**
 * The line after each wake-up in a chat's model view (an agent message, a child's exit, a server note other than a turn restart), so every wake
 * path says the default at the point the chat reads it (c117). It depends only on its own message, so the cached prefix holds.
 */
export const WAKE_NOTE = "[not from the owner: send no tell_owner for it unless it finishes a goal he asked for, needs a decision or a blocker only he can clear, or answers his question, " +
  "and then set why and about. News he already got, a fix of your own earlier message, and progress on work still going are none of those]";
/**
 * The server's restart of a failed turn. It belongs to the turn that failed: after an aborted owner turn the note carries no OWNER_RETRY_MARK,
 * and the answer it brings is still his (10-19 measurement: 2 of 4 labelled restart messages were needed answers).
 */
const revival = (text: string): boolean => text.startsWith(`${CHECK_IN_PREFIX}Your last turn failed at `);
const WAKE_TYPES = new Set(["agent_message", "rlm_child_terminal_notice", "rlm_child_failure", "heartbeat_prompt"]);

/** The model's view of a chat with `WAKE_NOTE` after each wake-up; undefined when it has none. */
export function withWakeNotes<M extends ContextMessage & { customType?: unknown }>(messages: readonly M[]): M[] | undefined {
  let changed = false;
  const view = messages.map(message => {
    const content = message.content;
    if (!(typeof content === "string" || Array.isArray(content))) return message;
    const text = messageText({ content: content as string | { type: string; text?: string }[] }).trim();
    const wake = message.role === "custom" ? typeof message.customType === "string" && WAKE_TYPES.has(message.customType)
      : message.role === "user" && serverNote(text) !== undefined && !revival(text);
    if (!wake) return message;
    changed = true;
    const note = { type: "text", text: WAKE_NOTE };
    return { ...message, content: typeof content === "string" ? [{ type: "text", text: content }, note] : [...content, note] };
  });
  return changed ? view : undefined;
}

/** The tell_owner tool's description and parameters, which the extension registers in a chat. */
export const TELL_OWNER_DESCRIPTION = "Send the owner one chat message, its own bubble, like a VP's Slack DM to his CTO. On a turn he started, " +
  "answer him. On a turn he did not start (a job report, another thread, a check-in, a [job] notice, a wake, a duty run, an alert, a " +
  "restart), the default is no call: update the board and end the turn. Call it there only for a goal he asked for that finished, with " +
  "its result (why done), a decision only he can make (decision), a blocker only he can clear (blocker), or the answer to a question he " +
  "asked (answer), and name that goal, decision, blocker or question in about. A finished goal he asked for, or a plan change he would " +
  "act on (a new land order, a move of his sessions or boxes), is done or decision, never update. News he already got, a fix of your own " +
  "earlier message and progress on work still going are update, even when the work is a goal or a decision of his. A blocker is one only " +
  "he can clear, and the message says what he must do; an incident or delay a job or another chat already fixes, and its later status, " +
  "is update. One answer is one call, so a question goes in the same message as its context. Any other call there, " +
  "and one with no why, is kept as a note (c117). Write one " +
  "point in 1 or 2 short casual sentences, with no bullets or bold. Put no colon in its sentences, because \"Not quite:\", \"Quick read:\" " +
  "or \"Here's the diagram:\" before the point reads as a label, so use a comma or a period. " +
  "Use the plain words he would use himself, saying what he would see or can do now, never a job report's terms, a UI label or state, a " +
  "clipped verb or git talk like land or roll out, and give a time in KST, like 23:50 KST or 밤 11시 50분, never UTC or a Z (c18, c135, c138). " +
  "Write \"onboarding works now, but the campaign it makes comes out empty because the AI guessed too small a follower range\", not \"Home " +
  "shows 0 matched after landing because the drafted 2K to 20K follower filter misses most creators\". Name each plan step, goal, todo and duty " +
  "you mention by its id, like p684 or d9, written bare, which shows as a chip he can click; keep hashes, session ids and paths out (c145). Count its sentences before you send it, and " +
  "cut or split one over 2. Call it again for a second point, never for the rest of the same answer. An explanation or diagram goes on a " +
  "wiki page, sent as one message with the one-line takeaway and its wiki: link, which shows as a page card. In your first reply to a new " +
  "request, answer his question first with what you know, then name the job you started.";
export const TELL_OWNER_PARAMETERS = {
  type: "object",
  properties: {
    text: { type: "string" },
    why: { type: "string", enum: [...TELL_WHY], description: "answer, done, decision or blocker as above (blocker only when he must act, and the text says how); update for anything else, which " +
      "reaches him only on a turn he started. Give it on every turn he did not start." },
    about: { type: "string", description: "The goal, decision, blocker or question the message is about, in a few words; needed with why " +
      "on a turn he did not start." },
    reply_to: { type: "string", description: "Leave it out when you answer the owner's latest message. Set it only on a wake-up (a job " +
      "report or a check-in), on the one message that brings the result an owner message asked for when newer messages came after it: its [message id]." },
  },
  required: ["text"],
};

/** The cases that reach the owner on a turn he did not start: every `TELL_WHY` but "update". */
const TELL_CASES: readonly TellWhy[] = TELL_WHY.filter(why => why !== "update");
export interface TellInput { text?: unknown; why?: unknown; about?: unknown; reply_to?: unknown }
/**
 * What the check reads of the chat: whether the owner started the running turn or his newest message has no answer yet (the message being
 * sent is left out), and the ids of his messages a `reply_to` may name.
 */
export interface TellTurn { owner: boolean; ownerIds: ReadonlySet<string>; byOwner?: boolean; tells?: number; ownerText?: string; resent?: ReadonlySet<string>; done?: readonly string[]; startedAt?: number; asked?: ReadonlySet<string>; looked?: boolean }
/** The open owner todos on the chat's board that it added before the running turn started: a decision already waiting for him. */
export function askedTodos(todos: readonly { id: string; done?: boolean; at?: string; from?: string }[], startedAt: number | undefined): Set<string> {
  return new Set(startedAt === undefined ? [] : todos.filter(todo => !todo.done && todo.from !== "owner" && todo.at !== undefined && Date.parse(todo.at) < startedAt).map(todo => todo.id));
}
/** The words of an `about` that tell two of them apart: lowercased, three letters or more. */
const aboutWords = (about: string): Set<string> => new Set(about.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3));
/** The earlier `done` about this one repeats: every word of the shorter one is in the other, with at least two words. */
const repeatOf = (about: string, done: readonly string[]): string | undefined => {
  const words = aboutWords(about);
  return done.find(earlier => {
    const before = aboutWords(earlier);
    const [small, large] = words.size <= before.size ? [words, before] : [before, words];
    return small.size >= 2 && [...small].every(word => large.has(word));
  });
};
const REPEAT_MARK = "Not sent, you already told him this goal is done";
const REASK_MARK = "Not sent, this decision already waits for him on For you";
const UNLOOKED_MARK = "Not sent, you have not opened a screenshot of this screen in this turn";
/**
 * A 5180 demo link (localhost or the box's 15180 copy) or a screenshot image in a tell_owner text: a UI result handed to the owner to look at.
 * On 10-19 frontend bro sent "The new onboarding is on your Mac's 5180 too. http://localhost:5180/configure?..." at 07:18:44Z after only an
 * ls of the variant folder, two minutes after it filed c118, and the owner answered "and it's ugly as fuck ... consistent with our actual apps"
 * at 07:29:01Z. Of the 78 tell_owner texts in that chat that carried such a link or shot, 50 went with no image opened in their turn, and 13 of
 * the 25 after c118.
 */
const UI_HANDOFF = /\b(?:localhost|127\.0\.0\.1|[\w-]+(?:\.[\w-]+)+):1?5180\b|!\[[^\]]*\]\([^)\s]+\.(?:png|jpe?g|webp|gif)\)/iu;
/** The todo ids a text names, like t4. */
const todoIds = (text: string): string[] => [...text.matchAll(/\bt(\d+)\b/g)].map(match => `t${match[1]}`);

export function tellTurn(messages: readonly ThreadMessage[]): TellTurn {
  const ownerIds = new Set<string>();
  let ownerText = "";
  const told = new Map<string, string>();
  const doneAbout = new Map<string, string>();
  const resent = new Set<string>();
  let done: string[] = [];
  let looked = false;
  for (const message of messages) {
    if (message.role === "user" && !serverNote(messageText(message).trim())) { ownerIds.add(ownerMessageId(message.timestamp)); ownerText = messageText(message); done = []; }
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && typeof part.arguments?.text === "string") told.set(part.id, part.arguments.text.trim());
      if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && part.arguments?.why === "done" && typeof part.arguments?.about === "string") doneAbout.set(part.id, part.arguments.about);
    }
    if (message.role === "user" || message.role === "custom") looked = false;
    if (message.role === "toolResult" && message.content.some(part => part.type === "image")) looked = true;
    if (message.role === "toolResult" && message.toolName === TELL_OWNER_TOOL && [SHOP_TALK_MARK, REPEAT_MARK, REASK_MARK, UNLOOKED_MARK].some(mark => messageText(message).startsWith(mark))) {
      const text = told.get(message.toolCallId);
      if (text) resent.add(text);
    }
    if (message.role === "toolResult" && message.toolName === TELL_OWNER_TOOL && messageText(message) === TELL_OWNER_DONE && doneAbout.has(message.toolCallId)) {
      done.push(doneAbout.get(message.toolCallId)!);
    }
  }
  const before = messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages;
  const lines = chatLines(before);
  const unanswered = lines.findLastIndex(line => line.kind === "user") > lines.findLastIndex(line => line.kind === "agent");
  const byOwner = turnStarter(messages.filter(message => !(message.role === "user" && revival(messageText(message).trim())))) === "owner";
  const last = messages.at(-1);
  const tells = last?.role === "assistant" ? last.content.filter(part => part.type === "toolCall" && part.name === TELL_OWNER_TOOL).length : 0;
  const startedAt = before.findLast(message => message.role === "user" || message.role === "custom")?.timestamp;
  return { owner: unanswered || byOwner, ownerIds, byOwner, tells, ownerText, resent, done, looked, ...(typeof startedAt === "number" ? { startedAt } : {}) };
}

/**
 * What `tell_owner` answers. On a turn the owner started, or with a `reply_to` that names one of his messages, any text reaches him as its own
 * bubble; a server restart of a failed turn keeps that turn's starter. On any other turn it reaches him only when `why` names a case (done, decision, blocker, answer) and `about` names that goal,
 * decision, blocker or question; else it is held, the feed shows it in the turn's notes, and the answer says how to send it if it is one
 * (c117; on 10-19 469 of 597 messages in a day came on turns the owner did not start, and the brief's rule since c104 had not held them).
 * Length and form stay brief rules (c81, c97). A text it would send with shop talk (`shopTalk`: a UTC time, git's land or roll out, a commit
 * id) is refused once with what to say instead, and the very same text sent again goes out, so the check is a soft cap (c98). A text that
 * hands him a 5180 link or a screenshot (`UI_HANDOFF`) when no tool result showed the chat an image since the turn's last owner message or
 * report is refused once the same way, so the chat opens the shots and compares them with the accepted Staging app first (c118).
 */
export function tellOwner(input: TellInput, turn: TellTurn): { kind: "sent" | "refused" | "held"; text: string } {
  const told = typeof input.text === "string" ? input.text.trim() : "";
  if (!told) return { kind: "refused", text: "nothing to tell: give text" };
  if (turn.byOwner === false && (turn.tells ?? 0) > 1) return { kind: "refused", text: `${turn.tells} tell_owner calls in one step on a turn ` +
    "the owner did not start, so none was sent. Send them as one message in one call now, the answer or each finished item in a sentence or two." };
  const named = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  const answers = named(input.reply_to) && turn.ownerIds.has(input.reply_to.trim());
  const declared = TELL_CASES.includes(input.why as TellWhy) && named(input.about);
  const repeat = !turn.owner && input.why === "done" && named(input.about) && !turn.resent?.has(told) ? repeatOf(input.about, turn.done ?? []) : undefined;
  const reask = !turn.owner && !turn.resent?.has(told) ? todoIds(`${told} ${typeof input.about === "string" ? input.about : ""}`).find(id => turn.asked?.has(id)) : undefined;
  if (reask) return { kind: "refused", text: `${REASK_MARK} as ${reask}, which you added in an earlier turn. Put new facts or a changed ` +
    "pick in that todo with chat_board todo_update instead; if he must see this now, send the very same text again and it goes out (c117)." };
  if (repeat) return { kind: "refused", text: `${REPEAT_MARK} ("${repeat}") since his last message. Send nothing unless this brings something ` +
    "new he must see or act on; if it does, send the very same text again and it goes out (c117)." };
  if (turn.owner || answers || declared) {
    const talk = turn.resent?.has(told) ? [] : shopTalk(told, turn.ownerText);
    if (talk.length) return { kind: "refused", text: `${SHOP_TALK_MARK} ${talk.join(", ")}. Write it the way a person texts in Slack, with what ` +
      "he would see or can do now in plain words, and call tell_owner again. Sending the very same text again sends it as it is (c18, c98)." };
    if (turn.looked === false && !turn.resent?.has(told) && UI_HANDOFF.test(told)) return { kind: "refused", text: `${UNLOOKED_MARK}. ` +
      "Before you hand him a 5180 link or screenshots, open each screenshot of what it shows with attach_image and compare it with the " +
      "accepted Staging app it should match, its page frame, title, filter row, row icons and spacing. A screen that looks unlike the accepted " +
      "apps goes back to the job, not to him. If you compared them in this turn, send the very same text again and it goes out (c118, c98)." };
    return { kind: "sent", text: TELL_OWNER_DONE };
  }
if (!named(input.why)) return { kind: "refused", text: "why is required on a turn the owner did not start. Call tell_owner again " +
    "with why (done, decision, blocker, answer or update) and about, or update the board and end the turn if it is only an update." };
  return { kind: "held", text: `${TELL_OWNER_HELD}. The owner did not start this turn, so a message reaches him only with why set to done, ` +
    "decision, blocker or answer and about naming that goal, decision, blocker or question. A finished goal he asked for, or a plan change " +
    "he would act on (a land order, a move), is done or decision, never update. If it is one of those, call tell_owner again with both; if " +
    "not, update the board and end the turn." };
}

const PY_STRING = /(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const CALL = /(?<!\w)bash\s*\(/g;

function unquote(literal: string): string {
  const body = literal.replace(/^[rbfuRBFU]{0,2}/, "");
  const triple = body.startsWith('"""') || body.startsWith("'''");
  return triple ? body.slice(3, -3) : body.slice(1, -1);
}

/** The text between the parenthesis at `openParen` and its match, with string literals skipped. */
function argumentText(code: string, openParen: number): string {
  let depth = 0;
  const limit = Math.min(code.length, openParen + 4000);
  for (let i = openParen; i < limit; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const delimiter = code.slice(i, i + 3) === ch.repeat(3) ? ch.repeat(3) : ch;
      i += delimiter.length;
      while (i < code.length && !code.startsWith(delimiter, i)) i += code[i] === "\\" ? 2 : 1;
      i += delimiter.length - 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return code.slice(openParen + 1, i);
  }
  return code.slice(openParen + 1, limit);
}

/** The command with quoted text blanked, so `rg "a|b"` passes while `cat x | sh` and `ls; rm x` do not. */
function unquotedShell(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, text => " ".repeat(text.length));
}
function shellReason(command: string | null, how: string): string | null {
  if (command !== null) {
    const trimmed = command.trim();
    const allowed = ALLOWED_SHELL.some(prefix => trimmed === prefix || trimmed.startsWith(prefix + " "));
    if (allowed && !/[;&|<>`\n]|\$\(/.test(unquotedShell(trimmed))) return null;
  }
  return `[soft cap] This ran, but the chat brief keeps a chat's own shell to quick look-ups (${SHELL_LIST}; no pipes, redirects or chaining) ` +
    `(${how}). Give the next real task to a job with rlm.spawn.`;
}
/**
 * The note for an ipython cell that goes past a chat's look-up shell, or null. The cell runs either way (owner 10-18: every arbitrary limit is
 * a soft cap). Calls are found on the code with its string literals and comments blanked, so a job brief that mentions bash( does not trip it.
 * A computed shell command counts as past it. subprocess and os.system are not inspected; the brief asks a chat not to use them.
 */
export function judgeChatCode(code: string): string | null {
  const lines = code.split("\n");
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === "") first++;
  if (/^\s*%%(bash|sh|zsh|shell)\b/.test(lines[first] ?? "")) return shellReason(null, "a shell cell");
  for (const line of lines) {
    const bang = /^\s*!(?![=!])(.+)$/.exec(line);
    if (bang) { const reason = shellReason(bang[1]!.trim(), "a ! line"); if (reason) return reason; }
  }
  const blanked = code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), text => " ".repeat(text.length));
  CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL.exec(blanked)) !== null) {
    const args = argumentText(code, match.index + match[0].length - 1);
    const head = args.replace(/^\s*(?:command\s*=\s*)?/, "");
    PY_STRING.lastIndex = 0;
    const literal = PY_STRING.exec(head);
    const reason = shellReason(literal && literal.index === 0 ? unquote(literal[0]) : null, literal ? "bash()" : "a computed bash() command");
    if (reason) return reason;
  }
  return null;
}

export interface GuardInput { toolName: string; input: Record<string, unknown>; depth: number; marked: boolean }

/** The note a chat's tool call gets appended to its result: only in a marked root session (depth 0); the call always runs. */
export function chatShellNote({ toolName, input, depth, marked }: GuardInput): string | undefined {
  if (depth !== 0 || !marked) return undefined;
  if (toolName === "ipython" && typeof input.code === "string") return judgeChatCode(input.code) ?? undefined;
  if (toolName === "bash" && typeof input.command === "string") return shellReason(input.command, "the bash tool") ?? undefined;
  return undefined;
}

/**
 * The top of a session's parentSession chain, from `sessionFile` up: its id, its name and whether it is a chat. One header line per level, then
 * one scan of the top file. The name is the last session_info, or for a chat the last before the chat_mode entry (a chat is named at create,
 * before its first session_start writes the entry), where the scan stops. Null when a file is missing or has no header.
 */
export async function topSession(sessionFile: string): Promise<{ id: string; name: string; chat: boolean } | null> {
  let file = sessionFile;
  for (let level = 0; level < 16; level++) {
    const header = await fileHeader(file);
    if (!header) return null;
    if (typeof header.parentSession === "string") { file = header.parentSession; continue; }
    const lines = fileLines(file);
    let name = "";
    try {
      for await (const line of lines) {
        if (line.startsWith('{"type":"session_info"')) {
          try { const entry = JSON.parse(line) as { name?: unknown }; if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim(); } catch { continue; }
        } else if (line.includes(`"customType":"${CHAT_MODE_ENTRY}"`)) {
          try { if (hasChatMarker([JSON.parse(line)])) return { id: header.id, name, chat: true }; } catch { continue; }
        }
      }
      return { id: header.id, name, chat: false };
    } catch { return null; }
  }
  return null;
}

async function fileHeader(sessionFile: string): Promise<{ id: string; parentSession?: unknown } | null> {
  const lines = fileLines(sessionFile);
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as { type?: unknown; id?: unknown; parentSession?: unknown };
      return header.type === "session" && typeof header.id === "string" ? { id: header.id, parentSession: header.parentSession } : null;
    }
    return null;
  } catch { return null; }
}

const JOB_CALL = /\brlm(?:\.spawn|\.create_session)?\s*\(/g;
const blankStrings = (code: string): string => code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), text => " ".repeat(text.length));
/** Each `rlm(...)`, `rlm.spawn(...)` or `rlm.create_session(...)` in an ipython cell that gives `name=` as a plain string literal; a computed name (an f-string with a field, a variable) is not found. */
export function jobNameLiterals(code: string): { call: "rlm" | "rlm.spawn" | "rlm.create_session"; name: string }[] {
  const blanked = blankStrings(code);
  const names: { call: "rlm" | "rlm.spawn" | "rlm.create_session"; name: string }[] = [];
  JOB_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JOB_CALL.exec(blanked)) !== null) {
    const args = argumentText(code, match.index + match[0].length - 1);
    const keyword = /\bname\s*=/.exec(blankStrings(args));
    if (!keyword) continue;
    PY_STRING.lastIndex = 0;
    const rest = args.slice(keyword.index + keyword[0].length).trimStart();
    const literal = PY_STRING.exec(rest);
    if (!literal || literal.index !== 0 || (/^[rbuRBU]*[fF]/.test(literal[0]) && literal[0].includes("{"))) continue;
    const name = unquote(literal[0]).trim();
    if (name) names.push({ call: match[0].replace(/\s*\($/, "") as "rlm" | "rlm.spawn" | "rlm.create_session", name });
  }
  return names;
}
/** The session names an ipython cell gives `rlm.create_session(..., name="...")` as plain string literals. */
export const createSessionNames = (code: string): string[] => jobNameLiterals(code).filter(entry => entry.call === "rlm.create_session").map(entry => entry.name);
