import type { ChatLine } from "../shared/chat-feed.ts";
import type { ChildAgent, ChildUsage, SessionRow, ThreadMessage } from "../shared/types.ts";
import { childName, createdSessions, isActiveChild, type CreatedSession } from "./children.ts";

/**
 * One job of an open chat, the shape the Jobs list, the plan chips, the drawer and the breadcrumb share: a subagent the daemon reports
 * (`rlm.spawn`) or a session the chat started (`rlm.create_session`). `name` is what the chat, the plan and agent-message headers call it.
 * `sessionId` is the thread to open; null for a subagent whose session the daemon has not listed yet.
 */
export type JobView =
  | { kind: "child"; key: string; name: string; child: ChildAgent; sessionId: string | null }
  | { kind: "session"; key: string; name: string; created: CreatedSession; row: SessionRow | undefined; sessionId: string };
export type JobReport = Extract<ChatLine, { kind: "job" }>;

export const isActiveJob = (job: JobView): boolean => job.kind === "child" ? isActiveChild(job.child) : job.row?.working === true;

/** Subagents first, then started sessions, in the order they were reported or started; active ones before the rest. */
export function jobViews(children: readonly ChildAgent[], started: readonly CreatedSession[], usage: readonly ChildUsage[], rowOf: (id: string) => SessionRow | undefined): JobView[] {
  const sessionOf = (child: ChildAgent): string | null =>
    usage.find(entry => entry.rlmChildId === child.id || (child.sessionName !== undefined && entry.sessionName === child.sessionName))?.sessionId ?? null;
  const all: JobView[] = [
    ...children.map(child => ({ kind: "child", key: "child:" + child.id, name: childName(child), child, sessionId: sessionOf(child) }) as const),
    ...started.map(created => ({ kind: "session", key: "session:" + created.sessionId, name: created.name || rowOf(created.sessionId)?.name || created.sessionId.slice(0, 8),
      created, row: rowOf(created.sessionId), sessionId: created.sessionId }) as const),
  ];
  return [...all.filter(isActiveJob), ...all.filter(job => !isActiveJob(job))];
}

/** The job name in an agent-message header: "child:ux-email" and "sibling:seo-todo" are the jobs "ux-email" and "seo-todo". */
export const jobName = (from: string): string => from.replace(/^(?:child|sibling|parent):/, "").trim();

/** The job called `name`, the latest one when the chat reused the name; also matches a job key or session id. */
export function findJob(jobs: readonly JobView[], name: string): JobView | undefined {
  const raw = name.trim();
  return jobs.find(job => job.key === raw || job.sessionId === raw) ?? jobs.findLast(job => job.name === jobName(raw));
}

/** Every message the job sent to the chat, newest first, from the chat's lines (`chatLines`; the feed folds them into updates). */
export function reportsFor(lines: readonly ChatLine[], name: string): JobReport[] {
  const wanted = jobName(name);
  return lines.filter((line): line is JobReport => line.kind === "job" && line.from === wanted).reverse();
}

