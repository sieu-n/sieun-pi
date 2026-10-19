import { randomBytes } from "node:crypto";
import { messageIdNote, serverNote, TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import { messageText } from "./shared/turns.ts";
import { ALLOWED_SHELL, SHELL_LIST } from "./chat-brief.ts";
import { fileLines } from "./file-lines.ts";

/** What makes a session a chat and what a chat may run: the chat_mode marker, its tools, the tell_owner tool, the owner message ids, and the shell guard. */

/** The extension flag the chat server sets on `create`. The extension turns it into the session entry at the first session_start. */
export const CHAT_FLAG = "chat";
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
 * What `tell_owner` answers: any text reaches the owner as its own bubble, markdown, mermaid diagrams and length included, and the chat may
 * call it several times in one turn to send several bubbles. The reply rules live in the chat brief, not in a code check (c81, c97; owner
 * 10-18: "also is this a hard cap (code-level) or something? if so strip all these").
 */
export function tellOwner(text: unknown): { ok: true; text: string } | { ok: false; text: string } {
  const told = typeof text === "string" ? text.trim() : "";
  return told ? { ok: true, text: TELL_OWNER_DONE } : { ok: false, text: "nothing to tell: give text" };
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
