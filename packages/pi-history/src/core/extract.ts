import { basename } from "node:path";

export type Kind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "agent_message" | "notice" | "summary";

export interface Doc {
  kind: Kind;
  tool?: string;
  toolCallId?: string;
  isError: boolean;
  /** null means the session itself wrote it, so the indexer fills in the session's name. */
  author: string | null;
  text: string;
}

export interface SessionHeader {
  id?: string;
  cwd?: string;
  created?: number;
  parentSession?: string;
}

export interface Extracted {
  entry?: string;
  at?: number;
  docs: Doc[];
  name?: string;
  header?: SessionHeader;
}

export const TRANSCRIPT = /^(?:[^_/]+_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Custom messages that repeat harness or kernel state and carry no conversation (extract.py BOILERPLATE). */
export const BOILERPLATE = new Set([
  "harness_digest",
  "ipython_state",
  "ipython_state_restored",
  "refinement_notice",
  "refinement_outcome",
  "prime-agent.update_restart",
  "prime-agent.worker_recovery",
  "session_slash_command_result",
  "compaction_outcome",
]);

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function sessionOfPath(path: string): string | undefined {
  return TRANSCRIPT.exec(basename(path))?.[1];
}

function textParts(content: unknown, kind: "text" | "thinking" = "text"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) if (isObject(p) && p.type === kind) parts.push(String(p[kind] ?? ""));
  return parts.join("\n");
}

function timeOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

const AGENT_FROM = /^\[agent-message from ([^\]\n]+)\]/;

function agentAuthor(text: string): string {
  if (text.startsWith("[task from parent]")) return "parent";
  return AGENT_FROM.exec(text)?.[1]?.trim() || "agent";
}

function toolCallText(args: unknown): string {
  let value = args;
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) value = value[keys[0]!];
  }
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

function messageDocs(m: Json): Doc[] {
  const role = m.role;
  const content = m.content;
  if (role === "user") {
    const text = textParts(content);
    return text ? [{ kind: "user", isError: false, author: "owner", text }] : [];
  }
  if (role === "assistant") {
    const docs: Doc[] = [];
    const text = textParts(content);
    if (text) docs.push({ kind: "assistant", isError: false, author: null, text });
    const thinking = textParts(content, "thinking");
    if (thinking) docs.push({ kind: "thinking", isError: false, author: null, text: thinking });
    if (Array.isArray(content)) {
      for (const p of content) {
        if (!isObject(p) || p.type !== "toolCall") continue;
        docs.push({ kind: "tool_call", tool: String(p.name ?? ""), toolCallId: str(p.id), isError: false, author: null, text: toolCallText(p.arguments) });
      }
    }
    return docs;
  }
  if (role === "toolResult") {
    const text = textParts(content);
    if (!text) return [];
    return [{ kind: "tool_result", tool: String(m.toolName ?? ""), toolCallId: str(m.toolCallId), isError: m.isError === true, author: null, text }];
  }
  if (role === "bashExecution") {
    const text = `${String(m.command ?? "")}\n${String(m.output ?? "")}`;
    return [{ kind: "tool_result", tool: "bash", isError: typeof m.exitCode === "number" && m.exitCode !== 0, author: null, text }];
  }
  return [];
}

/** Turns one parsed transcript line into search docs plus the session facts it carries. */
export function extract(e: unknown): Extracted {
  if (!isObject(e)) return { docs: [] };
  const out: Extracted = { entry: str(e.id), at: timeOf(e.timestamp), docs: [] };
  const t = e.type;
  if (t === "message" && isObject(e.message)) {
    out.at ??= timeOf(e.message.timestamp);
    out.docs = messageDocs(e.message);
  } else if (t === "custom_message") {
    const ct = String(e.customType ?? "");
    const text = typeof e.content === "string" ? e.content : textParts(e.content);
    if (text && ct === "agent_message") out.docs = [{ kind: "agent_message", isError: false, author: agentAuthor(text), text }];
    else if (text && !BOILERPLATE.has(ct)) out.docs = [{ kind: "notice", tool: ct, isError: false, author: "system", text }];
  } else if (t === "compaction" || t === "branch_summary") {
    const text = str(e.summary);
    if (text) out.docs = [{ kind: "summary", isError: false, author: "system", text }];
  } else if (t === "session_info") {
    out.name = str(e.name);
  } else if (t === "session") {
    out.header = { id: str(e.id), cwd: str(e.cwd), created: timeOf(e.timestamp), parentSession: str(e.parentSession) };
  }
  return out;
}
