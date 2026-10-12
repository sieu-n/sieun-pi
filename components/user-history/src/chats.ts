import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { IdIndex } from "./id-index.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { activeCorrections, briefCorrections, handoffRules, type Ledger } from "./chat-corrections.ts";
import { heartbeatsFile, readHeartbeats } from "./checkin-load.ts";
import { MERGE_RULE, MERGE_RULE_SHORT } from "./shared/chat-board.ts";
import { activePause, changeCheckIn, type CheckInActor, type CheckInChange, checkInDue, checkInPrecheck, checkInPrecheckText, CheckInRefused, type CheckInRecord, type CheckInSetting, type CheckInSettings, childName,
  childWorking, classCounts, convergenceMisses, DEFAULT_CHECK_IN, type DutyRef, endedWithoutReport, finishedJobs, JOB_CLEANUP_EVERY_MS, jobEnd, jobEndText, jobFacts, lastJobMessages, nextCheckIn,
  noReportNotice, retryDue } from "./chat-checkin.ts";
import { type ClaudeState, claudeDown, failureCause, jobWake, type JobWake, revivalMessage, type Stall, stallAction, strandedInput, turnStall, turnViewOf, wokeFromSleep } from "./chat-recovery.ts";
import { JOB_NOTICE_PREFIX, messageIdNote, REPLY_FOLD_WORDS, serverNote, TELL_OWNER_LIMIT, TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import { findingsList, lintOwnerReply, replyCheck, replyNotes } from "./shared/reply-lint.ts";
import { briefCheck, briefCheckNote, ownerMessages, turnOwnerAt } from "./shared/brief-check.ts";
import type { CheckInRun, CheckInStart, Duties } from "./chat-duty-run.ts";
import { messageText } from "./shared/turns.ts";
import type { ChatAgent, ChatBoard, ChatBriefState, ChatWait, CheckInState, CheckInView, ChildAgent, ModelInfo, QueueState, RetryState, SessionRow, ThinkingLevel,
  ThreadMessage } from "./shared/types.ts";

export { TELL_OWNER_LIMIT, TELL_OWNER_TOOL };

/** The daemon's answer for an active session id it does not hold: that session ended, whatever its list still says. */
export const UNKNOWN_ACTIVE = "Unknown active session:";
/** A thread the daemon no longer has: not in the catalog (404), or listed active with a session the daemon does not hold. */
const threadGone = (error: unknown): boolean =>
  error instanceof Error && ((error as { status?: unknown }).status === 404 || error.message.startsWith(UNKNOWN_ACTIVE));

/** The extension flag the chat server sets on `create`. The extension turns it into the session entry at the first session_start. */
export const CHAT_FLAG = "chat";
/** The session entry that defines "this session is a chat". Children get their own session files, so it never reaches them. */
export const CHAT_MODE_ENTRY = "chat_mode";
/** The board tool. Its promptGuidelines carry the brief, so it is active only in a marked root. */
export const CHAT_BOARD_TOOL = "chat_board";
/** The only way the chat reaches the owner on a turn the owner did not start; active with the board tool. The feed reads its calls from the transcript. */
export const CHAT_TOOLS: readonly string[] = [CHAT_BOARD_TOOL, TELL_OWNER_TOOL];
export const TELL_OWNER_TOO_LONG = "shorter: one or two sentences";
export const TELL_OWNER_DONE = "told the owner";
export const TELL_OWNER_REFUSED = "Refused: the owner did not see it. Rewrite it and call tell_owner again:";
/** The prompt of the daemon heartbeat that did the check-in before the server tick; an attach clears a heartbeat whose prompt starts with it. */
export const OLD_CHECK_IN = "Check-in. Read the board";
/** A job quiet this long with no report is told to the chat; shorter gaps are a job between tool calls or one that a reply woke again. */
export const NO_REPORT_GRACE_MS = 90_000;
/** Two ends of one job whose last activity is this close are one end: told once. */
export const NO_REPORT_SAME_END_MS = 60_000;
/** Shell commands a chat may run: prime-agent (stop, send) and quick read-only look-ups. Each entry matches as a whole word at the start. */
const ALLOWED_SHELL = ["prime-agent", "git log", "git status", "git diff", "git show", "rg", "ls", "cat", "head", "tail", "wc"];
const SHELL_LIST = "prime-agent, git log/status/diff/show, rg, ls, cat, head, tail, wc";

/** Where the brief's on-demand rules live: the board skill and its references, read before the action they cover. */
export const BOARD_SKILL = "~/.prime/agent/skills/board";
/** The brief, as promptGuidelines bullets. It reaches every turn kind, including agent-message wakes and check-ins, through the base system prompt.
 * A rule the brief holds names its correction id, like (c47); the [corrections] block then shows that id with its theme only (BRIEF_CORRECTIONS). */
export const CHAT_BRIEF: readonly string[] = [
  "This session is a chat. The owner is the CTO and you are the VP for this thread's topic. Your one goal is to drive every board item to done. " +
    "Every open step names its owner (a job, or a thread as `thread:<id>`) and its next action, or is blocked with the exact thing that unblocks it. " +
    "A step waiting on someone else is still yours: chase a stuck owner once, then replace it with a job.",
  "Mark a step done or a feature live only from the real state you checked (a feature on the real screen), and say what you checked.",
  "Reach the owner only through tell_owner, on every kind of turn, within the [reply cap]. Other text shows only as folded notes. On a " +
    "wake-up the owner did not start, call it once when a goal finished, something is blocked or you need a decision, with several updates in one " +
    "call; never write 'nothing needs you', 'already handled' or a relay line. Message another thread only when it must act.",
  "Write in the owner's language like a coworker's text: answer first, plain sentences, no labels or report formatting (c18). Keep ids, hashes " +
    "and internal names out of sentences; link each job or thread by its exact name (c12). Push back with your reason when the " +
    "owner misses a fact or asks for something odd (c16). Asked how something works, answer at once with a diagram of the current state (c52).",
  "An explanation the owner asks for is a wiki page a job writes as a plan step; send its link with tell_owner (c14). Starting, " +
    "steering or a report of a job gets one short line with its job link, never the report (c9).",
  `Do only minute-long read-only look-ups yourself: a file, a job's report, \`attach_image\`, or \`bash()\` ` +
    `with ${SHELL_LIST} and no pipes or chaining. Any real task goes to a job.`,
  "Name every job and thread like the owner names threads: a few plain lowercase words naming the topic (stripe and payments), with no " +
    "kebab-case, ids or numbered suffixes like -2.",
  "Start a job with `rlm.spawn(brief, name=..., model=\"anthropic/claude-opus-5-5\", thinking=\"high\")`, the model of this chat and every job " +
    "unless the owner says otherwise (c31). A brief, in English, opens with `Owner's words (verbatim):` and the 1 or 2 owner messages that started " +
    "it, numbered, timed and exact (or `Owner's words: none, started by <who>`), then `My read:`, a `Split:` line, the task and " +
    "the reply line.",
  "One job takes one goal (c10). Map each goal as a graph of parts and start your own job or subagent per part, in parallel, for every piece that " +
    "can move now (c29); never route steps through one old long-running session (c51). Delete heartbeats and watcher loops the check-in already " +
    "covers. Start jobs at once, reply in one short message and end the turn; job reports wake you later.",
  "Act directly and ship; invent no waiting rules, review rounds or safety gates unless the owner asks for caution (c47). When something blocks a " +
    "step, start a job that fixes it (c34). Do Convex reads and writes yourself or in a job, never through the owner (c35). New checks run like " +
    "existing specs and CI, with no special runner (c19).",
  "Staging lands and deploys never need the owner's ok (c50). A production merge, auto-merge, push to main or master, or promote needs his go on " +
    "a For you todo that names that PR or push; no standing \"merge once checks pass\" go exists (c49).",
  "Nothing goes outside (an email, a ticket or support reply, a customer message, a post) until the owner approves the draft on a For you todo (c37).",
  "Flag a goal days or weeks away or blocked on capacity in For you at once, with options and your pick (c42). Base limits (c43) and any " +
    "'target does not fit' or hardware ask (c17) on measured evidence, and show what you tried.",
  "Decide wording, small fixes and code choices yourself and note them in the scratchpad; ask the owner only about product direction, money, " +
    "irreversible or outside actions, and credentials. A step waiting on the owner gets one short plain For you todo at once, " +
    "at most 3 open (c32).",
  "Agents decide the control flow, not code loops: a duty runs a code precheck, then one job that decides its own fan-out (c22).",
  "End state: every open step is done, moved by a live owner (a job at work, or a thread active in the last 2 h), or blocked only by an open For " +
    "you todo. Update the board with `chat_board` in the turn a job starts, ends or replies. Never ask the owner to relay a message to another " +
    "thread. A `[board] ` message is the owner acting on the board: act on it.",
  "When the owner corrects how you work, apply it now and record it with `correction_add` in the same turn.",
  `Read on demand from \`${BOARD_SKILL}/\`: SKILL.md before a board write; references/jobs.md for jobs; references/check-ins.md for check-ins ` +
    "and duties; references/git.md before a sieun-pi commit, a merge or a push; references/owner.md for todos, review asks, logins and reply " +
    "links or images; references/corrections.md when corrected.",
];
/** The corrections the brief holds in full. */
export const BRIEF_CORRECTIONS = briefCorrections(CHAT_BRIEF);

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
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.startsWith('{"type":"message"')) return false;
      if (!line.includes(`"customType":"${CHAT_MODE_ENTRY}"`)) continue;
      try { if (hasChatMarker([JSON.parse(line)])) return true; } catch { continue; }
    }
    return false;
  } catch { return false; }
  finally { lines.close(); }
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

/**
 * The line the context hook adds to every message the owner typed in a chat: the brief's reply cap, read next to the message it governs.
 * Chat health long_replies, 10-09: after the cap entered the brief (4be3ceb) the median owner reply was 68 words and 65% ran past 60.
 */
export const REPLY_CAP_NOTE = `[reply cap] Answer this in at most ${REPLY_FOLD_WORDS} words, bullets included: the answer first, then at most 3 short lines. ` +
  `Anything longer goes in a wiki page; reply with its link. Send the reply with tell_owner. The page folds every word past ${REPLY_FOLD_WORDS} under More.`;

