import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { IdIndex } from "./id-index.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { checkInDigest, checkInDue, checkInMessage, CHECK_IN_MS, childName, endedWithoutReport, jobFacts, type CheckInRecord } from "./chat-checkin.ts";
import { CHECK_IN_PREFIX, JOB_NOTICE_PREFIX, TELL_OWNER_LIMIT, TELL_OWNER_TOOL } from "./shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, SessionRow, ThinkingLevel } from "./shared/types.ts";

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
/** Shell commands a chat may run: prime-agent (stop, send) and quick read-only look-ups. Each entry matches as a whole word at the start. */
const ALLOWED_SHELL = ["prime-agent", "git log", "git status", "git diff", "git show", "rg", "ls", "cat", "head", "tail", "wc"];
const SHELL_LIST = "prime-agent, git log/status/diff/show, rg, ls, cat, head, tail, wc";

/** The brief, as promptGuidelines bullets. It reaches every turn kind, including agent-message wakes and check-ins, through the base system prompt. */
export const CHAT_BRIEF: readonly string[] = [
  "This session is a chat. The owner is the CTO; you are the VP for this thread's topic. Your one goal is to drive every board item to done. " +
    "Every open step names its owner (a job, or another thread as `thread:<id>` or its session name) and its next action; otherwise mark it " +
    "blocked with the exact thing that unblocks it. A step that waits on someone else is still yours to chase. Before you mark a step done, check " +
    "the real state (the commit, the live service, the report), never an old note. Plan it, staff it with jobs, and bring the owner only what needs them.",
  "Voice: the owner's language, short. Owner replies: one to three sentences, 15 to 60 words, lead with the answer. Markdown renders in the chat: use a short list, " +
    "inline code or a link when it makes the reply easier to scan; no headings, no tables unless asked, no em dashes. Long detail (findings, " +
    "options, file paths) goes to scratchpad bullets with links. You can show images (`![alt](path or URL)`, local paths work) and ```mermaid " +
    "diagrams; put one on its own block when it is the point of the reply (it shows as a separate card under your message), keep it inline " +
    "when it is a small aside.",
  "Quiet: you talk to the owner when the owner writes. On any other wake-up (a job report, another thread, a check-in) say nothing unless a goal " +
    "finished, something failed or is blocked, or you need a decision; then call tell_owner once with one or two sentences. Several updates in a " +
    "row get one tell_owner at the end, not one each. Never narrate relays ('I passed X to Y'). Message another thread only when it must act, and " +
    "tell it no reply is needed unless it needs something.",
  "Do yourself only quick read-only look-ups that answer the owner in about a minute: read a file, `rg`, `git log/status/diff/show`, open a screenshot " +
    "with `attach_image`, read a job's report or wiki page, `await agent_observe.recent_messages(name)`. Any real task, read-only or not " +
    "(research, an audit, implementation, checks, browser work), goes to a job.",
  "Jobs: `handle = await rlm.spawn(brief, name=...)` runs in this repository with its rules; `await rlm.create_session(brief, name=..., cwd=...)` for another " +
    "repository. Every brief starts with `Owner's words (verbatim):` quoting each owner message that led to the job exactly, then `My read:` with your " +
    "interpretation marked as yours, then the task, then the reply instruction: `await agent_message.send(report, receiver_role=\"parent\")` for a child, " +
    "`receiver_role=\"sibling\", receiver_name=<your session name>` for a create_session root (`current.sessionName` from `await agent_observe.list_agents()`). " +
    "When the owner adds or changes something, forward their exact words to the job with `await agent_message.send(words, receiver_role=\"child\", receiver_name=<job>)`.",
  "Board: keep it current with the `chat_board` tool; the owner sees it next to the chat. The plan is a nested checklist: top items are goals, children " +
    "are steps, each job linked by name. Update the board in the same turn you start or finish a job. A user message that starts with `[board] ` is " +
    "the owner acting on the board (choosing or answering a todo, adding a note); act on it.",
  "Board shape: every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build, " +
    "Verify. Each step carries its real status, including blocked steps nobody works on yet, so the owner sees the whole path. Link a job on the step " +
    "it does, not on the goal. Example: goal `Reach chats from a messenger (Slack first)` has Plan (doing, job messenger-bridge-research), Decide " +
    "(blocked), Build (blocked), Verify (todo). A step's `job` is its owner: a job name, or another thread as `thread:<id>` or its session name.",
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
    "alone is not progress. Make the board match reality (statuses, notes with links), send a job only its own plan item, not the whole board, and " +
    "stay quiet unless a goal finished, something is blocked, or you need a decision (one tell_owner). `[job] <name> ended with no report` means " +
    "that job stopped without reporting: read its last messages (`await agent_observe.recent_messages(name)`) and act on what it did.",
  "Corrections stick: when the owner corrects how you work (board shape, tone, what to report), apply it now and make it hold for every future chat. " +
    "If the brief or code must change, send the owner's exact words to the thread named `realtime layer` with `await agent_message.send(..., " +
    "receiver_role=\"sibling\", receiver_name=\"realtime layer\")`; if a note is enough, record it with `await refine.run()`. The owner should never " +
    "have to give the same correction twice.",
  `Shell: only \`bash()\` commands that start with ${SHELL_LIST}, with no pipes, redirects or chaining. No edit(), no write-mode open(), no git writes.`,
];

