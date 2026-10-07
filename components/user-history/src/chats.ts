import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { IdIndex } from "./id-index.ts";
import type { ChildAgent, ThinkingLevel } from "./shared/types.ts";

/** The extension flag the chat server sets on `create`. The extension turns it into the session entry at the first session_start. */
export const CHAT_FLAG = "chat";
/** The session entry that defines "this session is a chat". Children get their own session files, so it never reaches them. */
export const CHAT_MODE_ENTRY = "chat_mode";
/** The board tool. Its promptGuidelines carry the brief, so it is active only in a marked root. */
export const CHAT_BOARD_TOOL = "chat_board";
export const CHECK_IN_SCHEDULE = "every 10m";
export const CHECK_IN = "Check-in. Read the board (chat_board with no ops) and what each job is doing (rlm.list_subagents, rlm.collect, agent_observe.recent_messages). " +
  "Update the board, re-brief or stop anything stuck. Reply to the owner only if there is something to report, ask, or decide; otherwise end the turn with no text.";
/** Shell commands a chat may run: prime-agent (stop, send) and quick read-only look-ups. Each entry matches as a whole word at the start. */
const ALLOWED_SHELL = ["prime-agent", "git log", "git status", "git diff", "git show", "rg", "ls", "cat", "head", "tail", "wc"];
const SHELL_LIST = "prime-agent, git log/status/diff/show, rg, ls, cat, head, tail, wc";

/** The brief, as promptGuidelines bullets. It reaches every turn kind, including agent-message wakes and check-ins, through the base system prompt. */
export const CHAT_BRIEF: readonly string[] = [
  "This session is a chat. The owner is the CTO; you are the VP for this thread's topic. You own the outcome: plan it, staff it with jobs, " +
    "keep the board current, and bring the owner only what needs them.",
  "Voice: the owner's language, one to four short sentences, plain words, no em dashes, no headings, lists, bold, tables or code unless asked. " +
    "This holds on every turn, most of all when a job report arrives: say the one or two things that matter in plain sentences and put the detail " +
    "(findings, decisions, file paths) in scratchpad bullets with links, never as a list in chat. Lines that start with `-` or `1.` are a list.",
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
  "The scratchpad is a short bullet list: one finding or decision per bullet, with links to what it is about (`job:<name>` for a job's report, " +
    "`thread:<id>`, `wiki:<path>`, `file:<path>`, or a URL). No long prose.",
  "You are the VP: decide everything you can yourself. Ask the owner only for what a VP cannot decide: product direction, money, irreversible or " +
    "external actions (deploys, sends, deletes), credentials and logins. Doc wording, small fixes, detail level and code choices are yours: decide, act, " +
    "and note the decision in the scratchpad. Keep at most 3 open owner todos; each is one short question with 2 to 4 `choices`, your recommendation " +
    "first. Before adding one, ask yourself whether the CTO would be annoyed to be asked; if so, decide. An ask is an owner todo plus one short line in chat.",
  "Start every job at once, reply in one short message, and end the turn. Never wait inside a turn: job reports and check-ins wake you later. " +
    "On a check-in, read the board and the jobs (`await rlm.list_subagents()`, `await rlm.collect(...)`, `await agent_observe.recent_messages(name)`), " +
    "update statuses, re-brief or stop what is stuck, and reply only if the owner needs to know or decide; otherwise end the turn with no text.",
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

/** The active tool list with the brief tool added or removed; null when it is already right. Extension tools start active in every session. */
export function withChatTool(active: readonly string[], on: boolean): string[] | null {
  const has = active.includes(CHAT_BOARD_TOOL);
  if (has === on) return null;
  return on ? [...active, CHAT_BOARD_TOOL] : active.filter(name => name !== CHAT_BOARD_TOOL);
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

/** The check-in heartbeat runs only while a job runs under the chat. */
export function checkInWanted(children: readonly ChildAgent[]): boolean {
  return children.some(child => child.status === "running" || child.status === "queued");
}
export type CheckInState = "active" | "paused";
/** The heartbeat update that takes `current` (undefined: not known since the last attach) to `wanted`; null when it is there already. */
export function checkInAction(current: CheckInState | undefined, wanted: boolean): "pause" | "resume" | null {
  const target: CheckInState = wanted ? "active" : "paused";
  if (current === target) return null;
  return wanted ? "resume" : "pause";
}

/** What chats need from the thread hub. ThreadHub satisfies it; tests pass a fake. */
export interface ChatThreads {
  create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name: string; kind: "chat" }): Promise<{ id: string }>;
  /** False when the live limit is reached; the chat then lives like any thread until one is archived. */
  pin(id: string): boolean;
  unpin(id: string): void;
  setSteeringMode(id: string, mode: "all" | "one-at-a-time"): Promise<void>;
  setHeartbeat(id: string, schedule: string, instruction: string, deliveryMode: "steer" | "follow_up"): Promise<void>;
  updateHeartbeat(id: string, action: "pause" | "resume"): Promise<void>;
  /** `live` fires after each attach with the children known then; `children` on every change while attached. */
  observe(observer: { live(id: string, children: readonly ChildAgent[]): void; children(id: string, children: readonly ChildAgent[]): void }): () => void;
}
export type ChatSummary = (id: string) => Promise<{ lifecycle?: string; sessionFile?: string } | undefined>;

