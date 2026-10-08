import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { IdIndex } from "./id-index.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { activePause, changeCheckIn, CHECK_IN_MERGE_MS, type CheckInChange, checkInDigest, checkInDue, checkInMessage, type CheckInRecord, type CheckInSetting, type CheckInSettings, childName, childWorking, DEFAULT_CHECK_IN,
  endedWithoutReport, jobFacts, jobReport, lastJobMessages, nextCheckIn, retryDue } from "./chat-checkin.ts";
import { type ClaudeState, claudeDown, type FallbackRecord, fallbackModel, revivalMessage, type Stall, stallAction, strandedInput, switchBack, switchedBackNotice,
  switchedNotice, turnStall, turnViewOf } from "./chat-fallback.ts";
import { CHECK_IN_PREFIX, JOB_NOTICE_PREFIX, TELL_OWNER_LIMIT, TELL_OWNER_TOOL, turnStarter } from "./shared/chat-feed.ts";
import type { ChatBoard, ChatWait, CheckInState, CheckInView, ChildAgent, ModelCatalog, ModelInfo, QueueState, RetryState, SessionRow, ThinkingLevel, ThreadMessage } from "./shared/types.ts";

export { TELL_OWNER_LIMIT, TELL_OWNER_TOOL };

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
/** The prompt of the daemon heartbeat that did the check-in before the server tick; an attach clears a heartbeat whose prompt starts with it. */
export const OLD_CHECK_IN = "Check-in. Read the board";
/** A job quiet this long with no report is told to the chat; shorter gaps are a job between tool calls or one that a reply woke again. */
export const NO_REPORT_GRACE_MS = 90_000;
/** Two ends of one job whose last activity is this close are one end: told once. */
export const NO_REPORT_SAME_END_MS = 60_000;
/** Shell commands a chat may run: prime-agent (stop, send) and quick read-only look-ups. Each entry matches as a whole word at the start. */
const ALLOWED_SHELL = ["prime-agent", "git log", "git status", "git diff", "git show", "rg", "ls", "cat", "head", "tail", "wc"];
const SHELL_LIST = "prime-agent, git log/status/diff/show, rg, ls, cat, head, tail, wc";

