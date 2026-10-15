import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBoard } from "../../src/shared/types.ts";

/** What `clean-room.ts setup` recorded about a run: the test chat, its fixture jobs, the seeds it sent, and when the measured window began. */
export interface RunState {
  scenario: string; chat: { id: string; name: string }; fixtures: Record<string, string>; sandbox: string; everyMs: number; release: string;
  board: string; seeds: string[]; setupAt: number; windowStart: number;
}
/** A clean-room scenario: how it seeds the test chat, and how it judges the evidence against the criteria written before the run. */
export interface Scenario {
  name: string;
  /** The AGENTS.md of a sandbox folder the chat works in; absent: the chat works in `--cwd` like a chat the owner opens there. */
  agentsMd?(sandbox: string): string;
  headMessage(chatName: string): string;
  fixtures: { name: string; brief(context: { chat: string; chatName: string; logFile: string; sandbox: string }): string }[];
  /** The board seeded from `--board`; absent: the chat makes its own board. */
  board?(copy: ChatBoard, context: { fixtures: Record<string, string>; sandbox: string }): { board: ChatBoard; changes: string[] };
  setupNotes(state: RunState, changes: readonly string[]): string;
  evaluate(run: string, state: RunState): { verdict: Verdict; text: string };
  baseline(before: string): { verdict: Verdict; text: string };
}
/** `open`: the run has not yet reached a state a criterion needs, so it runs more cycles before a verdict. */
export type Verdict = "pass" | "fail" | "void" | "open";

/** One thing a session saw or did, read from its session file. */
export type SessionEvent =
  | { kind: "text"; at: number; role: "user" | "custom"; customType?: string; from?: string; fromId?: string; relation?: string; text: string }
  | { kind: "assistant"; at: number; text: string }
  | { kind: "call"; at: number; tool: string; input: string }
  | { kind: "sent"; at: number; to: string; toName: string; text: string };

const SESSIONS = join(homedir(), ".prime/agent/sessions");
const ARTIFACTS = join(homedir(), ".prime/agent/session-artifacts");

const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";

/** The events of one session file, in order. A missing or unreadable file gives none. */
export function readSessionFile(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  const events: SessionEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (entry.type === "custom_message") {
      const details = (entry.details ?? {}) as { from?: { sessionId?: string; sessionName?: string }; fromRelationship?: string };
      events.push({ kind: "text", at, role: "custom", customType: String(entry.customType ?? ""), text: blockText(entry.content),
        ...(details.from?.sessionName ? { from: details.from.sessionName } : {}), ...(details.from?.sessionId ? { fromId: details.from.sessionId } : {}),
        ...(details.fromRelationship ? { relation: details.fromRelationship } : {}) });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = (entry.message ?? {}) as { role?: string; content?: unknown; details?: { sentAgentMessages?: { message?: string; target?: { sessionId?: string; sessionName?: string } }[] } };
    if (message.role === "user") events.push({ kind: "text", at, role: "user", text: blockText(message.content) });
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = blockText(message.content);
      if (text.trim()) events.push({ kind: "assistant", at, text });
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === "toolCall") events.push({ kind: "call", at, tool: String(block.name ?? ""), input: JSON.stringify(block.arguments ?? {}) });
      }
    }
    if (message.role === "toolResult") {
      for (const sent of message.details?.sentAgentMessages ?? []) {
        events.push({ kind: "sent", at, to: sent.target?.sessionId ?? "", toName: sent.target?.sessionName ?? "", text: sent.message ?? "" });
      }
    }
  }
  return events;
}

/** A root session's own file and every subagent file under its session-artifacts folder. */
export function sessionFiles(id: string): string[] {
  const files = [join(SESSIONS, `${id}.jsonl`)].filter(existsSync);
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl") && !name.startsWith(id)) files.push(path);
    }
  };
  walk(join(ARTIFACTS, id));
  return files;
}
export const readSession = (id: string): SessionEvent[] => readSessionFile(join(SESSIONS, `${id}.jsonl`));