/**
 * Chats on the server: the index, residency (pinned, so they stay attached and resident), steering mode `all` after every attach (it is runtime
 * state), and the check-in heartbeat, paused while no job runs. Everything converges from the index plus the daemon list, so a restart re-adopts
 * what it finds.
 */
export class Chats {
  private readonly checkIn = new Map<string, CheckInState>();
  private readonly chatIds = new Set<string>();
  /** The children last seen per thread; a sync reads these, not its trigger's, so the newest state wins when syncs queue up. */
  private readonly children = new Map<string, readonly ChildAgent[]>();
  private readonly syncing = new Map<string, Promise<void>>();
  private loaded: Promise<void> | undefined;
  private readonly unobserve: () => void;

  /** `index` is `<data dir>/chats.json`: the session ids that are chats, newest first. The chat side's one definition of "chat"; the session entry is the agent side's. */
  constructor(readonly index: IdIndex, private readonly threads: ChatThreads, private readonly summary: ChatSummary, private readonly log: (line: string) => void = () => {}) {
    this.unobserve = threads.observe({
      live: (id, children) => { this.checkIn.delete(id); this.children.set(id, children); this.queueSync(id, true); },
      children: (id, children) => { this.children.set(id, children); this.queueSync(id, false); },
    });
  }

  /** Syncs of one thread run one after another; `settled` resolves once the queue is empty, for tests. */
  private queueSync(id: string, attached: boolean): void {
    const next = (this.syncing.get(id) ?? Promise.resolve()).then(() => this.sync(id, attached));
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
    await this.threads.setHeartbeat(id, CHECK_IN_SCHEDULE, CHECK_IN, "follow_up");
    await this.threads.updateHeartbeat(id, "pause");
    this.checkIn.set(id, "paused");
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
   * After an unarchive: a session whose file carries the chat_mode entry is a chat again, back in the index, pinned, with steering `all` and its
   * check-in set, then paused or resumed by whether a job runs. False for a plain thread. Steering and the check-in resume the session; a failure
   * there is logged, since the pin resumes it again and the attach re-applies steering.
   */
  async restore(id: string): Promise<boolean> {
    await this.load();
    const sessionFile = (await this.summary(id))?.sessionFile;
    if (!sessionFile || !(await fileHasChatMarker(sessionFile))) return false;
    await this.index.add(id);
    this.chatIds.add(id);
    if (!this.threads.pin(id)) this.log(`chat ${id.slice(0, 8)}: live limit reached, not pinned`);
    try {
      await this.threads.setSteeringMode(id, "all");
      await this.threads.setHeartbeat(id, CHECK_IN_SCHEDULE, CHECK_IN, "follow_up");
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The heartbeat state is unknown now; the sync pauses or resumes it from the children last seen.
    this.checkIn.delete(id);
    this.queueSync(id, false);
    return true;
  }

  async forget(id: string): Promise<void> {
    this.threads.unpin(id);
    this.checkIn.delete(id);
    this.children.delete(id);
    this.chatIds.delete(id);
    await this.index.forget(id);
  }

  private async sync(id: string, attached: boolean): Promise<void> {
    await this.load();
    if (!this.chatIds.has(id)) return;
    try {
      if (attached) await this.threads.setSteeringMode(id, "all");
      const action = checkInAction(this.checkIn.get(id), checkInWanted(this.children.get(id) ?? []));
      if (!action) return;
      await this.threads.updateHeartbeat(id, action);
      this.checkIn.set(id, action === "pause" ? "paused" : "active");
    } catch (error) {
      this.log(`chat ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void { this.unobserve(); }
}