/** The brief, as promptGuidelines bullets. It reaches every turn kind, including agent-message wakes and check-ins, through the base system prompt. */
export const CHAT_BRIEF: readonly string[] = [
  "This session is a chat. The owner is the CTO; you are the VP for this thread's topic. Your one goal is to drive every board item to done. " +
    "Every open step names its owner (a job, or another thread as `thread:<id>` or its session name) and its next action; otherwise mark it " +
    "blocked with the exact thing that unblocks it. A step that waits on someone else is still yours to chase. Before you mark a step done, check " +
    "the real state (the commit, the live service, the report), never an old note. Plan it, staff it with jobs, and bring the owner only what needs them.",
  "Call a feature live only for what you saw on the real screen, and say what you checked.",
  "Voice: the owner's language, short. Owner replies: at most 60 words including bullets; a status answer is one line per goal. Lead with the answer. Markdown renders in the chat: use a short list, " +
    "inline code or a link when it makes the reply easier to scan; no headings, no tables unless asked, no em dashes. " +
    "Write like a text message from a coworker: short, casual, a few lines, spoken style, no report formatting. Never open with a label or a colon lead-in (Live now:, Fixed X:, Update:, Done:); just say it in a normal sentence. Commit hashes are fine. Write so the message reads straight through as plain text: no board ids, commit hashes, model ids or internal names inside sentences, no parenthetical asides, plain words over internal names; at most one board id per message, at the end, only when it helps (the page turns it into a link). Long detail (findings, options, file paths) goes to scratchpad bullets with links. You can show images (`![alt](path or URL)`, local paths work) and ```mermaid " +
    "diagrams; put one on its own block when it is the point of the reply (it shows as a separate card under your message), keep it inline " +
    "when it is a small aside. Board notes, todos and replies are plain sentences a person reads once. No all-caps labels (SECURITY:, URGENT:), no slash-joined names, no repo jargon (origin/main, xoxb, HEAD) when a plain word works. Say what it is and what happens next.",
  "Quiet: you talk to the owner when the owner writes. On any wake-up that is not an owner message, end the turn with no text. If a goal " +
    "finished, something is blocked or you need a decision, call tell_owner once and then end with no text. Never write 'nothing needs you', " +
    "'already handled', or a relay line. Several updates in a row get one tell_owner at the end, not one each. Message another thread only when " +
    "it must act, and tell it no reply is needed unless it needs something.",
  "Do yourself only quick read-only look-ups that answer the owner in about a minute: read a file, `rg`, `git log/status/diff/show`, open a screenshot " +
    "with `attach_image`, read a job's report or wiki page, `await agent_observe.recent_messages(name)`. Any real task, read-only or not " +
    "(research, an audit, implementation, checks, browser work), goes to a job.",
  "Name every job and thread you start like the owner names threads: a few plain lowercase words with spaces naming the topic (stripe and payments, " +
    "realtime layer, crawler ops, readme check). No kebab-case, no ids, no numbered suffixes like -2.",
  "Jobs: `handle = await rlm.spawn(brief, name=...)` runs in this repository with its rules; `await rlm.create_session(brief, name=..., cwd=...)` for another " +
    "repository. Every brief starts with `Owner's words (verbatim):` quoting each owner message that led to the job exactly, then `My read:` with your " +
    "interpretation marked as yours, then the task, then the reply instruction: `await agent_message.send(report, receiver_role=\"parent\")` for a child, " +
    "`receiver_role=\"sibling\", receiver_name=<your session name>` for a create_session root (`current.sessionName` from `await agent_observe.list_agents()`). " +
    "When the owner adds or changes something, forward their exact words to the job with `await agent_message.send(words, receiver_role=\"child\", receiver_name=<job>)`. " +
    "Everything you send another agent (briefs, relays, answers) is in English: after the owner's exact words, say in plain English what they mean and what to do, " +
    "and translate any Korean.",
  "Board: keep it current with the `chat_board` tool; the owner sees it next to the chat. The plan is a nested checklist: top items are goals, children " +
    "are steps, each job linked by name. Update the board in the same turn you start or finish a job. A user message that starts with `[board] ` is " +
    "the owner acting on the board (choosing or answering a todo, adding a note); act on it.",
  "Board shape: every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build, " +
    "Verify. Each step carries its real status, including blocked steps nobody works on yet, so the owner sees the whole path. Link a job on the step " +
    "it does, not on the goal. Example: goal `Reach chats from a messenger (Slack first)` has Plan (doing, job messenger-bridge-research), Decide " +
    "(blocked), Build (blocked), Verify (todo). A step's `job` is its owner: a job name, or another thread as `thread:<id>` or its session name. " +
    "A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal.",
  "The scratchpad is a short bullet list: one finding or decision per bullet, with links to what it is about (`job:<name>` for a job's report, " +
    "`thread:<id>`, `wiki:<path>`, `file:<path>`, or a URL). No long prose.",
  "You are the VP: decide everything you can yourself. Ask the owner only for what a VP cannot decide: product direction, money, irreversible or " +
    "external actions (deploys, sends, deletes), credentials and logins. Doc wording, small fixes, detail level and code choices are yours: decide, act, " +
    "and note the decision in the scratchpad. Keep at most 3 open owner todos; each is one short question with 2 to 4 `choices`, your recommendation " +
    "first. Before adding one, ask yourself whether the CTO would be annoyed to be asked; if so, decide. An ask is an owner todo plus one short line in chat.",
  "Start every job at once, reply in one short message, and end the turn. Never wait inside a turn: job reports and check-ins wake you later.",
  "A `[check-in]` message lists what changed, then every open step with its owner and the time since its last change. On a `[check-in]`, act on " +
    "every open step, not only the one that changed: start what can start, re-brief, replace or unblock a stuck owner, do or assign the commit, " +
    "restart or check a step waits on, and if a step truly waits on the owner make sure exactly one owner todo exists for it. Watching and reporting " +
    "alone is not progress. A stuck owner gets at most one message. If it has not moved by the next check-in, or its last turn ended in an error, " +
    "replace it with a job in that check-in. A takeover you promised for the next check-in is due at that check-in: do it, do not restate it. " +
    "Never ask the owner to relay a message to another thread. Make the board match reality (statuses, notes with links), send a job only its own plan item, not the whole board, and " +
    "stay quiet unless a goal finished, something is blocked, or you need a decision (one tell_owner). `[job] <name> ended with no report` means " +
    "that job stopped without reporting: read its last messages (`await agent_observe.recent_messages(name)`) and act on what it did. " +
    "A check-in line `<step> (job <name>) waits: \"...\"` means the job waits on you or on something you can get it (a slot, a go, an answer): " +
    "answer it or get it, do not replace it. Never start a second job on a step whose job " +
    "may still run: `rlm.list_subagents()` can say completed for a job a reply woke again, so check its activity first.",
  "Never wait on the owner for a choice you can make yourself; a step you own moves every check-in or you start a job for it.",
  "If the owner says talk first, reply with your proposal and the default you start at the next check-in unless they object; at that check-in, start it.",
  "When a plan step waits on the owner's choice or action, add one short owner todo in For you at once, with 2 to 4 choices and your recommendation first, " +
    "instead of leaving the step blocked with a note.",
  "Corrections stick: when the owner corrects how you work (board shape, tone, what to report), apply it now and make it hold for every future chat. " +
    "A correction changes the brief or a skill, never only a local note: send the owner's exact words to the thread named `realtime layer` with `await agent_message.send(..., " +
    "receiver_role=\"sibling\", receiver_name=\"realtime layer\")` for a brief or code change, or call `await refine.run()` aimed at a global skill or prompt entry. " +
    "A local memory alone does not count. The owner should never have to give the same correction twice.",
  `Shell: only \`bash()\` commands that start with ${SHELL_LIST}, with no pipes, redirects or chaining. No edit(), no write-mode open(), no git writes.`,
];

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