const PY_STRING = /^(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/;
const PY_STRING_ANY = /(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const CALL = /\brlm(?:\.spawn|\.create_session)?\(/g;
const STARTS_JOB = /\brlm(?:\.spawn|\.create_session)?\(/;

/** The content of one Python string literal, with the common escapes resolved. A raw literal keeps its text as written. */
function literalText(literal: string): string {
  const prefix = /^[rbfuRBFU]{0,2}/.exec(literal)![0];
  const body = literal.slice(prefix.length);
  const inner = body.startsWith('"""') || body.startsWith("'''") ? body.slice(3, -3) : body.slice(1, -1);
  return /[rR]/.test(prefix) ? inner : inner.replace(/\\(n|t|"|'|\\)/g, (_, ch: string) => ch === "n" ? "\n" : ch === "t" ? "\t" : ch);
}

/** The string literal that starts at `index`, or null. */
function stringAt(text: string, index: number): string | null {
  PY_STRING_ANY.lastIndex = index;
  const match = PY_STRING_ANY.exec(text);
  return match && match.index === index ? match[0] : null;
}

/** The balanced text inside the parentheses that open at `open`, or null when the cell ends first. Strings are skipped whole. */
function argumentsAt(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    const literal = ch === '"' || ch === "'" ? stringAt(code, i) : null;
    if (literal) { i += literal.length - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { if (--depth === 0) return code.slice(open + 1, i); }
  }
  return null;
}

/** Top-level pieces of `text` split at `separator`, with strings and brackets kept whole. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const literal = ch === '"' || ch === "'" ? stringAt(text, i) : null;
    if (literal) { i += literal.length - 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A string expression as text: literals, `+` joins, and names assigned a literal earlier in the same cell. Null when nothing resolves. */
function resolveText(expression: string, code: string, depth = 0): string | null {
  const texts = splitTop(expression, "+").map(piece => piece.trim()).filter(Boolean).map(piece => {
    const literal = PY_STRING.exec(piece);
    if (literal && literal[0].length === piece.length) return literalText(piece);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(piece) || depth >= 3) return null;
    const assignment = new RegExp("(?:^|\\n)[ \\t]*" + piece + "[ \\t]*=[ \\t]*(?!=)").exec(code);
    if (!assignment) return null;
    const start = assignment.index + assignment[0].length;
    const value = stringAt(code, start) ?? code.slice(start, code.indexOf("\n", start) < 0 ? code.length : code.indexOf("\n", start));
    return resolveText(value.trim(), code, depth + 1);
  });
  const known = texts.filter((text): text is string => text !== null);
  return known.length ? known.join("") : null;
}

/**
 * The brief an `rlm.spawn(...)`, `rlm.create_session(...)` or `rlm(...)` call with `name=<name>` passed first, best effort: string literals,
 * `+` joins and names assigned a literal in the same cell resolve; other pieces are left out. Null when no call in the cell names the job.
 */
export function briefFromCode(code: string, name: string): string | null {
  for (const match of code.matchAll(CALL)) {
    const args = argumentsAt(code, match.index + match[0].length - 1);
    if (args === null) continue;
    const parts = splitTop(args, ",");
    const named = parts.some(part => { const keyword = /^\s*name\s*=\s*([\s\S]+)$/.exec(part); return keyword ? resolveText(keyword[1]!.trim(), code) === name : false; });
    if (!named || !parts[0]?.trim()) continue;
    const keyword = /^\s*(?:brief|task|prompt|message)\s*=\s*([\s\S]+)$/.exec(parts[0]);
    return resolveText((keyword ? keyword[1]! : parts[0]).trim(), code);
  }
  return null;
}

/** An ipython call in the chat that may start a job: its code names a call, or it is `truncated` (only the head is here; `api/threads/:id/tool-output` has the whole cell). */
export interface SpawnCall { toolCallId: string; code: string; truncated: boolean }
export function spawnCalls(messages: readonly ThreadMessage[]): SpawnCall[] {
  const calls: SpawnCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || typeof part.arguments.code !== "string") continue;
      const truncated = part.truncated === true;
      if (truncated || STARTS_JOB.test(part.arguments.code)) calls.push({ toolCallId: part.id, code: part.arguments.code, truncated });
    }
  }
  return calls;
}

/** The brief of the job called `name`, from the chat's whole ipython calls; the last call that names it wins. Truncated calls need `spawnCalls` and the full cell. */
export function briefFor(messages: readonly ThreadMessage[], name: string): string | null {
  let found: string | null = null;
  for (const call of spawnCalls(messages)) {
    if (call.truncated) continue;
    const brief = briefFromCode(call.code, name);
    if (brief !== null) found = brief;
  }
  return found;
}

/** One line of a chat's job tree in the sidebar. `at` is its last activity in ms (0 when unknown); `open` is what `store.openJob` takes for it. */
export interface TreeJob { key: string; name: string; running: boolean; saved: boolean; failed: boolean; activity: string; at: number; open: string }
const atOf = (value: string | undefined): number => Date.parse(value ?? "") || 0;

/**
 * A chat's jobs for the sidebar tree, running first: the subagent sessions its row carries, then the sessions it started with
 * `rlm.create_session` when the chat's transcript is loaded in this tab (`messages`), each read from its own catalog row.
 */
export function treeJobs(chat: SessionRow, messages: readonly ThreadMessage[] | undefined, rowOf: (id: string) => SessionRow | undefined): TreeJob[] {
  const jobs: TreeJob[] = (chat.jobs ?? []).map(job => ({ key: "job:" + job.id, name: job.name, running: job.status === "running", saved: job.status === "saved",
    failed: job.failed === true, activity: job.activity ?? "", at: atOf(job.lastActivityAt), open: job.name }));
  for (const created of createdSessions(messages ?? [])) {
    const row = rowOf(created.sessionId);
    jobs.push({ key: "session:" + created.sessionId, name: row?.name || created.name || created.sessionId.slice(0, 8), running: row?.working === true,
      saved: row?.kind === "saved", failed: !row?.working && Boolean(row?.failure), activity: row?.working ? row.statusLabel ?? "" : row?.failure ?? "",
      at: atOf(row?.lastActivityAt ?? row?.created), open: "session:" + created.sessionId });
  }
  return [...jobs.filter(job => job.running), ...jobs.filter(job => !job.running)];
}

/** The chat a session is a job of, for the breadcrumb on its thread: a chat row that lists it, or an open chat whose transcript started it. */
export function parentChatOf(sessionId: string, rows: readonly SessionRow[], messagesOf: (chat: string) => readonly ThreadMessage[] | undefined): { chat: SessionRow; open: string } | null {
  for (const row of rows) {
    if (!row.chat) continue;
    const job = row.jobs?.find(entry => entry.id === sessionId);
    if (job) return { chat: row, open: job.name };
    if (createdSessions(messagesOf(row.id) ?? []).some(created => created.sessionId === sessionId)) return { chat: row, open: "session:" + sessionId };
  }
  return null;
}