/** A chat with no name from the owner gets one, so a create_session root can reply to it by name. */
export function chatName(): string { return `chat-${randomBytes(2).toString("hex")}`; }

export function hasChatMarker(entries: ReadonlyArray<{ type: string; customType?: string }>): boolean {
  return entries.some(entry => entry.type === "custom" && entry.customType === CHAT_MODE_ENTRY);
}

/** Whether a session file carries the chat_mode entry. The entry is written at the first session_start, so the scan stops near the head. */
export async function fileHasChatMarker(sessionFile: string): Promise<boolean> {
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
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
    "Send at most one progress message before that.";
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

const CREATE_SESSION = /\brlm\.create_session\s*\(/g;
const blankStrings = (code: string): string => code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), text => " ".repeat(text.length));
/** The session names an ipython cell gives `rlm.create_session(..., name="...")` as plain string literals; a computed name is not found. */
export function createSessionNames(code: string): string[] {
  const blanked = blankStrings(code);
  const names: string[] = [];
  CREATE_SESSION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_SESSION.exec(blanked)) !== null) {
    const args = argumentText(code, match.index + match[0].length - 1);
    const keyword = /\bname\s*=/.exec(blankStrings(args));
    if (!keyword) continue;
    PY_STRING.lastIndex = 0;
    const rest = args.slice(keyword.index + keyword[0].length).trimStart();
    const literal = PY_STRING.exec(rest);
    if (!literal || literal.index !== 0 || (/^[rbuRBU]*[fF]/.test(literal[0]) && literal[0].includes("{"))) continue;
    const name = unquote(literal[0]).trim();
    if (name) names.push(name);
  }
  return names;
}

/** Which chat started a root by name. The chat's extension writes it when a cell calls rlm.create_session; the root's extension reads it at start. */
export interface JobRegistry {
  add(names: readonly string[], chat: string): Promise<void>;
  chatOf(name: string): Promise<string | undefined>;
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
  };
}

/** The source files a chat session runs as its extension. A change in any of them is a new build; a chat that loaded an older one is reloaded. */
const BUILD_FILES = ["../extension/index.ts", "chats.ts", "shared/chat-board.ts", "shared/chat-feed.ts"];
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
  /** Sends text as a steer: it joins the running turn or starts one. */
  prompt(id: string, input: { message: string; images: []; mode: "steer" }): Promise<void>;
  /** Whether the thread is mid-turn. */
  busy(id: string): boolean;
  /** Re-runs the session's extensions, so it gets the current tools and brief. */
  reload(id: string): Promise<void>;
  /** `live` fires after each attach with the children known then; `children` on every change while attached; `idle` at each turn's end. */
  observe(observer: { live(id: string, children: readonly ChildAgent[]): void; children(id: string, children: readonly ChildAgent[]): void; idle(id: string): void }): () => void;
}
export type ChatSummary = (id: string) => Promise<{ lifecycle?: string; sessionFile?: string } | undefined>;