/** What `tell_owner` answers: the text reaches the owner as a bubble, or it is refused as too long (the feed shows a refused call as nothing). */
export function tellOwner(text: unknown): { ok: true; text: string } | { ok: false; text: string } {
  const told = typeof text === "string" ? text.trim() : "";
  if (!told) return { ok: false, text: "nothing to tell: give text" };
  if (told.length > TELL_OWNER_LIMIT) return { ok: false, text: TELL_OWNER_TOO_LONG };
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
  return `You are a job of the chat${job.chat ? ` ${job.chat}` : ""}. When you are done, failed or blocked, send it one report with \`${send}\`. ` +
    "Send at most one progress message before that. Write the report for a reader: lead with the answer, use ## headers for its parts, a table for numbers, " +
    "and a ```mermaid diagram when there is a flow or structure. If you also wrote a wiki page, link it; the chat shows it next to your report.";
}

/**
 * The poteto-agent persona every job of a chat works in (owner, 10-08: "i want poteto-mode on by default"): the poteto-agent skill's own rule,
 * pointing at the installed poteto-mode skill. Null when that skill is not installed, so a profile without it gets nothing.
 */
export function jobPersonaGuideline(potetoModeSkill: string, exists: (path: string) => boolean = existsSync): string | null {
  if (!exists(potetoModeSkill)) return null;
  return `Work in poteto-mode: read ${potetoModeSkill} in full before your first step, including its Principles index, follow its playbooks, ` +
    "and open a leaf principle-* skill whenever you apply that principle.";
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
 * The chat's name when a session file carries the chat_mode entry, else null. The name is the last session_info before the entry: a chat is named at
 * create, before its first session_start writes the entry. The scan stops at the entry.
 */
export async function fileChatName(sessionFile: string): Promise<string | null> {
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  let name = "";
  try {
    for await (const line of lines) {
      if (line.startsWith('{"type":"session_info"')) {
        try { const entry = JSON.parse(line) as { name?: unknown }; if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim(); } catch { continue; }
      } else if (line.includes(`"customType":"${CHAT_MODE_ENTRY}"`)) {
        try { if (hasChatMarker([JSON.parse(line)])) return name; } catch { continue; }
      }
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

/** Which chat started a root by name. The chat's extension writes it when a cell calls rlm.create_session; the root's extension reads it at start. */
export interface JobRegistry {
  add(names: readonly string[], chat: string): Promise<void>;
  chatOf(name: string): Promise<string | undefined>;
  /** The session names a chat (by any of its names: its session name, its id) started. */
  rootsOf(chat: readonly string[]): Promise<string[]>;
}
const REGISTRY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** `<data dir>/chat-jobs.json`: `{ jobs: { [sessionName]: { chat, at } } }` through locked-json; entries older than 30 days go on the next add. */
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
  };
}

/** The source files a chat session runs as its extension. A change in any of them is a new build; a chat that loaded an older one is reloaded. */
const BUILD_FILES = ["../extension/index.ts", "chats.ts", "chat-agents.ts", "chat-checkin.ts", "shared/chat-board.ts", "shared/chat-feed.ts"];
/** A short hash of the extension sources on disk now. */
export function extensionBuild(dir: string = import.meta.dirname): string {
  const hash = createHash("sha256");
  for (const file of BUILD_FILES) hash.update(readFileSync(join(dir, file)));
  return hash.digest("hex").slice(0, 16);
}

/** What to do about a chat that last loaded `loaded` when the build on disk is `build`: reload it now, wait for its turn to end, or nothing. */
export function reloadAction(loaded: string | undefined, build: string, busy: boolean): "reload" | "wait" | null {
  if (loaded === build) return null;
  return busy ? "wait" : "reload";
}

/** The build each chat last loaded, by session id. */
export interface LoadRecord {
  get(id: string): Promise<string | undefined>;
  set(id: string, build: string): Promise<void>;
  forget(id: string): Promise<void>;
}
/** `<data dir>/extension-loads.json`: `{ builds: { [sessionId]: build } }` through locked-json. */
export function loadRecord(path: string): LoadRecord {
  const file: JsonFile<{ builds: Record<string, string> }> = { path, label: "Extension load record", initial: () => ({ builds: {} }), parse(value: unknown) {
    const builds = typeof value === "object" && value !== null && "builds" in value && typeof value.builds === "object" && value.builds !== null ? value.builds : {};
    return { builds: Object.fromEntries(Object.entries(builds).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
  } };
  return {
    async get(id) { return (await snapshotJsonFile(file)).builds[id]; },
    async set(id, build) { await transactJsonFile(file, state => { state.builds[id] = build; }); },
    async forget(id) { await transactJsonFile(file, state => { delete state.builds[id]; }); },
  };
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
  /** The model catalog as the thread sees it (configured providers included). */
  models(id: string): Promise<ModelCatalog>;
  setModel(id: string, provider: string, modelId: string): Promise<void>;
  setThinking(id: string, level: string): Promise<void>;
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
  memory: CheckInRecord;
  settings: CheckInSettings;
  /** How often the scheduler wakes to run the chats whose interval has passed; 0 starts no timer (tests call `tick`). Default CHECK_IN_TICK_MS. */
  tickMs?: number;
  now?: () => number;
  /** How long a job must stay quiet before the no-report notice; default NO_REPORT_GRACE_MS. Tests pass 0. */
  noReportGraceMs?: number;
  /** The pool's answer about Claude (cached by the reader), null when the pool cannot be read; absent: no chat is ever switched to the fallback. */
  claude?: () => Promise<ClaudeState | null>;
  /** `<data dir>/chat-fallbacks.json`: the model each chat ran before the server switched it to the fallback. */
  fallbacks?: FallbackRecord;
}

/** The check-in scheduler wakes this often; each chat runs at its own interval, so an interval is kept to within this much. */
export const CHECK_IN_TICK_MS = 30_000;
/** How often the scheduler looks for chats the index lost, and how recent a thread must be to be looked at. */
export const ADOPT_SCAN_MS = 10 * 60_000;
export const ADOPT_RECENT_MS = 7 * 24 * 60 * 60_000;

/**
 * Chats on the server: the index, residency (pinned, so they stay attached and resident), steering mode `all` after every attach (it is runtime
 * state), the check-in scheduler (each chat at its own interval, none while the owner paused it, held while an owner turn runs), the restart of
 * a chat whose last turn failed, the no-report notice, and the extension build: a chat that last loaded an older build than the one on disk is
 * reloaded when it attaches, at once if idle, else at the end of its turn. Everything converges from the index plus the daemon list, so a restart
 * re-adopts what it finds, and a scan of the session files brings back a chat the index lost.
 */
export class Chats {
  private readonly chatIds = new Set<string>();
  /** The children last seen per thread: the tick reads them, and each change is compared with them to find a job that ended with no report. */
  private readonly children = new Map<string, readonly ChildAgent[]>();
  /** When each job was last seen starting to work, and the end (its last activity) last told to the chat as "ended with no report". */
  private readonly workingSince = new Map<string, number>();
  private readonly noticedEnd = new Map<string, number>();
  /** When the server last steered each chat with a `[check-in]` (a digest or a restart), and the chats whose check-in waits to join the next. */
  private readonly steeredAt = new Map<string, number>();
  private readonly mergeWaiting = new Set<string>();
  /** Chats found stale while mid-turn; the end of the turn reloads them. */
  private readonly reloadWaiting = new Set<string>();
  private readonly syncing = new Map<string, Promise<void>>();
  private loaded: Promise<void> | undefined;
  private readonly unobserve: () => void;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  /** When the scheduler last ran each chat's check-in; a chat it has not run yet counts from the service start, as the old single tick did. */
  private readonly lastCheckIn = new Map<string, number>();
  private readonly started: number;
  /** Restarts sent per chat since its last turn that ended well: how many, and when the last one went. */
  private readonly revivals = new Map<string, { attempts: number; at: number }>();
  /** When each chat's current stall was first seen, for a provider retry whose failed reply the hub does not hold. */
  private readonly stallSeen = new Map<string, number>();
  /** Wakes sent per stranded step-owner thread: how many, and when the last one went. */
  private readonly ownerWakes = new Map<string, { attempts: number; at: number }>();
  /** When the scheduler last looked for lost chats, and the threads with messages found plain (their head never changes). */
  private lastScan: number;
  private readonly plain = new Set<string>();

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
      live: (id, children) => { this.children.set(id, children); this.queue(id, () => this.attached(id)); this.queue(id, () => this.refreshExtension(id)); },
      children: (id, children) => {
        const before = this.children.get(id);
        this.children.set(id, children);
        for (const child of children) if (childWorking(child) && !before?.some(was => was.id === child.id && childWorking(was))) this.workingSince.set(child.id, this.now());
        if (before) for (const child of endedWithoutReport(before, children)) this.laterNoReport(id, child.id);
      },
      idle: id => { if (this.reloadWaiting.has(id)) this.queue(id, () => this.refreshExtension(id)); },
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

  private load(): Promise<void> {
    return this.loaded ??= this.index.ids().then(ids => { for (const id of ids) this.chatIds.add(id); });
  }

  async ids(): Promise<ReadonlySet<string>> { await this.load(); return this.chatIds; }

  async create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name?: string }): Promise<{ id: string; name: string }> {
    await this.load();
    const name = input.name?.trim() || chatName();
    const { id } = await this.threads.create({ cwd: input.cwd, ...(input.provider ? { provider: input.provider } : {}), ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}), name, kind: "chat" });
    await this.index.add(id);
    this.chatIds.add(id);
    if (!this.threads.pin(id)) this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    await this.threads.setSteeringMode(id, "all");
    await this.loads.set(id, this.build);
    return { id, name };
  }

  /**
   * At service start: pin every chat in the index, forget the ones the daemon lists as archived or not at all. With the daemon down the catalog
   * cannot answer, so the chat stays pinned and the pin resumes or drops it on the first catalog update. A pinned saved chat resumes the same way.
   */
  async adopt(): Promise<{ pinned: string[]; forgotten: string[]; adopted: string[] }> {
    await this.load();
    const pinned: string[] = [];
    const forgotten: string[] = [];
    for (const id of await this.index.ids()) {
      const summary = await this.summary(id).then(summary => summary ?? "missing", () => "unknown" as const);
      if (summary === "missing" || (summary !== "unknown" && summary.lifecycle === "archived")) {
        await this.forget(id);
        forgotten.push(id);
        this.log(`chat ${id.slice(0, 8)}: forgotten, ${summary === "missing" ? "the daemon does not list it" : "archived"}`);
        continue;
      }
      if (this.threads.pin(id)) pinned.push(id);
      else this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    }
    return { pinned, forgotten, adopted: await this.rescan() };
  }

  /**
   * Brings back chats the index lost (an unarchive outside this server, a lost index write): every recent unarchived thread whose session file
   * carries the chat_mode entry is restored and logged. A thread with messages found plain is not read again: the entry precedes the first message.
   */
  async rescan(): Promise<string[]> {
    await this.load();
    const now = this.now();
    let rows: readonly SessionRow[];
    try { rows = await this.source.rows(); }
    catch (error) { this.log(`chats: scan: ${error instanceof Error ? error.message : String(error)}`); return []; }
    const adopted: string[] = [];
    for (const row of rows) {
      if (this.chatIds.has(row.id) || this.plain.has(row.id) || row.archived) continue;
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
   */
  async restore(id: string): Promise<boolean> {
    await this.load();
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
    this.chatIds.delete(id);
    await this.index.forget(id);
    await this.loads.forget(id);
    await this.source.memory.forget(id);
    await this.source.fallbacks?.forget(id);
  }

  /** The owner's settings, or none when the file cannot be read (logged): every chat then runs at the default interval. */
  private async settings(): Promise<Record<string, CheckInSetting>> {
    try { return await this.source.settings.all(); }
    catch (error) { this.log(`check-in settings: ${error instanceof Error ? error.message : String(error)}`); return {}; }
  }

  /**
   * One scheduler wake: queues the check-in of every chat whose interval has passed since its last one, that is not paused and runs no owner
   * turn (a held check-in stays due, so it runs at the first wake after that turn). Every chat that is not paused is also checked for a failed
   * last turn (`revive`), and every ADOPT_SCAN_MS the session files are scanned for chats the index lost. Returns the ids checked in.
   */
  async tick(): Promise<string[]> {
    await this.load();
    const settings = await this.settings();
    const now = this.now();
    if (now - this.lastScan >= ADOPT_SCAN_MS) { this.lastScan = now; this.queue("#scan", async () => { await this.rescan(); }); }
    const due: string[] = [];
    for (const id of this.chatIds) {
      const setting = settings[id] ?? DEFAULT_CHECK_IN;
      if (activePause(setting, now) !== null) continue;
      this.queue(id, () => this.revive(id));
      const next = nextCheckIn(setting, this.lastCheckIn.get(id) ?? this.started, now);
      const merged = this.mergeWaiting.has(id) && now - (this.steeredAt.get(id) ?? 0) >= CHECK_IN_MERGE_MS;
      if ((!merged && (next === null || next > now)) || this.ownerTurn(id)) continue;
      due.push(id);
      this.lastCheckIn.set(id, now);
      this.queue(id, async () => { await this.checkIn(id); });
    }
    return due;
  }

  private messages(id: string): readonly ThreadMessage[] | undefined { return this.threads.state?.(id)?.messages; }

  /** Whether the chat is on a turn the owner started (a message or a board action); a check-in waits for it to end. */
  private ownerTurn(id: string): boolean {
    const messages = this.messages(id);
    return messages !== undefined && this.threads.running(id) && turnStarter(messages) === "owner";
  }

  /** The stall of a chat's last turn as the hub holds it: a failure with nothing running, or a provider retry holding the turn after one. */
  private stall(id: string): Stall | null {
    const state = this.threads.state?.(id);
    return state ? turnStall(turnViewOf(state, this.threads.running(id)), this.now()) : null;
  }

  private async claude(): Promise<ClaudeState | null> {
    return this.source.claude ? this.source.claude().catch(() => null) : null;
  }

  /**
   * A chat whose last turn failed (a 429, a connection error), or whose provider retry holds input queued behind it, gets a new turn: 5 min
   * after the failure, then 10, then every 20 while each new turn fails again; an owner turn first after 30 s, quoting the owner's message,
   * with the wait shown under it. When Claude cannot serve the chat, it moves to the fallback model and restarts at once. A turn that ends
   * well resets the count, clears the wait and, once Claude serves again, moves a switched chat back.
   */
  private async revive(id: string): Promise<void> {
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
      await this.switchBack(id);
      return;
    }
    const provider = state.info?.model?.provider ?? null;
    const claude = provider === "anthropic" ? await this.claude() : null;
    const down = claudeDown(stall.error, provider, claude);
    if (down && await this.switchToFallback(id, stall)) return;
    const seen = this.stallSeen.get(id) ?? now;
    this.stallSeen.set(id, seen);
    const last = this.revivals.get(id);
    const action = stallAction({ stall, down, claude, attempts: last?.attempts ?? 0, since: last?.at ?? Math.min(stall.at, seen), now });
    if (action.kind !== "restart") { this.threads.setWait(id, action.kind === "wait" ? action.wait : null); return; }
    const attempts = (last?.attempts ?? 0) + 1;
    this.revivals.set(id, { attempts, at: now });
    this.threads.setWait(id, null);
    try {
      await this.threads.restart(id, action.message, action.abort);
      this.steeredAt.set(id, now);
      this.log(`chat ${id.slice(0, 8)}: last turn failed (${stall.error}); started a new turn, try ${attempts}`);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: restart: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The thinking level a model switch should keep, set again when the new model supports it and the switch changed it. */
  private async keepThinking(id: string, level: ThinkingLevel | null): Promise<void> {
    const info = this.threads.state?.(id)?.info;
    if (!level || info?.thinkingLevel === level || !info?.availableThinkingLevels?.includes(level)) return;
    await this.threads.setThinking(id, level);
  }

  /**
   * Claude cannot serve the chat: record its model, move it to the fallback (keeping its thinking level), post one notice line, and restart
   * the turn now. False when there is no fallback (no record, no Codex model) or the switch failed; the usual restart schedule then runs.
   */
  private async switchToFallback(id: string, stall: Stall): Promise<boolean> {
    const fallbacks = this.source.fallbacks;
    const info = this.threads.state?.(id)?.info;
    const model = info?.model;
    if (!fallbacks || !model) return false;
    const level = info.thinkingLevel ?? null;
    try {
      const to = fallbackModel(await this.threads.models(id));
      if (!to) {
        if (!this.stallSeen.has(id)) this.log(`chat ${id.slice(0, 8)}: Claude cannot serve (${stall.error}) and no Codex model is configured`);
        return false;
      }
      await fallbacks.set(id, { original: { provider: model.provider, id: model.id, thinkingLevel: level }, fallback: { provider: to.provider, id: to.id }, at: this.now() });
      if (stall.retrying) await this.threads.abort(id);
      await this.threads.setModel(id, to.provider, to.id);
      await this.keepThinking(id, level);
      await this.threads.notice(id, switchedNotice(to.name));
      this.threads.setWait(id, null);
      this.revivals.set(id, { attempts: 1, at: this.now() });
      await this.threads.restart(id, revivalMessage(stall.error, stall.owner));
      this.steeredAt.set(id, this.now());
      this.log(`chat ${id.slice(0, 8)}: Claude cannot serve (${stall.error}); switched ${model.provider}/${model.id} to ${to.provider}/${to.id} and started a new turn`);
      return true;
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: switch to the fallback: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Between turns, a chat on the fallback goes back to its model once Claude serves again; a chat the owner moved off the fallback keeps its model. */
  private async switchBack(id: string): Promise<void> {
    const fallbacks = this.source.fallbacks;
    const info = this.threads.state?.(id)?.info;
    if (!fallbacks || !info?.model) return;
    try {
      const entry = await fallbacks.get(id);
      if (!entry) return;
      const busy = this.threads.busy(id);
      const decision = switchBack(entry, info.model, busy, busy ? null : await this.claude());
      if (decision === "keep") return;
      if (decision === "back") {
        const { provider, id: modelId, thinkingLevel } = entry.original;
        const name = (await this.threads.models(id)).models.find(model => model.provider === provider && model.id === modelId)?.name ?? modelId;
        await this.threads.setModel(id, provider, modelId);
        await this.keepThinking(id, thinkingLevel);
        await this.threads.notice(id, switchedBackNotice(name));
        this.log(`chat ${id.slice(0, 8)}: Claude serves again; switched back to ${provider}/${modelId}`);
      }
      await fallbacks.forget(id);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: switch back: ${error instanceof Error ? error.message : String(error)}`);
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
          await this.threads.restart(id, revivalMessage(stall.error, stall.owner), stall.retrying);
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
    return { everyMs: setting.everyMs, paused: pausedUntil !== null, nextAt: nextCheckIn(setting, lastAt ?? this.started, now), pausedUntil, lastAt };
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

  /** The owner's change to a chat's check-in; null for a thread that is not a chat. The scheduler reads the new setting at its next wake. */
  async setCheckIn(id: string, change: CheckInChange): Promise<CheckInView | null> {
    await this.load();
    if (!this.chatIds.has(id)) return null;
    const now = this.now();
    const setting = await this.source.settings.update(id, current => {
      const result = changeCheckIn(current, change, now, "owner");
      return "setting" in result ? result.setting : current;
    });
    return this.state(id, setting, now);
  }

  /**
   * One check-in tick for a chat: nothing while an owner turn runs or its last turn failed (the restart covers that; the memory stays, so the
   * changes are told after it), and nothing while it has no job at work, no open plan step, no board read error and no ask overflow; else the
   * digest against the last tick, kept as the new memory, and a `[check-in]` steer only when a line needs the chat, with every open leaf step
   * listed under the lines. Returns the lines sent.
   */
  async checkIn(id: string): Promise<string[]> {
    await this.load();
    if (!this.chatIds.has(id) || this.ownerTurn(id) || this.stall(id)) return [];
    if (this.now() - (this.steeredAt.get(id) ?? -Infinity) < CHECK_IN_MERGE_MS) { this.mergeWaiting.add(id); return []; }
    this.mergeWaiting.delete(id);
    try {
      let board: ChatBoard | null = null;
      let boardError: string | undefined;
      try { board = await this.source.board(id); }
      catch (error) { boardError = error instanceof Error ? error.message : String(error); this.log(`chat ${id.slice(0, 8)}: check-in board: ${boardError}`); }
      const rows = await this.source.rows();
      const said = lastJobMessages(this.messages(id) ?? []);
      const facts = jobFacts(this.children.get(id) ?? [], board, rows, id).map(fact => {
        const lastMessage = fact.key.startsWith("thread:") ? undefined : said.get(fact.name);
        const wokeAt = this.workingSince.get(fact.key);
        return { ...fact, ...(lastMessage ? { lastMessage } : {}), ...(wokeAt !== undefined ? { wokeAt } : {}) };
      });
      for (const fact of facts) if (fact.state === "failed" && fact.key.startsWith("thread:")) this.queue(fact.key, () => this.wakeOwner(fact.key.slice("thread:".length)));
      if (!checkInDue(facts, board, boardError)) return [];
      const name = rows.find(row => row.id === id)?.name;
      const { memory, lines, open } = checkInDigest(await this.source.memory.get(id), facts, board, this.now(),
        { self: name ? [id, name] : [id], ...(boardError !== undefined ? { boardError } : {}) });
      await this.source.memory.set(id, memory);
      if (lines.length) {
        await this.threads.prompt(id, { message: checkInMessage(CHECK_IN_PREFIX, lines, open), images: [], mode: "steer" });
        this.steeredAt.set(id, this.now());
      }
      return lines;
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: check-in: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
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
    if (jobReport({ replied: false, ...(lastMessage ? { lastMessage } : {}), wokeAt: this.workingSince.get(child.id) ?? 0 }).reported) return;
    const end = child.lastActivityAt ?? this.now();
    const told = this.noticedEnd.get(child.id);
    if (told !== undefined && Math.abs(end - told) < NO_REPORT_SAME_END_MS) return;
    this.noticedEnd.set(child.id, end);
    if (this.stall(id)) { this.log(`chat ${id.slice(0, 8)}: no notice for ${childName(child)}: the chat's last turn failed; the check-in after its restart tells it`); return; }
    try { await this.threads.prompt(id, { message: `${JOB_NOTICE_PREFIX}${childName(child)} ended with no report`, images: [], mode: "steer" }); }
    catch (error) { this.log(`chat ${id.slice(0, 8)}: no-report notice: ${error instanceof Error ? error.message : String(error)}`); }
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

  /** Reloads the chat when the build it last loaded is not the one on disk: now if it is idle, else once its turn ends. */
  private async refreshExtension(id: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      const action = reloadAction(await this.loads.get(id), this.build, this.threads.busy(id));
      if (action === "wait") { this.reloadWaiting.add(id); return; }
      this.reloadWaiting.delete(id);
      if (!action) return;
      await this.threads.reload(id);
      await this.loads.set(id, this.build);
      this.log(`chat ${id.slice(0, 8)}: extension reloaded, build ${this.build}`);
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: reload: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void { clearInterval(this.timer); this.unobserve(); }
}
