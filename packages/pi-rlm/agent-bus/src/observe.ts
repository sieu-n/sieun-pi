/**
 * The kernel's `agent_observe.*`: the family roster with live status, one member's summary, and bounded message previews.
 * Rows follow Prime's shapes, so `agent_observe.list_agents()` callers in sieun-pi read the same fields.
 */

import { readFileSync } from "node:fs";
import { buildSessionContext, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as registry from "@sieun-pi/pi-family/registry";
import { family, type Member, type Relationship } from "./family.ts";
import { allMembers, memberOf, type Known } from "./members.ts";
import { repliedSinceTask, state } from "./state.ts";

export const LATEST_CHARS = 240;
export const FIRST_CHARS = 120;

export interface Preview {
  index: number;
  role: string;
  timestamp?: number;
  text: string;
  truncated: boolean;
  toolCalls?: string[];
  customType?: string;
}

export interface AgentRow {
  activeSessionId?: string;
  sessionId: string;
  sessionName: string;
  runtimeKind: "top-level" | "subagent";
  cwd?: string;
  status: "running" | "idle" | "inactive";
  activity?: string;
  isCurrent: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  attachedClients: number;
  messageCount?: number;
  queuedCount: number;
  isSessionActive: boolean;
  parentActiveSessionId?: string;
  parentSessionId?: string;
  firstMessage?: string;
  latestMessage?: Preview;
  relationship?: Relationship;
  repliedSinceTask?: boolean;
  /** The box that holds a root reached through its prime-relay. */
  host?: string;
  crossHost?: true;
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Prime's preview text (`PZs`): message text, a bash command with its output, or a summary. */
export function messageText(message: AgentMessage): string {
  const m = message as unknown as Record<string, unknown>;
  switch (m.role) {
    case "bashExecution":
      return [m.command, m.output].filter(Boolean).join("\n");
    case "compactionSummary":
    case "branchSummary":
      return String(m.summary ?? "");
    default:
      return partsText(m.content);
  }
}

export function preview(message: AgentMessage, index: number, maxChars: number): Preview {
  const m = message as unknown as Record<string, unknown>;
  const text = messageText(message);
  const toolCalls =
    m.role === "assistant" && Array.isArray(m.content)
      ? (m.content as { type?: string; name?: string }[]).filter(p => p.type === "toolCall").map(p => String(p.name))
      : [];
  return {
    index,
    role: String(m.role),
    ...(typeof m.timestamp === "number" ? { timestamp: m.timestamp } : {}),
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(m.role === "custom" ? { customType: String(m.customType) } : {}),
  };
}

function firstMessage(messages: AgentMessage[]): string | undefined {
  for (const message of messages) {
    const m = message as unknown as Record<string, unknown>;
    let text: string | undefined;
    if (m.role === "user") text = messageText(message);
    else if (m.role === "custom" && m.customType === "agent_message") {
      const details = m.details as { message?: unknown } | undefined;
      text = typeof details?.message === "string" ? details.message : messageText(message);
      text = text.replace(/^\[task from parent\]\s*/, "");
    }
    if (text === undefined) continue;
    const flat = text.trim();
    return flat.length > FIRST_CHARS ? `${flat.slice(0, FIRST_CHARS - 3).trimEnd()}...` : flat;
  }
  return undefined;
}

function contextOf(entries: SessionEntry[], leafId?: string | null): AgentMessage[] {
  return buildSessionContext(entries, leafId).messages;
}

/** The context messages of a member: from the live session manager, or read from the session file without opening the session. */
export function messagesOf(known: Known): AgentMessage[] {
  if (known.kind === "live") {
    const live = state().live.get(known.member.id);
    if (live) return contextOf(live.sessionManager.getEntries(), live.sessionManager.getLeafId());
    return known.entry.preview(50).map(p => ({ role: p.role, content: p.text, timestamp: p.timestamp }) as unknown as AgentMessage);
  }
  if (known.kind === "remote" && known.root.box) return [];
  const file = known.kind === "dormant" ? known.row.sessionFile : known.root.sessionFile;
  if (!file) return [];
  try {
    const entries = parseSessionEntries(readFileSync(file, "utf8")).filter(e => e.type !== "session") as SessionEntry[];
    return contextOf(entries);
  } catch {
    return [];
  }
}

function row(known: Known, isCurrent: boolean, rel?: Relationship): AgentRow {
  const m: Member = known.member;
  const base = {
    sessionId: m.id,
    sessionName: m.name,
    runtimeKind: m.role === "child" ? ("subagent" as const) : ("top-level" as const),
    isCurrent,
    isCompacting: false,
    attachedClients: 0,
    ...(m.parentId ? { parentActiveSessionId: m.parentId, parentSessionId: m.parentId } : {}),
    ...(rel ? { relationship: rel } : {}),
    ...(rel === "child" ? { repliedSinceTask: repliedSinceTask(m.id) } : {}),
  };
  if (known.kind === "live") {
    const live = state().live.get(m.id);
    const messages = messagesOf(known);
    const activity = live?.activity() ?? (known.entry.activity() === "working" ? "model" : "idle");
    const last = messages.length - 1;
    return {
      activeSessionId: m.id,
      ...base,
      cwd: known.entry.cwd,
      status: activity === "idle" ? "idle" : "running",
      activity,
      isStreaming: activity !== "idle",
      messageCount: messages.length,
      queuedCount: live?.pending.size ?? 0,
      isSessionActive: true,
      ...(firstMessage(messages) ? { firstMessage: firstMessage(messages) } : {}),
      ...(last >= 0 ? { latestMessage: preview(messages[last], last, LATEST_CHARS) } : {}),
    };
  }
  if (known.kind === "remote") {
    return {
      ...base, cwd: known.root.cwd, status: known.root.rosterStatus, isStreaming: known.root.rosterStatus === "running", queuedCount: 0,
      isSessionActive: known.root.rosterStatus !== "inactive", ...(known.root.box ? { host: known.root.box, crossHost: true as const } : {}),
    };
  }
  const first = known.row.firstMessage ?? firstMessage(messagesOf(known));
  return { ...base, cwd: known.row.cwd, status: "inactive", isStreaming: false, queuedCount: 0, isSessionActive: false, ...(first ? { firstMessage: first } : {}) };
}

function selfKnown(sessionId: string): Known {
  const entry = registry.get(sessionId);
  if (!entry) throw new Error("agent observation is not available in this session");
  return { kind: "live", member: memberOf(entry), entry };
}

export async function listAgents(sessionId: string): Promise<{ current: AgentRow; agents: AgentRow[] }> {
  const self = selfKnown(sessionId);
  const members = family(self.member, await allMembers());
  return { current: row(self, true), agents: members.map(m => row(m.item, false, m.relationship)) };
}

/** Resolves a target like Prime's live-session selectors: an id, a name, or an unambiguous id suffix, within the family or self. */
async function resolve(sessionId: string, target: string): Promise<{ known: Known; rel?: Relationship; isCurrent: boolean }> {
  const self = selfKnown(sessionId);
  const wanted = target.trim();
  if (wanted === sessionId || wanted === self.member.name) return { known: self, isCurrent: true };
  const members = family(self.member, await allMembers());
  const exact = members.filter(m => m.item.member.id === wanted || m.item.member.name === wanted);
  const hits = exact.length > 0 ? exact : members.filter(m => wanted.length >= 4 && m.item.member.id.endsWith(wanted));
  if (hits.length === 1) return { known: hits[0].item, rel: hits[0].relationship, isCurrent: false };
  if (hits.length > 1) throw new Error(`agent selector ${JSON.stringify(target)} is ambiguous`);
  const anywhere = registry.get(wanted) ?? registry.dormantOf(wanted);
  if (anywhere) throw new Error("Agent reach is limited to parent, siblings, and children");
  throw new Error(`No agent matches ${JSON.stringify(target)}`);
}

export async function getAgent(sessionId: string, target: string): Promise<{ agent: AgentRow }> {
  const { known, rel, isCurrent } = await resolve(sessionId, target);
  return { agent: row(known, isCurrent, rel) };
}

function bounded(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return n;
}

export async function recentMessages(
  sessionId: string,
  input: { target: string; limit?: unknown; max_chars?: unknown },
): Promise<{ agent: AgentRow; messages: Preview[]; limit: number; maxChars: number; truncated: boolean }> {
  const limit = bounded(input.limit, 8, 1, 50, "agent_observe limit");
  const maxChars = bounded(input.max_chars, 800, 80, 2000, "agent_observe max_chars");
  const { known, rel, isCurrent } = await resolve(sessionId, input.target);
  const messages = messagesOf(known);
  const start = Math.max(0, messages.length - limit);
  return {
    agent: row(known, isCurrent, rel),
    messages: messages.slice(start).map((m, i) => preview(m, start + i, maxChars)),
    limit,
    maxChars,
    truncated: start > 0,
  };
}