/** What the check-in tick reads besides the children: the board, the catalog rows (threads a plan item links), and its memory per chat. */
export interface CheckInSource {
  board(id: string): Promise<ChatBoard | null>;
  rows(): Promise<readonly SessionRow[]>;
  memory: CheckInRecord;
  /** The tick period; 0 starts no timer (tests call `checkIn`). Default CHECK_IN_MS. */
  everyMs?: number;
  now?: () => number;
}

/**
 * Chats on the server: the index, residency (pinned, so they stay attached and resident), steering mode `all` after every attach (it is runtime
 * state), the check-in tick, the no-report notice, and the extension build: a chat that last loaded an older build than the one on disk is
 * reloaded when it attaches, at once if idle, else at the end of its turn. Everything converges from the index plus the daemon list, so a restart
 * re-adopts what it finds.
 */
export class Chats {
  private readonly chatIds = new Set<string>();
  /** The children last seen per thread: the tick reads them, and each change is compared with them to find a job that ended with no report. */
  private readonly children = new Map<string, readonly ChildAgent[]>();
  /** Chats found stale while mid-turn; the end of the turn reloads them. */
  private readonly reloadWaiting = new Set<string>();
  private readonly syncing = new Map<string, Promise<void>>();
  private loaded: Promise<void> | undefined;
  private readonly unobserve: () => void;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  /**
   * `index` is `<data dir>/chats.json`: the session ids that are chats, newest first. The chat side's one definition of "chat"; the session entry
   * is the agent side's. `build` is the extension build on disk (`extensionBuild()`), `loads` the one each chat last loaded.
   */
  constructor(readonly index: IdIndex, private readonly threads: ChatThreads, private readonly summary: ChatSummary, private readonly build: string,
    private readonly loads: LoadRecord, private readonly source: CheckInSource, private readonly log: (line: string) => void = () => {}) {
    this.now = source.now ?? Date.now;
    this.unobserve = threads.observe({
      live: (id, children) => { this.children.set(id, children); this.queue(id, () => this.attached(id)); this.queue(id, () => this.refreshExtension(id)); },
      children: (id, children) => {
        const before = this.children.get(id);
        this.children.set(id, children);
        if (before) for (const child of endedWithoutReport(before, children)) this.queue(id, () => this.noReport(id, childName(child)));
      },
      idle: id => { if (this.reloadWaiting.has(id)) this.queue(id, () => this.refreshExtension(id)); },
    });
    const every = source.everyMs ?? CHECK_IN_MS;
    if (every > 0) {
      this.timer = setInterval(() => { void this.load().then(() => { for (const id of this.chatIds) this.queue(id, async () => { await this.checkIn(id); }); }); }, every);
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
  async adopt(): Promise<{ pinned: string[]; forgotten: string[] }> {
    await this.load();
    const pinned: string[] = [];
    const forgotten: string[] = [];
    for (const id of await this.index.ids()) {
      const summary = await this.summary(id).then(summary => summary ?? "missing", () => "unknown" as const);
      if (summary === "missing" || (summary !== "unknown" && summary.lifecycle === "archived")) { await this.forget(id); forgotten.push(id); continue; }
      if (this.threads.pin(id)) pinned.push(id);
      else this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    }
    return { pinned, forgotten };
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
  }

  /**
   * One check-in tick for a chat: nothing while it has no job at work and no open plan step; else the digest against the last tick, kept as the new
   * memory, and a `[check-in]` steer only when a line needs the chat, with every open plan item listed under the lines. Returns the lines sent.
   */
  async checkIn(id: string): Promise<string[]> {
    await this.load();
    if (!this.chatIds.has(id)) return [];
    try {
      const board = await this.source.board(id);
      const facts = jobFacts(this.children.get(id) ?? [], board, await this.source.rows());
      if (!checkInDue(facts, board)) return [];
      const { memory, lines, open } = checkInDigest(await this.source.memory.get(id), facts, board, this.now());
      await this.source.memory.set(id, memory);
      if (lines.length) await this.threads.prompt(id, { message: checkInMessage(CHECK_IN_PREFIX, lines, open), images: [], mode: "steer" });
      return lines;
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: check-in: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async noReport(id: string, name: string): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try { await this.threads.prompt(id, { message: `${JOB_NOTICE_PREFIX}${name} ended with no report`, images: [], mode: "steer" }); }
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