type ContextMessage = { role: string; content?: unknown; timestamp?: unknown };
/**
 * The model's view of a chat with its id (`messageIdNote`) and REPLY_CAP_NOTE after each message the owner typed, and after it the reply lint's findings on the reply the
 * owner read before that message (`replyNotes`); undefined when there is no owner message. Every owner message gets its notes from the
 * messages before it, so the cached prefix holds.
 */
export function withReplyCap<M extends ContextMessage>(messages: readonly M[]): M[] | undefined {
  let capped = false;
  const checks = replyNotes(messages as unknown as readonly ThreadMessage[]);
  const view = messages.map((message, index) => {
    const content = message.content;
    if (message.role !== "user" || !(typeof content === "string" || Array.isArray(content))) return message;
    const text = messageText({ content: content as string | { type: string; text?: string }[] }).trim();
    if (!text || serverNote(text)) return message;
    capped = true;
    const check = checks.get(index);
    const id = typeof message.timestamp === "number" ? [{ type: "text", text: messageIdNote(message.timestamp) }] : [];
    const notes = [...id, { type: "text", text: REPLY_CAP_NOTE }, ...(check ? [{ type: "text", text: check }] : [])];
    return { ...message, content: typeof content === "string" ? [{ type: "text", text: content }, ...notes] : [...content, ...notes] };
  });
  return capped ? view : undefined;
}

/**
 * What `tell_owner` answers: the text reaches the owner as a bubble, or it is refused as too long or for reply-lint findings, which come back
 * with their fixes so the chat rewrites it in the same turn (the feed shows a refused call as nothing). `ownerText` is the owner's last message:
 * a word the owner used is not jargon.
 */
export function tellOwner(text: unknown, ownerText = ""): { ok: true; text: string } | { ok: false; text: string } {
  const told = typeof text === "string" ? text.trim() : "";
  if (!told) return { ok: false, text: "nothing to tell: give text" };
  if (told.length > TELL_OWNER_LIMIT) return { ok: false, text: TELL_OWNER_TOO_LONG };
  const findings = lintOwnerReply(told, ownerText);
  if (findings.length) return { ok: false, text: `${TELL_OWNER_REFUSED}\n${findingsList(findings)}` };
  return { ok: true, text: TELL_OWNER_DONE };
}

const PY_STRING = /(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const CALL = /(?<!\w)(bash|edit|open)\s*\(/g;
const MODE = /^[rwaxbt+U]{1,4}$/;

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

function literals(text: string): string[] {
  PY_STRING.lastIndex = 0;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = PY_STRING.exec(text)) !== null) out.push(unquote(match[0]));
  return out;
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
  return `A chat runs only quick look-ups in the shell (${SHELL_LIST}; no pipes, redirects or chaining) (${how}). Give the work to a job with rlm.spawn.`;
}
const EDIT_REASON = "A chat edits no files. Give the change to a job with rlm.spawn.";
const WRITE_REASON = "A chat writes no files. Give the change to a job with rlm.spawn.";

/**
 * The reason an ipython cell is refused in a chat, or null. Calls are found on the code with its string literals and comments blanked, so a job
 * brief that mentions bash( or edit( does not trip the guard. A computed shell command counts as refused. subprocess, os.system and pathlib
 * writes are not inspected; the brief forbids them.
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
    switch (match[1]) {
      case "edit": return EDIT_REASON;
      case "bash": {
        const head = args.replace(/^\s*(?:command\s*=\s*)?/, "");
        PY_STRING.lastIndex = 0;
        const literal = PY_STRING.exec(head);
        const reason = shellReason(literal && literal.index === 0 ? unquote(literal[0]) : null, literal ? "bash()" : "a computed bash() command");
        if (reason) return reason;
        break;
      }
      case "open": {
        if (literals(args).some(text => MODE.test(text) && /[wax+]/.test(text))) return WRITE_REASON;
        break;
      }
    }
  }
  for (const { name } of jobNameLiterals(code)) { const reason = nameReason(name); if (reason) return reason; }
  return null;
}

/** The brief's naming line, and the reason a cell that names a job otherwise is refused. */
export const NAME_RULE = CHAT_BRIEF.find(line => line.startsWith("Name every job"))!;
/**
 * Why a literal job or thread name is refused, or null: words joined by a hyphen or underscore (kebab-case, snake_case), a trailing number
 * (`-2`, `_2`, `2`), or more than 40 characters. The owner names threads with a few plain words and spaces.
 */
export function nameReason(name: string): string | null {
  const trimmed = name.trim();
  if (/[A-Za-z0-9][-_][A-Za-z0-9]/.test(trimmed) || /[-_ ]?\d+$/.test(trimmed) || trimmed.length > 40) return NAME_RULE;
  return null;
}

export interface GuardInput { toolName: string; input: Record<string, unknown>; depth: number; marked: boolean }

/** The tool_call decision for a chat: active only in a marked root session (depth 0). */
export function chatGuard({ toolName, input, depth, marked }: GuardInput): { block: true; reason: string } | undefined {
  if (depth !== 0 || !marked) return undefined;
  let reason: string | null = null;
  if (toolName === "ipython" && typeof input.code === "string") reason = judgeChatCode(input.code);
  else if (toolName === "bash" && typeof input.command === "string") reason = shellReason(input.command, "the bash tool");
  else if (toolName === "edit") reason = EDIT_REASON;
  return reason ? { block: true, reason } : undefined;
}

/** The tool whose promptGuidelines tell a job of a chat how to report. Registered only in a job's own session, so its base prompt carries the line. */
export const JOB_REPLY_TOOL = "job_reply";
/** A session that works for a chat: `chat` is the chat's session name (empty when unknown); `root` for a thread the chat started with rlm.create_session. */
export interface ChatJobOf { chat: string; root: boolean }

export function jobReplyGuideline(job: ChatJobOf): string {
  const send = job.root ? `await agent_message.send(report, receiver_role="sibling", receiver_name="${job.chat}")` : `await agent_message.send(report, receiver_role="parent")`;
  return `You are a job of the chat${job.chat ? ` ${job.chat}` : ""}. When you finish, fail or get blocked, send your report first with \`${send}\`, ` +
    `and lead it with the answer. ${MERGE_RULE_SHORT}`;
}

/**
 * The poteto-agent persona every job of a chat works in (owner, 10-08: "i want poteto-mode on by default"): the poteto-agent skill's own rule,
 * pointing at the installed poteto-mode skill. Null when that skill is not installed, so a profile without it gets nothing.
 */
export function jobPersonaGuideline(potetoModeSkill: string, exists: (path: string) => boolean = existsSync): string | null {
  return exists(potetoModeSkill) ? `Work in poteto-mode: read ${potetoModeSkill} before your first step.` : null;
}

/**
 * Whether a session is a job of a chat: a direct subagent of a marked chat (`parentChat` is the chat's name, null when the parent is no chat),
 * or an unmarked root the job registry lists under a chat (`registered`).
 */
export function jobOf(input: { depth: number; marked: boolean; parentChat?: string | null; registered?: string | undefined }): ChatJobOf | null {
  if (input.depth === 1 && typeof input.parentChat === "string") return { chat: input.parentChat, root: false };
  if (input.depth === 0 && !input.marked && input.registered) return { chat: input.registered, root: true };
  return null;
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
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
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
    finally { lines.close(); }
  }
  return null;
}

async function fileHeader(sessionFile: string): Promise<{ id: string; parentSession?: unknown } | null> {
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as { type?: unknown; id?: unknown; parentSession?: unknown };
      return header.type === "session" && typeof header.id === "string" ? { id: header.id, parentSession: header.parentSession } : null;
    }
    return null;
  } catch { return null; }
  finally { lines.close(); }
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

/**
 * Which chat started a root, by its session name or id. The chat's extension writes a name when a cell calls rlm.create_session; the duty
 * runner writes a duty job's session id (src/chat-duty-job.ts). The root's extension reads it at start and again at its first prompt.
 */
export interface JobRegistry {
  add(names: readonly string[], chat: string): Promise<void>;
  chatOf(name: string): Promise<string | undefined>;
  /** The session names (or ids, for a duty job) a chat (by any of its names: its session name, its id) started. */
  rootsOf(chat: readonly string[]): Promise<string[]>;
  /** Drops entries: a retired duty job. */
  remove(names: readonly string[]): Promise<void>;
}
const REGISTRY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** `<data dir>/chat-jobs.json`: `{ jobs: { [sessionName or id]: { chat, at } } }` through locked-json; entries older than 30 days go on the next add. */
export function jobRegistry(path: string, now: () => number = Date.now): JobRegistry {
  type Entry = { chat: string; at: number };
  const file: JsonFile<{ jobs: Record<string, Entry> }> = { path, label: "Chat job registry", initial: () => ({ jobs: {} }), parse(value: unknown) {
    const jobs = typeof value === "object" && value !== null && "jobs" in value && typeof value.jobs === "object" && value.jobs !== null ? value.jobs as Record<string, unknown> : {};
    return { jobs: Object.fromEntries(Object.entries(jobs).filter((entry): entry is [string, Entry] => {
      const job = entry[1] as Partial<Entry> | null;
      return typeof job === "object" && job !== null && typeof job.chat === "string" && typeof job.at === "number";
    })) };
  } };
  return {
    async add(names, chat) {
      const at = now();
      await transactJsonFile(file, state => {
        for (const [name, entry] of Object.entries(state.jobs)) if (at - entry.at > REGISTRY_KEEP_MS) delete state.jobs[name];
        for (const name of names) state.jobs[name] = { chat, at };
      });
    },
    async chatOf(name) { return (await snapshotJsonFile(file)).jobs[name]?.chat; },
    async rootsOf(chat) { return Object.entries((await snapshotJsonFile(file)).jobs).filter(([, entry]) => chat.includes(entry.chat)).map(([name]) => name); },
    async remove(names) { await transactJsonFile(file, state => { for (const name of names) delete state.jobs[name]; }); },
  };
}

/**
 * The brief a chat runs: the bullets its board tool puts in the base prompt, and their version (8 hex of a sha256 over the bullets). A chat
 * pins the brief it loaded (`pinnedBrief`) and keeps it in its system prompt until it compacts, so an edit to CHAT_BRIEF never rewrites a
 * running chat's cached prompt; it reaches the chat as the `briefNote` notice at the end of its history.
 */
export interface Brief { version: string; lines: readonly string[] }
export function chatBrief(lines: readonly string[] = CHAT_BRIEF): Brief {
  return { version: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 8), lines };
}

/** The session entry that pins the brief a chat's system prompt carries: `{ lines }`, written at its first start and after each compaction. */
export const CHAT_BRIEF_ENTRY = "chat_brief";
/** The brief the chat's system prompt carries since its last compaction, or null when none is pinned since then. */
export function pinnedBrief(branch: readonly { type: string; customType?: string; data?: unknown }[]): string[] | null {
  const compact = branch.findLastIndex(entry => entry.type === "compaction");
  const pin = branch.slice(compact + 1).findLast(entry => entry.type === "custom" && entry.customType === CHAT_BRIEF_ENTRY);
  const lines = (pin?.data as { lines?: unknown } | undefined)?.lines;
  return Array.isArray(lines) && lines.every(line => typeof line === "string") ? lines : null;
}

const sentences = (lines: readonly string[]): string[] =>
  lines.flatMap(line => line.split(/(?<=[.!?])\s+(?=[A-Z`"])/)).map(sentence => sentence.trim()).filter(Boolean);

/** What changed between two briefs, sentence by sentence (a bullet holds several rules): the new sentences and the gone ones, in brief order. */
export function briefChanges(before: readonly string[], after: readonly string[]): { added: string[]; dropped: string[] } {
  const old = sentences(before);
  const next = sentences(after);
  return { added: next.filter(sentence => !old.includes(sentence)), dropped: old.filter(sentence => !next.includes(sentence)) };
}

/**
 * The notice a chat gets in its transcript after it reloads onto a changed brief; null when no rule changed. Its system prompt keeps the brief
 * it pinned, so the notice quotes every added and dropped sentence in full.
 */
export function briefNote(before: readonly string[], after: readonly string[]): string | null {
  const { added, dropped } = briefChanges(before, after);
  if (!added.length && !dropped.length) return null;
  return ["[brief] Your chat rules changed. This update overrides the chat rules in your system prompt.",
    ...(added.length ? ["New rules:", ...added.map(sentence => `- ${sentence}`)] : []),
    ...(dropped.length ? ["Rules that no longer hold:", ...dropped.map(sentence => `- ${sentence}`)] : []),
    "Jobs you started keep their old instructions: re-brief a long-running job if this matters."].join("\n");
}

/**
 * The source files that shape a session's requests: this extension (its tools and their schemas, the brief, the context hook with the reply
 * cap, reply-lint notes, corrections, notices and images) and global-rules, which runs in every session. A change in any of them is a new
 * build; a chat or a job of a chat that loaded an older one is reloaded. A file missing from a release hashes as missing.
 */
const BUILD_FILES = ["../extension/index.ts", "chats.ts", "chat-agents.ts", "chat-checkin.ts", "shared/chat-board.ts", "shared/chat-feed.ts", "chat-corrections.ts",
  "correction-delivery.ts", "context-images.ts", "prime-notices.ts", "shared/reply-lint.ts", "shared/turns.ts", "shared/types.ts", "../../global-rules/index.ts"];
/** A short hash of the extension sources on disk now. */
export function extensionBuild(dir: string = import.meta.dirname): string {
  const hash = createHash("sha256");
  for (const file of BUILD_FILES) hash.update(existsSync(join(dir, file)) ? readFileSync(join(dir, file)) : `missing ${file}`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * What to do about a chat that last loaded `loaded` when the build on disk is `build`: reload it now, wait for its turn to end, or nothing.
 * `force` (the owner's Update all chats) reloads a chat on the current build too.
 */
export function reloadAction(loaded: string | undefined, build: string, busy: boolean, force = false): "reload" | "wait" | null {
  if (loaded === build && !force) return null;
  return busy ? "wait" : "reload";
}

/** The build and the brief each chat last loaded, by session id. */
export interface LoadRecord {
  get(id: string): Promise<string | undefined>;
  /** Records what a chat just loaded. Returns the brief it ran before when that one differs from `brief` and its text is on record, else null. */
  set(id: string, build: string, brief?: Brief): Promise<readonly string[] | null>;
  /** The brief version each chat last loaded; a chat loaded before versions were recorded is absent. */
  briefs(): Promise<Record<string, string>>;
  forget(id: string): Promise<void>;
}
type Loads = { builds: Record<string, string>; briefs: Record<string, string>; texts: Record<string, string[]> };
const stringMap = (value: unknown): Record<string, string> => typeof value === "object" && value !== null
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
/** Drops the brief texts no chat runs any more. */
const pruneTexts = (state: Loads): void => {
  const used = new Set(Object.values(state.briefs));
  for (const version of Object.keys(state.texts)) if (!used.has(version)) delete state.texts[version];
};
/**
 * `<data dir>/extension-loads.json` through locked-json: `{ builds: { [sessionId]: build }, briefs: { [sessionId]: version }, texts: { [version]: bullets } }`.
 * The text of each brief a chat runs is kept, so the next change can tell the chat what changed.
 */
export function loadRecord(path: string): LoadRecord {
  const file: JsonFile<Loads> = { path, label: "Extension load record", initial: () => ({ builds: {}, briefs: {}, texts: {} }), parse(value: unknown) {
    const record = typeof value === "object" && value !== null ? value as Partial<Record<keyof Loads, unknown>> : {};
    const texts = typeof record.texts === "object" && record.texts !== null ? Object.entries(record.texts)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(line => typeof line === "string")) : [];
    return { builds: stringMap(record.builds), briefs: stringMap(record.briefs), texts: Object.fromEntries(texts) };
  } };
  return {
    async get(id) { return (await snapshotJsonFile(file)).builds[id]; },
    async set(id, build, brief) {
      const { result } = await transactJsonFile(file, state => {
        state.builds[id] = build;
        if (!brief) return null;
        const was = state.briefs[id];
        const before = was !== undefined && was !== brief.version ? state.texts[was] ?? null : null;
        state.briefs[id] = brief.version;
        state.texts[brief.version] = [...brief.lines];
        pruneTexts(state);
        return before;
      });
      return result;
    },
    async briefs() { return { ...(await snapshotJsonFile(file)).briefs }; },
    async forget(id) { await transactJsonFile(file, state => { delete state.builds[id]; delete state.briefs[id]; pruneTexts(state); }); },
  };
}

/** The time of each chat's last owner reply the reply lint checked, on disk so a server restart neither loses nor repeats a `[reply check]`. */
export interface ReplyCheckRecord {
  /** Records `at` as the chat's last checked reply; true when it is newer than the one on record, so this caller sends the check. */
  claim(id: string, at: number): Promise<boolean>;
}
/** `<data dir>/reply-checks.json` through locked-json: `{ [sessionId]: at }`. */
export function replyCheckRecord(path: string): ReplyCheckRecord {
  const file: JsonFile<Record<string, number>> = { path, label: "Reply check record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))) : {} };
  return {
    async claim(id, at) {
      return (await transactJsonFile(file, state => { if ((state[id] ?? -Infinity) >= at) return false; state[id] = at; return true; })).result;
    },
  };
}
/** A reply older than this when the server first looks at it gets no `[reply check]`: the owner has moved on. */
export const REPLY_CHECK_MAX_AGE_MS = 60 * 60_000;

/** The jobs a `[brief check]` was sent for, on disk so a server restart does not send it again. */
export interface BriefCheckRecord {
  /** Records the job; true when it was not on record, so this caller sends the check. */
  claim(childId: string, spawnedAt: number): Promise<boolean>;
}
/** `<data dir>/brief-checks.json` through locked-json: `{ [childId]: spawn time }`. Entries a day old go on the next claim. */
export function briefCheckRecord(path: string, now: () => number = Date.now): BriefCheckRecord {
  const file: JsonFile<Record<string, number>> = { path, label: "Brief check record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))) : {} };
  return {
    async claim(childId, spawnedAt) {
      return (await transactJsonFile(file, state => {
        if (state[childId] !== undefined) return false;
        for (const [id, at] of Object.entries(state)) if (now() - at > 24 * 60 * 60_000) delete state[id];
        state[childId] = spawnedAt;
        return true;
      })).result;
    },
  };
}
/** A job spawned longer ago than this when the server first sees it gets no `[brief check]`, so a restart does not check every old job. */
export const BRIEF_CHECK_MAX_AGE_MS = 30 * 60_000;
/**
 * A root session's artifacts folder, where the daemon keeps each direct subagent's folder by child id: `session-artifacts/<session id>`
 * beside the folder of its session file (prime-agent `getSessionArtifactPathForFile`).
 */
export const artifactsDir = (sessionFile: string): string => join(dirname(dirname(sessionFile)), "session-artifacts", basename(sessionFile, ".jsonl"));
/** What the daemon stored at a subagent's spawn (`<child folder>/rlm-subagent.json`): the brief as the parent wrote it, and when. Null when unreadable. */
async function spawnRecord(childDir: string): Promise<{ prompt: string; createdAt: number } | null> {
  try {
    const record: unknown = JSON.parse(await readFile(join(childDir, "rlm-subagent.json"), "utf8"));
    if (typeof record !== "object" || record === null) return null;
    const { prompt, createdAt } = record as { prompt?: unknown; createdAt?: unknown };
    return typeof prompt === "string" && typeof createdAt === "number" && Number.isFinite(createdAt) ? { prompt, createdAt } : null;
  } catch { return null; }
}

/** What chats need from the thread hub. ThreadHub satisfies it; tests pass a fake. */
export interface ChatThreads {
  create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name: string; kind: "chat" }): Promise<{ id: string }>;
  /** False when the live limit is reached; the chat then lives like any thread until one is archived. */
  pin(id: string): boolean;
  unpin(id: string): void;
  setSteeringMode(id: string, mode: "all" | "one-at-a-time"): Promise<void>;
  /** The attached session's heartbeat prompt, undefined when it has none. */
  heartbeat(id: string): Promise<string | undefined>;
  clearHeartbeat(id: string): Promise<void>;
  /** Sends text as a steer: it joins the running turn or starts one. A steer to a chat whose last turn failed can wait in its queue unseen. */
  prompt(id: string, input: { message: string; images: []; mode: "steer" }): Promise<void>;
  /**
   * Starts a new turn in a chat whose last turn failed: sends the text and resumes the session's queued input, so neither waits unseen.
   * `abort` first stops a provider retry that holds the turn.
   */
  restart(id: string, message: string, abort?: boolean): Promise<void>;
  /** Stops the running turn or provider retry; the input pump stays suspended until `resumeQueue` or `restart`. */
  abort(id: string): Promise<void>;
  /** Reopens the session's input pump, so queued input runs now. */
  resumeQueue(id: string): Promise<void>;
  /** Deletes a finished subagent of the chat (the daemon's delete_rlm_subagent, the path `rlm.delete_subagent` takes). */
  deleteSubagent(id: string, childId: string): Promise<void>;
  /** Undoes an archive: the session comes back as a saved thread that resumes on the next pin or reply. */
  unarchive(id: string): Promise<void>;
  /** Archives the session: its turn stops, its worker ends and its session file records the archived state. */
  archive(id: string): Promise<void>;
  /** A transcript line that starts no turn; the feed shows it as a notice. */
  notice(id: string, text: string): Promise<void>;
  /** What the feed shows under the owner's unanswered message while a restart waits; null clears it. */
  setWait(id: string, wait: ChatWait | null): void;
  /** A thread's state for a stall check, attaching it first; null when it is not live. */
  view(id: string): Promise<ThreadView | null>;
  /** Whether the thread is mid-turn or has input queued; the reload waits for it. */
  busy(id: string): boolean;
  /** Whether the thread runs a turn now; queued input alone does not count, since after a failed turn it can wait there unseen. */
  running(id: string): boolean;
  /** Re-runs the session's extensions, so it gets the current tools and brief. */
  reload(id: string): Promise<void>;
  /**
   * `reload` for a thread that may not be attached (a job): only when the daemon shows it doing nothing, no turn, queued input or background
   * work in its kernel, which a reload would drop. "busy" leaves it for a later look; "saved" is a thread with no live session, which loads
   * the build on disk when it resumes.
   */
  reloadIdle(id: string): Promise<"reloaded" | "busy" | "saved">;
  /** `live` fires after each attach with the children known then; `children` on every change while attached; `idle` at each turn's end. */
  observe(observer: { live(id: string, children: readonly ChildAgent[]): void; children(id: string, children: readonly ChildAgent[]): void; idle(id: string): void }): () => void;
  /**
   * The chat's state as the server holds it while attached: the no-report notice looks for the job's last message in the transcript, the tick
   * reads who started the running turn and whether the last one failed, and `links` takes the board, the name and the children for the agents list.
   */
  state?(id: string): ThreadView | undefined;
}
/** The parts of a thread's state the chat side reads. */
export interface ThreadView {
  messages: readonly ThreadMessage[]; board?: ChatBoard | null; children?: readonly ChildAgent[]; queue?: QueueState; retry?: RetryState | null;
  info?: { name?: string; model?: ModelInfo | null; thinkingLevel?: ThinkingLevel; availableThinkingLevels?: readonly ThinkingLevel[]; retryAttempt?: number; queuedActions?: number };
}
export type ChatSummary = (id: string) => Promise<{ lifecycle?: string; sessionFile?: string } | undefined>;
/** The chat side's inputs to `chatAgents` (src/chat-agents.ts); the catalog adds the daemon's sessions. */
export interface ChatLinks { children: readonly ChildAgent[]; board: ChatBoard | null; roots: string[]; messages: readonly ThreadMessage[] }

/** What the check-in reads besides the children: the board, the catalog rows (threads a plan item links), its memory and the owner's setting per chat. */
export interface CheckInSource {
  board(id: string): Promise<ChatBoard | null>;
  rows(): Promise<readonly SessionRow[]>;
  /** The roots chats started with rlm.create_session (`<data dir>/chat-jobs.json`); absent in tests that need none. */
  registry?: JobRegistry;
  /** The home folder whose `.prime/agent/session-artifacts/<chat id>/scheduled-jobs.json` holds a chat's heartbeats; the user's home when absent. */
  home?: string;
  memory: CheckInRecord;
  settings: CheckInSettings;
  /** How often the scheduler wakes to run the chats whose interval has passed; 0 starts no timer (tests call `tick`). Default CHECK_IN_TICK_MS. */
  tickMs?: number;
  now?: () => number;
  /** How long a job must stay quiet before the no-report notice; default NO_REPORT_GRACE_MS. Tests pass 0. */
  noReportGraceMs?: number;
  /** The pool's account availability, null when the pool cannot be read. */
  claude?: () => Promise<ClaudeState | null>;
  /** Told at each wake whether any chat or any of its jobs works now; the service holds the Mac awake while it does (src/chat-awake.ts). */
  awake?: (working: boolean) => void;
  /** The last owner reply each chat's `[reply check]` looked at (`<data dir>/reply-checks.json`). */
  replyChecks: ReplyCheckRecord;
  /** The jobs that got a `[brief check]` (`<data dir>/brief-checks.json`). Absent: no brief check runs. */
  briefChecks?: BriefCheckRecord;
  /** The owner's corrections ledger, for its handoffs (`handoffRules`). Absent: no step gets a scope line. */
  corrections?: () => Promise<Ledger>;
  /**
   * The duty runner's side of the check-in duty (src/chat-duty-run.ts): each check-in run is recorded as a run of the built-in duty and starts
   * one check-in job with the precheck as context. Absent (tests): the precheck runs and nothing starts.
   */
  duty?: { checkIn(chatId: string, run: CheckInRun): Promise<CheckInStart | void> };
  /** The chat's duties (`<data dir>/duties/<chat>.json`), for the goals they run (`goalsToFold`). Absent: no goal folds by a duty. */
  duties?: (id: string) => Promise<readonly DutyRef[]>;
  /**
   * `<data dir>/archived-chats.json`: the chats the owner archived (`Chats.archive`), until the owner unarchives one (`Chats.restore`). The
   * scheduler archives such a session again when something else brings it back. Absent (tests): an owner archive is not remembered.
   */
  archived?: IdIndex;
  /**
   * Set on a serve that does not own the live chats (a test or scratch data dir, `chat serve --no-adopt`): `<data dir>/own-chats.json`, the chats
   * this serve created. It pins, steers, reloads and checks in only those, even when its chats.json is a copy of the live one, and never scans
   * the session files for lost chats (10-10: a scratch serve on the real daemon attached 4 live chats and reloaded 3).
   */
  owned?: IdIndex;
}

/** The check-in scheduler wakes this often; each chat runs at its own interval, so an interval is kept to within this much. */
export const CHECK_IN_TICK_MS = 30_000;
/** A check-in whose job could not start runs again after this long, not a whole interval later (`CheckInStart`). */
export const CHECK_IN_RETRY_MS = 5 * 60_000;
/** How often the scheduler looks for chats the index lost, and how recent a thread must be to be looked at. */
export const ADOPT_SCAN_MS = 10 * 60_000;
export const ADOPT_RECENT_MS = 7 * 24 * 60 * 60_000;
/** A job of a chat quiet for longer than this is not looked at for a failed turn. */
export const JOB_WAKE_WINDOW_MS = 24 * 60 * 60_000;
/** A bad job end found later than this after it happened (the first wake after a deploy reads a day of jobs) is left to the check-in. */
export const JOB_END_NOTE_MAX_AGE_MS = 2 * 60 * 60_000;
/** A job as the scheduler found it in its chat's row: the chat and its Agents entry. */
interface ChatJob { chat: string; agent: ChatAgent }

/**
 * Chats on the server: the index, residency (pinned, so they stay attached and resident), steering mode `all` after every attach (it is runtime
 * state), the check-in scheduler (each chat at its own interval, none while the owner paused it), the restart of
 * a chat whose last turn failed, the no-report notice, and the extension build: a chat that last loaded an older build than the one on disk is
 * reloaded when it attaches, at once if idle, else at the end of its turn. Everything converges from the index plus the daemon list, so a restart
 * re-adopts what it finds, and a scan of the session files brings back a chat the index lost.
 */
export class Chats {
  private readonly chatIds = new Set<string>();
  /** The children last seen per thread: the tick reads them, and each change is compared with them to find a job that ended with no report. */
  private readonly children = new Map<string, readonly ChildAgent[]>();
  /**
   * When each job was last seen starting to work, and the end (its last activity) last told to the chat, with the time of the job message it
   * was told as waiting on (none for "ended with no report").
   */
  private readonly workingSince = new Map<string, number>();
  private readonly noticedEnd = new Map<string, { end: number; waited?: number }>();
  /** Chats found stale while mid-turn; the end of the turn reloads them. */
  private readonly reloadWaiting = new Set<string>();
  /** Chats the owner's Update all chats reloads even on the current build; each leaves the set once its reload ran. */
  private readonly forced = new Set<string>();
  /** The brief this service's chats load (CHAT_BRIEF): what a chat on an older one is updated to. */
  private readonly brief = chatBrief();
  /** Told when a chat's brief state changes (a reload queued, waiting or done), so the sessions stream sends the rows again. */
  briefChanged: () => void = () => {};
  private readonly syncing = new Map<string, Promise<void>>();
  private loaded: Promise<void> | undefined;
  private readonly unobserve: () => void;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  /** When each chat's check-in last ran: the check-in memory's time after a restart, the service start for a chat with none. */
  private readonly lastCheckIn = new Map<string, number>();
  private readonly started: number;
  /** Restarts sent per chat since its last turn that ended well: how many, and when the last one went. */
  private readonly revivals = new Map<string, { attempts: number; at: number }>();
  /** When each chat's current stall was first seen, for a provider retry whose failed reply the hub does not hold. */
  private readonly stallSeen = new Map<string, number>();
  /** Wakes sent per stranded step-owner thread: how many, and when the last one went. */
  private readonly ownerWakes = new Map<string, { attempts: number; at: number }>();
  /** When the scheduler last woke; a longer gap than SLEEP_GAP_MS means the Mac slept. */
  private lastTick: number | null = null;
  /** The subagents and create_session roots of the chats, as the last wake found them, and the wakes sent to each for a transient failure. */
  private jobThreads = new Set<string>();
  /** The jobs of the chats seen since the first look after this service started (undefined before it), and the ones known on this build. */
  private jobsSeen: Set<string> | undefined;
  private readonly jobsCurrent = new Set<string>();
  private readonly jobWakes = new Map<string, JobWake>();
  /** The activity stamp at which a job thread was last found with no transient failure; it is looked at again once the stamp changes. */
  private readonly jobQuiet = new Map<string, string>();
  /** When each chat's finished jobs were last checked, and the jobs already deleted (or tried once). */
  private readonly cleanedAt = new Map<string, number>();
  private readonly deletedJobs = new Set<string>();
  /** Job threads found gone (`threadGone`) at an activity stamp: never looked at again unless the stamp changes. */
  private readonly jobGone = new Map<string, string>();
  /** When the scheduler last looked for lost chats, and the threads with messages found plain (their head never changes). */
  private lastScan: number;
  private readonly plain = new Set<string>();
  /** Jobs whose brief was read for the brief check, and the spawn time of each subagent folder read so far (they never change). */
  private readonly briefSeen = new Set<string>();
  private readonly spawnTimes = new Map<string, number>();

  /**
   * `index` is `<data dir>/chats.json`: the session ids that are chats, newest first. The chat side's one definition of "chat"; the session entry
   * is the agent side's. `build` is the extension build on disk (`extensionBuild()`), `loads` the one each chat last loaded.
   */
  constructor(readonly index: IdIndex, private readonly threads: ChatThreads, private readonly summary: ChatSummary, private readonly build: string,
    private readonly loads: LoadRecord, private readonly source: CheckInSource, private readonly log: (line: string) => void = () => {}) {
    this.now = source.now ?? Date.now;
    this.started = this.now();
    this.lastScan = this.started;
    this.unobserve = threads.observe({
      live: (id, children) => {
        this.children.set(id, children);
        for (const child of children) if (!this.briefSeen.has(child.id)) this.queue(id, () => this.briefCheck(id, child));
        this.queue(id, () => this.attached(id));
        this.queue(id, () => this.refreshExtension(id));
        // A reply sent just before a restart ended its turn on the old server; an idle chat gets its check when it attaches.
        if (!this.threads.busy(id)) this.queue(id, () => this.replyCheck(id));
      },
      children: (id, children) => {
        const before = this.children.get(id);
        this.children.set(id, children);
        for (const child of children) if (childWorking(child) && !before?.some(was => was.id === child.id && childWorking(was))) this.workingSince.set(child.id, this.now());
        if (before) for (const child of endedWithoutReport(before, children)) this.laterNoReport(id, child.id);
        for (const child of children) if (!this.briefSeen.has(child.id)) this.queue(id, () => this.briefCheck(id, child));
      },
      idle: id => { if (this.reloadWaiting.has(id)) this.queue(id, () => this.refreshExtension(id)); this.queue(id, () => this.replyCheck(id)); },
    });
    const tickMs = source.tickMs ?? CHECK_IN_TICK_MS;
    if (tickMs > 0) {
      this.timer = setInterval(() => { void this.tick(); }, tickMs);
      this.timer.unref();
    }
  }

  /** Tasks of one thread run one after another; `settled` resolves once every queue is empty, for tests. */
  private queue(id: string, task: () => Promise<void>): void {
    const next = (this.syncing.get(id) ?? Promise.resolve()).then(task);
    this.syncing.set(id, next);
    void next.finally(() => { if (this.syncing.get(id) === next) this.syncing.delete(id); });
  }

  async settled(): Promise<void> { while (this.syncing.size) await Promise.all([...this.syncing.values()]); }

  /**
   * The index, and each chat's last check-in from the check-in memory, so a service restart keeps every chat's schedule instead of starting it
   * over (10-09: three restarts in 16 min kept a 15-min chat from any check-in).
   */
  private load(): Promise<void> {
    return this.loaded ??= this.index.ids().then(ids => this.mine(ids)).then(async ids => {
      for (const id of ids) {
        this.chatIds.add(id);
        const at = (await this.source.memory.get(id).catch(() => undefined))?.at;
        if (at !== undefined && !this.lastCheckIn.has(id)) this.lastCheckIn.set(id, Math.min(at, this.now()));
      }
    });
  }

  /** The ids of `ids` this service acts on: all of them, or only the ones it created when it does not own the live chats. */
  private async mine(ids: readonly string[]): Promise<string[]> {
    if (!this.source.owned) return [...ids];
    const owned = new Set(await this.source.owned.ids());
    return ids.filter(id => owned.has(id));
  }

  async ids(): Promise<ReadonlySet<string>> { await this.load(); return this.chatIds; }

  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name?: string }): Promise<{ id: string; name: string }> {
    await this.load();
    const name = input.name?.trim() || chatName();
    const { id } = await this.threads.create({ cwd: input.cwd, ...(input.provider ? { provider: input.provider } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}), name, kind: "chat" });
    await this.source.owned?.add(id);
    await this.index.add(id);
    this.chatIds.add(id);
    if (!this.threads.pin(id)) this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    await this.threads.setSteeringMode(id, "all");
    await this.loads.set(id, this.build, this.brief);
    return { id, name };
  }

  /**
   * At service start: pin every chat in the index and forget the ones the daemon does not list. With the daemon down the catalog cannot answer,
   * so the chat stays pinned and the pin resumes or drops it on the first catalog update. A pinned saved chat resumes the same way.
   * A chat the daemon lists as archived is unarchived: the archive route forgets a chat the moment it archives it, so an archived chat still in
   * the index was archived by the daemon itself. `prime-agent shutdown --force` and an update restart write the archived state into every live
   * session (10-12 11:38: a forced shutdown archived 25 sessions, and this serve then dropped all 9 chats from the index). A chat the owner
   * archived is forgotten here too, in case the archive route stopped before it left the index.
   */
  async adopt(): Promise<{ pinned: string[]; forgotten: string[]; adopted: string[] }> {
    await this.load();
    const pinned: string[] = [];
    const forgotten: string[] = [];
    const archived = new Set(await this.source.archived?.ids() ?? []);
    for (const id of await this.mine(await this.index.ids())) {
      const summary = await this.summary(id).then(summary => summary ?? "missing", () => "unknown" as const);
      if (summary === "missing" || archived.has(id)) {
        await this.forget(id);
        forgotten.push(id);
        this.log(`chat ${id.slice(0, 8)}: forgotten, ${summary === "missing" ? "the daemon does not list it" : "the owner archived it"}`);
        continue;
      }
      if (summary !== "unknown" && summary.lifecycle === "archived") {
        try {
          await this.threads.unarchive(id);
          this.log(`chat ${id.slice(0, 8)}: unarchived: the daemon archived it, the chat list did not`);
        } catch (error) { this.log(`chat ${id.slice(0, 8)}: unarchive: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (this.threads.pin(id)) pinned.push(id);
      else this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    }
    await this.keepArchived();
    return { pinned, forgotten, adopted: await this.rescan() };
  }

  /**
   * The owner's archive of a chat: the session is archived, the chat leaves the index, and the archived-chats file keeps it, so `keepArchived`
   * archives it again when something else brings the session back.
   */
  async archive(id: string): Promise<void> {
    await this.threads.archive(id);
    await this.source.archived?.add(id);
    await this.forget(id);
  }

  /**
   * Archives again each chat the owner archived that the daemon lists unarchived. An agent message to an archived session resumes it, and the
   * scan then took it back as a chat (10-12 20:38 KST: a relayed broadcast resumed "stripe and payments", archived by the owner at 16:31).
   * Runs at start and on every scheduler wake.
   */
  async keepArchived(): Promise<void> {
    if (!this.source.archived || this.source.owned) return;
    const archived = new Set(await this.source.archived.ids());
    if (!archived.size) return;
    let rows: readonly SessionRow[];
    try { rows = await this.source.rows(); }
    catch (error) { this.log(`chats: archived: ${error instanceof Error ? error.message : String(error)}`); return; }
    for (const row of rows) {
      if (!archived.has(row.id) || row.archived) continue;
      try {
        await this.threads.archive(row.id);
        this.log(`chat ${row.id.slice(0, 8)}: archived again: the owner archived it and the daemon brought it back`);
      } catch (error) { this.log(`chat ${row.id.slice(0, 8)}: archive again: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /**
   * Brings back chats the index lost (an unarchive outside this server, a lost index write): every recent unarchived thread whose session file
   * carries the chat_mode entry is restored and logged. A thread with messages found plain is not read again: the entry precedes the first message.
   */
  async rescan(): Promise<string[]> {
    if (this.source.owned) return [];
    await this.load();
    const now = this.now();
    let rows: readonly SessionRow[];
    try { rows = await this.source.rows(); }
    catch (error) { this.log(`chats: scan: ${error instanceof Error ? error.message : String(error)}`); return []; }
    const adopted: string[] = [];
    const archived = new Set(await this.source.archived?.ids() ?? []);
    for (const row of rows) {
      if (this.chatIds.has(row.id) || this.plain.has(row.id) || row.archived || archived.has(row.id)) continue;
      if (now - (Date.parse(row.lastActivityAt ?? row.created ?? "") || 0) > ADOPT_RECENT_MS) continue;
      const restored = await this.restore(row.id).catch((error: unknown) => {
        this.log(`chat ${row.id.slice(0, 8)}: scan: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (restored) {
        adopted.push(row.id);
        this.log(`chat ${row.id.slice(0, 8)}: re-adopted: its session file has the chat_mode entry, the chat index did not`);
      } else if (restored === false && row.messageCount > 0) this.plain.add(row.id);
    }
    return adopted;
  }

  /**
   * After an unarchive: a session whose file carries the chat_mode entry is a chat again, back in the index, pinned, with steering `all`. False for a
   * plain thread. Steering resumes the session; a failure there is logged, since the pin resumes it again and the attach re-applies steering.
   * The owner's unarchive (the route) and the scan call it; the scan skips the chats the owner archived, so only the owner takes one back.
   */
  async restore(id: string): Promise<boolean> {
    await this.load();
    if (!(await this.mine([id])).length) return false;
    await this.source.archived?.forget(id);
    const sessionFile = (await this.summary(id))?.sessionFile;
    if (!sessionFile || !(await fileHasChatMarker(sessionFile))) return false;
    await this.index.add(id);
    this.chatIds.add(id);
    if (!this.threads.pin(id)) this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    try { await this.threads.setSteeringMode(id, "all"); }
    catch (error) { this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }
    return true;
  }

  async forget(id: string): Promise<void> {
    this.threads.unpin(id);
    this.children.delete(id);
    this.reloadWaiting.delete(id);
    this.forced.delete(id);
    this.chatIds.delete(id);
    await this.index.forget(id);
    await this.loads.forget(id);
    await this.source.memory.forget(id);
  }

  /** The owner's settings, or none when the file cannot be read (logged): every chat then runs at the default interval. */
  private async settings(): Promise<Record<string, CheckInSetting>> {
    try { return await this.source.settings.all(); }
    catch (error) { this.log(`check-in settings: ${error instanceof Error ? error.message : String(error)}`); return {}; }
  }

  /**
   * One scheduler wake: queues the check-in of every chat whose interval has passed since its last one and that is not paused; the time is
   * taken before the run is queued, so a second wake in the same slot does not queue it again. Every chat that is not paused is also checked for a failed
   * last turn (`revive`), and so are its jobs (`jobs`); a wake that follows a sleep restarts every transient failure at once. Every
   * ADOPT_SCAN_MS the session files are scanned for chats the index lost. Returns the ids checked in.
   */
  async tick(): Promise<string[]> {
    await this.load();
    const settings = await this.settings();
    const now = this.now();
    const woke = wokeFromSleep(this.lastTick, now);
    if (woke) this.log(`chats: woke after ${Math.round((now - this.lastTick!) / 1000)} s; transient failures restart now`);
    this.lastTick = now;
    if (now - this.lastScan >= ADOPT_SCAN_MS) { this.lastScan = now; this.queue("#scan", async () => { await this.rescan(); }); }
    this.queue("#archived", () => this.keepArchived());
    const due: string[] = [];
    const active = new Set<string>();
    for (const id of this.chatIds) {
      if (this.children.has(id) && now - (this.cleanedAt.get(id) ?? -Infinity) >= JOB_CLEANUP_EVERY_MS) { this.cleanedAt.set(id, now); this.queue(id, () => this.cleanJobs(id)); }
      const setting = settings[id] ?? DEFAULT_CHECK_IN;
      if (activePause(setting, now) !== null) continue;
      active.add(id);
      this.queue(id, () => this.revive(id, woke));
      // A chat with no check-in on record is due now, not one interval after this service started: every release restart pushed ops guy's
      // 2 h check-in back again (10-12: none from 10-10 11:33Z on, with its owner pause lifted at 05:28Z).
      const next = nextCheckIn(setting, this.lastCheckIn.get(id) ?? now - setting.everyMs, now);
      if (next === null || next > now) continue;
      due.push(id);
      this.lastCheckIn.set(id, now);
      this.queue(id, async () => { await this.checkIn(id); });
    }
    this.queue("#jobs", () => this.jobs(active, woke));
    return due;
  }

  /**
   * Deletes each finished job of a chat (`finishedJobs`) once, with one log line, so its worker and Python kernel stop holding memory. A board
   * that cannot be read deletes nothing; a failed delete is logged and not tried again.
   */
  private async cleanJobs(id: string): Promise<void> {
    const children = this.children.get(id);
    if (!children?.length) return;
    let board: ChatBoard | null;
    try { board = await this.source.board(id); }
    catch (error) { this.log(`chat ${id.slice(0, 8)}: job cleanup: ${error instanceof Error ? error.message : String(error)}`); return; }
    const now = this.now();
    for (const child of finishedJobs(children, board, now)) {
      if (this.deletedJobs.has(child.id)) continue;
      this.deletedJobs.add(child.id);
      try {
        await this.threads.deleteSubagent(id, child.id);
        this.log(`chat ${id.slice(0, 8)}: deleted finished job ${childName(child)} (reported, quiet ${Math.round((now - child.lastActivityAt!) / 60_000)} min, no open step)`);
      } catch (error) { this.log(`chat ${id.slice(0, 8)}: delete finished job ${childName(child)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /**
   * The jobs of the chats, from the catalog rows: tells `awake` whether any chat or job works, and looks at each subagent and create_session
   * root of a chat that is not paused for a turn that ended in a transient failure (`wakeJob`). A job is read again only when its activity
   * changed since it was last found fine, or while a failure of it waits for its wake.
   */
  private async jobs(active: ReadonlySet<string>, woke: boolean): Promise<void> {
    let rows: readonly SessionRow[];
    try { rows = await this.source.rows(); }
    catch (error) { this.log(`chats: jobs: ${error instanceof Error ? error.message : String(error)}`); return; }
    const chatRows = rows.filter(row => this.chatIds.has(row.id));
    this.refreshJobs(chatRows);
    this.source.awake?.(chatRows.some(row => row.working || (row.agents ?? []).some(agent => agent.state === "working")));
    const now = this.now();
    const threads = new Set<string>();
    for (const row of chatRows) {
      if (!active.has(row.id)) continue;
      for (const agent of row.agents ?? []) {
        const threadId = agent.sessionId;
        if (!threadId || (agent.link !== "subagent" && agent.link !== "root") || this.chatIds.has(threadId) || threads.has(threadId)) continue;
        threads.add(threadId);
        const stamp = agent.lastActivityAt ?? "";
        if (agent.state === "working" || now - (Date.parse(stamp) || 0) > JOB_WAKE_WINDOW_MS) { this.jobQuiet.delete(threadId); this.jobWakes.delete(threadId); continue; }
        if (this.jobGone.get(threadId) === stamp || (!this.jobWakes.has(threadId) && this.jobQuiet.get(threadId) === stamp)) continue;
        this.queue(threadId, () => this.wakeJob(threadId, stamp, woke, { chat: row.id, agent }));
      }
    }
    for (const threadId of this.jobThreads) if (!threads.has(threadId)) { this.jobQuiet.delete(threadId); this.jobWakes.delete(threadId); this.jobGone.delete(threadId); }
    this.jobThreads = threads;
  }

  /**
   * The extension build of each job of a chat (a subagent or a create_session root), kept the way `refreshExtension` keeps a chat's: a job
   * that last loaded an older build than the one on disk, or that already ran when this service first looked, is reloaded once it runs
   * nothing, one job at a time; a job that shows up later started on this build. A working job is looked at again on a later tick.
   */
  private refreshJobs(chatRows: readonly SessionRow[]): void {
    const first = this.jobsSeen === undefined;
    const seen = this.jobsSeen ??= new Set();
    for (const agent of chatRows.flatMap(row => row.agents ?? [])) {
      const id = agent.sessionId;
      if (!id || (agent.link !== "subagent" && agent.link !== "root") || this.chatIds.has(id) || this.jobsCurrent.has(id)) continue;
      const fresh = !first && !seen.has(id);
      seen.add(id);
      if (agent.state === "working" && !fresh) continue;
      this.queue("#reload", () => this.refreshJob(id, fresh));
    }
  }

  private async refreshJob(id: string, fresh: boolean): Promise<void> {
    if (this.jobsCurrent.has(id)) return;
    try {
      const loaded = await this.loads.get(id);
      if (!(loaded === undefined && fresh) && reloadAction(loaded, this.build, false) === "reload") {
        const result = await this.threads.reloadIdle(id);
        if (result === "busy") return;
        if (result === "reloaded") this.log(`job ${id.slice(0, 8)}: extension reloaded, build ${this.build}`);
      }
      if (loaded !== this.build) await this.loads.set(id, this.build);
      this.jobsCurrent.add(id);
    } catch (error) {
      this.log(`job ${id.slice(0, 8)}: reload: ${error instanceof Error ? error.message : String(error)}`);
      if (threadGone(error)) { this.jobsCurrent.add(id); await this.loads.forget(id).catch(() => {}); }
    }
  }

  /**
   * A job whose last turn ended in a transient failure is woken the way the owner did it by hand: abort when a provider retry holds it, a
   * `continue` steer, resume the queue. Once per failure, on the TRANSIENT_RETRY_BACKOFF_MS schedule, and at once after a sleep. Any other bad
   * end goes to `jobEndNote`; the wake runs first, so a job it revives gets no note.
   */
  private async wakeJob(threadId: string, stamp: string, woke: boolean, job?: ChatJob): Promise<void> {
    const now = this.now();
    try {
      const state = await this.threads.view(threadId);
      const stall = state ? turnStall(turnViewOf(state, this.threads.running(threadId)), now) : null;
      const last = this.jobWakes.get(threadId);
      const action = jobWake({ stall, last, woke, now });
      if (action === "none") {
        this.jobWakes.delete(threadId);
        this.jobQuiet.set(threadId, stamp);
        if (job && state) this.queue(job.chat, () => this.jobEndNote(threadId, job, state.messages));
        return;
      }
      this.jobQuiet.delete(threadId);
      if (action === "wait") { if (!last) this.jobWakes.set(threadId, { failureAt: Number.NaN, attempts: 0, at: stall!.at }); return; }
      const attempts = woke ? 1 : (last?.attempts ?? 0) + 1;
      this.jobWakes.set(threadId, { failureAt: stall!.at, attempts, at: now });
      await this.threads.restart(threadId, "continue", stall!.retrying);
      this.log(`job ${threadId.slice(0, 8)}: last turn failed (${stall!.error}); woke it${woke ? " after a sleep" : ""}, try ${attempts}`);
    } catch (error) {
      const gone = threadGone(error);
      if (gone) { this.jobGone.set(threadId, stamp); this.jobWakes.delete(threadId); this.jobQuiet.delete(threadId); }
      this.log(`job ${threadId.slice(0, 8)}: ${gone ? "gone, not woken again" : "wake"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private messages(id: string): readonly ThreadMessage[] | undefined { return this.threads.state?.(id)?.messages; }

  /** The stall of a chat's last turn as the hub holds it: a failure with nothing running, or a provider retry holding the turn after one. */
  private stall(id: string): Stall | null {
    const state = this.threads.state?.(id);
    return state ? turnStall(turnViewOf(state, this.threads.running(id)), this.now()) : null;
  }

  private async claude(): Promise<ClaudeState | null> {
    return this.source.claude ? this.source.claude().catch(() => null) : null;
  }

  private async revive(id: string, woke = false): Promise<void> {
    if (!this.chatIds.has(id)) return;
    const state = this.threads.state?.(id);
    if (!state) return;
    const view = turnViewOf(state, this.threads.running(id));
    if (view.running && !view.retrying) return;
    const now = this.now();
    const stall = turnStall(view, now);
    if (!stall) {
      this.revivals.delete(id);
      this.stallSeen.delete(id);
      this.threads.setWait(id, null);
      return;
    }
    const provider = state.info?.model?.provider ?? null;
    const claude = provider === "anthropic" ? await this.claude() : null;
    const down = claudeDown(stall.error, provider, claude);
    const seen = this.stallSeen.get(id) ?? now;
    this.stallSeen.set(id, seen);
    // After a sleep a transient failure starts its schedule over.
    const last = woke && failureCause(stall.error) === "transient" ? undefined : this.revivals.get(id);
    const action = stallAction({ stall, down, claude, attempts: last?.attempts ?? 0, since: last?.at ?? Math.min(stall.at, seen), now, woke });
    if (action.kind !== "restart") { this.threads.setWait(id, action.kind === "wait" ? action.wait : null); return; }
    const attempts = (last?.attempts ?? 0) + 1;
    this.revivals.set(id, { attempts, at: now });
    this.threads.setWait(id, null);
    try {
      await this.threads.restart(id, action.message, action.abort);
      this.log(`chat ${id.slice(0, 8)}: last turn failed (${stall.error}); started a new turn, try ${attempts}${woke ? " after a sleep" : ""}`);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: restart: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A thread that owns an open step, whose last turn failed and that still holds queued input (an owner message, a job report), is woken the
   * way the owner did it by hand: abort, a `continue` steer, resume the queue. Again on the RETRY_BACKOFF_MS schedule while it stays stranded.
   */
  private async wakeOwner(threadId: string): Promise<void> {
    if (this.chatIds.has(threadId)) return;
    const now = this.now();
    const last = this.ownerWakes.get(threadId);
    if (last && !retryDue(last.attempts - 1, last.at, now)) return;
    try {
      const state = await this.threads.view(threadId);
      const stall = state ? turnStall(turnViewOf(state, this.threads.running(threadId)), now) : null;
      if (!strandedInput(stall)) { this.ownerWakes.delete(threadId); return; }
      // A job's transient failure is woken by `wakeJob` on its faster schedule.
      if (this.jobThreads.has(threadId) && failureCause(stall!.error) === "transient") return;
      this.ownerWakes.set(threadId, { attempts: (last?.attempts ?? 0) + 1, at: now });
      await this.threads.restart(threadId, "continue", true);
      this.log(`thread ${threadId.slice(0, 8)}: last turn failed (${stall!.error}) with ${stall!.queued} queued; woke it`);
    } catch (error) {
      this.log(`thread ${threadId.slice(0, 8)}: wake: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * After the owner changes a thread's model or account: a stalled turn goes again now, on the new choice. A chat restarts its turn (quoting
   * the owner's message when the owner started it); a plain thread only gets its provider retry stopped and its queued input resumed, so the
   * next send runs at once. A no-op for a thread whose last turn ended well.
   */
  async retryNow(id: string): Promise<void> {
    await this.load();
    const chat = this.chatIds.has(id);
    await new Promise<void>(resolve => this.queue(id, async () => {
      try {
        const state = chat ? this.threads.state?.(id) : await this.threads.view(id);
        if (!state) return;
        const view = turnViewOf(state, this.threads.running(id));
        if (view.running && !view.retrying) return;
        const stall = turnStall(view, this.now());
        if (!stall) return;
        if (chat) {
          this.revivals.set(id, { attempts: 1, at: this.now() });
          this.threads.setWait(id, null);
          await this.threads.restart(id, revivalMessage(stall), stall.retrying);
          this.log(`chat ${id.slice(0, 8)}: the owner changed its model or account; started a new turn`);
        } else if (stall.retrying || stall.queued > 0) {
          await this.threads.abort(id);
          await this.threads.resumeQueue(id);
        }
      } catch (error) {
        this.log(`thread ${id.slice(0, 8)}: retry after a change: ${error instanceof Error ? error.message : String(error)}`);
      } finally { resolve(); }
    }));
  }

  private state(id: string, setting: CheckInSetting, now: number): CheckInView {
    const pausedUntil = activePause(setting, now);
    const lastAt = this.lastCheckIn.get(id) ?? null;
    return { everyMs: setting.everyMs, paused: pausedUntil !== null, nextAt: nextCheckIn(setting, lastAt ?? now - setting.everyMs, now), pausedUntil, lastAt };
  }

  /**
   * What `chatAgents` needs from the chat side for one chat: the hub's child snapshots, the board (the hub's copy while attached, else the file),
   * the roots the registry lists under the chat's name or id, and the transcript the hub holds. Empty for a thread that is not a chat.
   */
  async links(id: string): Promise<ChatLinks> {
    await this.load();
    if (!this.chatIds.has(id)) return { children: [], board: null, roots: [], messages: [] };
    const state = this.threads.state?.(id);
    const board = state?.board !== undefined ? state.board : await this.source.board(id).catch(() => null);
    const name = state?.info?.name?.trim();
    const roots = this.source.registry ? await this.source.registry.rootsOf(name ? [id, name] : [id]).catch(() => []) : [];
    return { children: this.children.get(id) ?? state?.children ?? [], board, roots, messages: state?.messages ?? [] };
  }

  /** The sessions stream's check-in field for every chat. */
  async checkIns(): Promise<ReadonlyMap<string, CheckInState>> {
    await this.load();
    const settings = await this.settings();
    const now = this.now();
    return new Map([...this.chatIds].map(id => {
      const { lastAt: _lastAt, ...state } = this.state(id, settings[id] ?? DEFAULT_CHECK_IN, now);
      return [id, state];
    }));
  }

  /** A chat's check-in as the owner's control shows it; null for a thread that is not a chat. */
  async checkInView(id: string): Promise<CheckInView | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    return this.state(id, await this.source.settings.get(id), this.now());
  }

  /**
   * A change to a chat's check-in by the owner's page or an agent; null for a thread that is not a chat, CheckInRefused when an agent changes a
   * pause it may not. The scheduler reads the new setting at its next wake.
   */
  async setCheckIn(id: string, change: CheckInChange, actor: CheckInActor): Promise<CheckInView | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    const now = this.now();
    let refused: string | undefined;
    const setting = await this.source.settings.update(id, current => {
      const result = changeCheckIn(current, change, now, actor);
      if ("refused" in result) { refused = result.refused; return current; }
      return result.setting;
    });
    if (refused) throw new CheckInRefused(`check-in refused: ${refused}`);
    return this.state(id, setting, now);
  }

  /**
   * One check-in run for a chat (Chats.tick at its interval, or the owner's Run now): the precheck in code (`checkInPrecheck`: each step's
   * class, the misses against the duty's targets), kept as the new memory, then handed to the duty runner, which starts one check-in job with
   * it as context (src/chat-duty-run.ts). Every run with something to check starts a job, met targets included; the job decides what needs
   * work. A chat with no job at work, no open plan step, no board read error and no ask overflow has nothing to check.
   */
  async checkIn(id: string, trigger: CheckInRun["trigger"] = "schedule"): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      const { board, boardError, rows, facts, name } = await this.gather(id);
      for (const fact of facts) if (fact.state === "failed" && fact.key.startsWith("thread:")) this.queue(fact.key, () => this.wakeOwner(fact.key.slice("thread:".length)));
      if (!checkInDue(facts, board, boardError)) return;
      const at = this.now();
      const self = name ? [id, name] : [id];
      const everyMs = (await this.source.settings.get(id)).everyMs;
      const duties = await this.source.duties?.(id).catch(error => { this.log(`chat ${id.slice(0, 8)}: check-in duties: ${error instanceof Error ? error.message : String(error)}`); return []; }) ?? [];
      const jobs = this.source.registry ? await this.source.registry.rootsOf(self).catch(() => []) : [];
      const heartbeats = readHeartbeats(heartbeatsFile(id, this.source.home));
      const precheck = checkInPrecheck(await this.source.memory.get(id), facts, board, at,
        { self, rows, ...await this.ledger(id), everyMs, duties, jobs, heartbeats, ...(boardError !== undefined ? { boardError } : {}) });
      await this.source.memory.set(id, precheck.memory);
      const output = convergenceMisses(id, precheck.steps, precheck, await this.source.memory.ends(id), everyMs, at);
      const start = await this.source.duty?.checkIn(id, { at, trigger, everyMs, output, classes: classCounts(precheck.steps), findings: checkInPrecheckText(precheck, facts, output.flagged, at) });
      if (start === "failed" && everyMs > CHECK_IN_RETRY_MS) this.lastCheckIn.set(id, at - everyMs + CHECK_IN_RETRY_MS);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: check-in: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What a check-in reads: the board (or why it cannot be read), the catalog rows, the chat's name, and its jobs with their last messages. */
  private async gather(id: string): Promise<{ board: ChatBoard | null; boardError?: string; rows: readonly SessionRow[]; facts: ReturnType<typeof jobFacts>; name?: string }> {
    let board: ChatBoard | null = null;
    let boardError: string | undefined;
    try { board = await this.source.board(id); }
    catch (error) { boardError = error instanceof Error ? error.message : String(error); this.log(`chat ${id.slice(0, 8)}: check-in board: ${boardError}`); }
    const rows = await this.source.rows();
    const said = lastJobMessages(this.messages(id) ?? []);
    const facts = jobFacts(this.children.get(id) ?? [], board, rows, id).map(fact => {
      const lastMessage = fact.key.startsWith("thread:") ? undefined : said.get(fact.name);
      return lastMessage ? { ...fact, lastMessage } : fact;
    });
    const name = rows.find(row => row.id === id)?.name;
    return { board, ...(boardError !== undefined ? { boardError } : {}), rows, facts, ...(name ? { name } : {}) };
  }

  /**
   * The ledger's handoffs for the scope check and the ids of the corrections in force, for parked steps; no handoffs and no ids (every cited id
   * counts) when the ledger cannot be read (logged).
   */
  private async ledger(id: string): Promise<{ handoffs: ReturnType<typeof handoffRules>; corrections?: string[] }> {
    if (!this.source.corrections) return { handoffs: [] };
    return this.source.corrections().then(ledger => ({ handoffs: handoffRules(ledger), corrections: activeCorrections(ledger) }), error => {
      this.log(`chat ${id.slice(0, 8)}: check-in corrections: ${error instanceof Error ? error.message : String(error)}`);
      return { handoffs: [] };
    });
  }

  /** The owner's Run now on the check-in duty: a check-in at once, in the chat's queue, and its schedule starts over. */
  runCheckIn(id: string): Promise<void> {
    return new Promise(resolve => this.queue(id, async () => {
      try { if (this.chatIds.has(id)) { this.lastCheckIn.set(id, this.now()); await this.checkIn(id, "owner"); } } finally { resolve(); }
    }));
  }

  /**
   * A job that stopped working without a report is checked again after a grace period: a job between two tool calls, resumed by a reply, or
   * deleted in the meantime is not reported. Each end is reported once.
   */
  private laterNoReport(id: string, childId: string): void {
    const timer = setTimeout(() => this.queue(id, () => this.noReport(id, childId)), this.source.noReportGraceMs ?? NO_REPORT_GRACE_MS);
    timer.unref?.();
  }

  private async noReport(id: string, childId: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const child = this.children.get(id)?.find(candidate => candidate.id === childId);
    if (!child || childWorking(child) || child.status === "cancelled" || child.repliedSinceTask !== false) return;
    const lastMessage = lastJobMessages(this.messages(id) ?? []).get(childName(child));
    const wokeAt = this.workingSince.get(child.id) ?? 0;
    const waited = lastMessage !== undefined && lastMessage.at >= wokeAt ? lastMessage.at : undefined;
    const end = child.lastActivityAt ?? this.now();
    const told = this.noticedEnd.get(child.id);
    if (told !== undefined && Math.abs(end - told.end) < NO_REPORT_SAME_END_MS && told.waited === waited) return;
    this.noticedEnd.set(child.id, { end, ...(waited !== undefined ? { waited } : {}) });
    if (this.stall(id)) { this.log(`chat ${id.slice(0, 8)}: no notice for ${childName(child)}: the chat's last turn failed; the next check-in job sees it`); return; }
    try {
      await this.threads.prompt(id, { message: `${JOB_NOTICE_PREFIX}${noReportNotice(childName(child), lastMessage, wokeAt, end)}`, images: [], mode: "steer" });
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: no-report notice: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * A job (a subagent, or a root the chat started with rlm.create_session) whose last turn ended on a provider error, an abort, a stop mid-tool
   * or the length limit, and that sent the chat no report since its last start, is told to the chat at once as one plain `[job]` line with the
   * cause (`jobEndText`); the chat decides what to do. Once per end: the end is kept in the check-in record, so a restart does not tell it
   * again, the check-in counts it in `job_end_silent`, and the no-report notice skips it. A cancelled job, a job
   * at work again, a subagent with no child snapshot, an end older than JOB_END_NOTE_MAX_AGE_MS, and a chat whose transcript the server does not
   * hold are left out.
   */
  private async jobEndNote(threadId: string, job: ChatJob, messages: readonly ThreadMessage[]): Promise<void> {
    const { chat, agent } = job;
    if (!this.chatIds.has(chat) || this.threads.running(threadId)) return;
    const end = jobEnd(messages);
    const now = this.now();
    if (!end || now - end.at > JOB_END_NOTE_MAX_AGE_MS) return;
    const child = agent.childId !== undefined ? this.children.get(chat)?.find(candidate => candidate.id === agent.childId) : undefined;
    // A subagent the server holds no snapshot of cannot be told apart from a cancelled job or one that replied.
    if (agent.link === "subagent" ? !child || childWorking(child) || child.status === "cancelled" : false) return;
    const transcript = this.messages(chat);
    if (!transcript) return;
    const said = lastJobMessages(transcript).get(agent.sender);
    if (child?.repliedSinceTask === true || (said !== undefined && said.at >= end.startedAt)) return;
    const key = agent.link === "subagent" && agent.childId !== undefined ? agent.childId : "thread:" + threadId;
    try {
      if ((await this.source.memory.ends(chat))[key]?.at === end.at) return;
      const name = agent.sender || agent.name;
      await this.threads.prompt(chat, { message: JOB_NOTICE_PREFIX + jobEndText(name, end), images: [], mode: "steer" });
      await this.source.memory.told(chat, key, { at: end.at, cause: end.cause });
      this.log(`chat ${chat.slice(0, 8)}: job ${name} ended (${end.cause}) with no report; told the chat`);
      if (child) this.noticedEnd.set(child.id, { end: child.lastActivityAt ?? end.at });
    } catch (error) {
      this.log(`chat ${chat.slice(0, 8)}: job end note for ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** After each attach: steering `all` again (runtime state), and the old daemon check-in heartbeat cleared, since the server tick replaced it. */
  private async attached(id: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      await this.threads.setSteeringMode(id, "all");
      if ((await this.threads.heartbeat(id))?.startsWith(OLD_CHECK_IN)) {
        await this.threads.clearHeartbeat(id);
        this.log(`chat ${id.slice(0, 8)}: cleared the old check-in heartbeat`);
      }
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reloads the chat when the build it last loaded is not the one on disk, or the owner asked to update every chat: now if it is idle, else once
   * its turn ends. The reload keeps the brief the chat pinned in its system prompt, so its cached prompt stays valid; a reload onto a changed
   * brief leaves one notice in the transcript with what changed. The model reads it on its next turn, whatever starts that turn, and it starts
   * no turn itself.
   */
  private async refreshExtension(id: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    const forced = this.forced.has(id);
    let action: "reload" | "wait" | null = null;
    try {
      action = reloadAction(await this.loads.get(id), this.build, this.threads.busy(id), forced);
      if (action === "wait") { this.reloadWaiting.add(id); return; }
      this.reloadWaiting.delete(id);
      if (!action) return;
      await this.threads.reload(id);
      const before = await this.loads.set(id, this.build, this.brief);
      this.log(`chat ${id.slice(0, 8)}: extension reloaded, build ${this.build}, brief ${this.brief.version}`);
      const note = before && briefNote(before, this.brief.lines);
      if (note) await this.threads.notice(id, note);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: reload: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!this.reloadWaiting.has(id)) this.forced.delete(id);
      if (action !== null || forced) this.briefChanged();
    }
  }

  /**
   * At a turn's end, and when an idle chat attaches: when the chat's last reply on an owner turn has reply-lint findings (`replyCheck`) and is
   * at most REPLY_CHECK_MAX_AGE_MS old, one `[reply check]` steer naming them, once per reply across restarts (`replyChecks`). Plain text is
   * not stopped before the owner reads it; this asks for a corrected short reply when it misled, and the model's view carries the findings into
   * the next owner message either way.
   */
  private async replyCheck(id: string): Promise<void> {
    await this.load();
    const messages = this.chatIds.has(id) ? this.messages(id) : undefined;
    const check = messages && replyCheck(messages);
    if (!check || this.now() - check.at > REPLY_CHECK_MAX_AGE_MS) return;
    try {
      if (!await this.source.replyChecks.claim(id, check.at)) return;
      await this.threads.prompt(id, { message: check.message, images: [], mode: "steer" });
    } catch (error) { this.log(`chat ${id.slice(0, 8)}: reply check: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * When a chat's direct subagent first shows up: its brief, the `prompt` the daemon stored at the spawn, is checked against the Jobs rule
   * (`briefCheck`) with the chat's owner messages, the owner message that started the spawning turn and the chat's previous spawn. On findings
   * the chat gets one `[brief check]` steer naming the job; the spawn is never held. Once per job across restarts (`briefChecks`); a job
   * spawned more than BRIEF_CHECK_MAX_AGE_MS before the server first reads it is left alone. A spawn record not written yet is read again
   * at the next children change.
   */
  private async briefCheck(chat: string, child: ChildAgent): Promise<void> {
    const record = this.source.briefChecks;
    if (!record || this.briefSeen.has(child.id)) return;
    await this.load();
    const messages = this.chatIds.has(chat) ? this.messages(chat) : undefined;
    if (!messages) return;
    try {
      const sessionFile = (await this.summary(chat))?.sessionFile;
      if (!sessionFile) return;
      const dir = artifactsDir(sessionFile);
      const spawn = await spawnRecord(join(dir, child.id));
      if (!spawn) return;
      this.briefSeen.add(child.id);
      this.spawnTimes.set(join(dir, child.id), spawn.createdAt);
      if (this.now() - spawn.createdAt > BRIEF_CHECK_MAX_AGE_MS) return;
      const findings = briefCheck({ brief: spawn.prompt, owner: ownerMessages(messages), turnOwner: turnOwnerAt(messages, spawn.createdAt),
        previousSpawnAt: await this.previousSpawn(dir, spawn.createdAt) });
      if (!findings.length || !await record.claim(child.id, spawn.createdAt)) return;
      await this.threads.prompt(chat, { message: briefCheckNote(childName(child), findings), images: [], mode: "steer" });
      this.log(`chat ${chat.slice(0, 8)}: brief check for job ${childName(child)}: ${findings.map(finding => finding.kind).join(", ")}`);
    } catch (error) { this.log(`chat ${chat.slice(0, 8)}: brief check: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The latest spawn of the chat before `at`, from the subagent folders in its artifacts folder; null when there is none. */
  private async previousSpawn(dir: string, at: number): Promise<number | null> {
    let previous: number | null = null;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const childDir = join(dir, entry.name);
      let created = this.spawnTimes.get(childDir);
      if (created === undefined) {
        created = (await spawnRecord(childDir))?.createdAt;
        if (created === undefined) continue;
        this.spawnTimes.set(childDir, created);
      }
      if (created < at && (previous === null || created > previous)) previous = created;
    }
    return previous;
  }

  /** The owner's Update all chats: every chat reloads onto the current extension and brief, an idle one now, a busy one at the end of its turn. */
  async updateAll(): Promise<number> {
    await this.load();
    for (const id of this.chatIds) { this.forced.add(id); this.queue(id, () => this.refreshExtension(id)); }
    this.briefChanged();
    return this.chatIds.size;
  }

  /** The sessions stream's brief field for every chat: the version it last loaded, the current one, and whether a reload is due or under way. */
  async briefs(): Promise<ReadonlyMap<string, ChatBriefState>> {
    await this.load();
    const loaded = await this.loads.briefs();
    return new Map([...this.chatIds].map(id => [id, { version: loaded[id] ?? null, current: this.brief.version, updating: this.forced.has(id) || this.reloadWaiting.has(id) }]));
  }

  close(): void { clearInterval(this.timer); this.unobserve(); }
}
