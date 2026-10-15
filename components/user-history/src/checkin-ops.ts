import type { SessionEntry } from "prime-agent";
import { CHAT_BOARD_TOOL } from "./chat-guard.ts";
import { readBranchTail } from "./session-tail.ts";
import { OPS_STEER_PREFIX } from "./shared/chat-feed.ts";
import type { ChatBoard, PlanItem } from "./shared/types.ts";

/**
 * The board ops a duty job (a check-in, CI system) sends its chat, and whether the chat applied them. A duty job is a root session and has no
 * board tool, so its ops reach the board only when the chat calls chat_board. VP of CI 10-13: the check-ins at 21:15Z (22 ops) and 21:48Z (6 ops)
 * each got a turn with no chat_board call (a tell_owner and prose, then prose only), so p21, p85 and p89 kept their old waits and the precheck
 * flagged them stale four check-ins in a row.
 */

/** A transcript message, as the session file holds it or the hub projects it: only the fields read here. */
export interface Said { role: string; customType?: string; content?: unknown; stopReason?: string; toolCallId?: string; isError?: boolean; timestamp?: number;
  /** A tool result's details as the session file holds them, such as `sentAgentMessages`; the hub drops them. */
  details?: unknown }
type Op = Record<string, unknown> & { op: string };
/**
 * One duty job report with board ops: who sent it and when, its ops by key (the step or todo id, or the op's name for one with no id, such as
 * plan_set), the keys a chat_board call the board took touched while the report was open, whether the turn that read it ended, and whether the
 * server's `[board]` line asked for the rest. The steer's own turn reopens the report, so `applied` also holds what the chat did after the ask.
 */
export interface OpsReport { from: string; at: number; ops: Map<string, Op>; applied: Set<string>; ended: boolean; asked: boolean }

/** A duty job's agent-message header: a root session (no `child:`) named like `check-in VP of CI 06 12` or `ci system VP of CI 10-13 05 00`. */
const DUTY_HEADER = /^\s*\[agent-message from\s+(?!child:|sibling:|parent:)([^\]]*?\s(?:\d\d-\d\d\s)?\d\d[ :]\d\d)\]/;
const ENDS_TURN = new Set(["stop", "length"]);

export const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("") : "";
const isOp = (value: unknown): value is Op => typeof value === "object" && value !== null && typeof (value as { op?: unknown }).op === "string";
const keyOf = (op: Op): string => typeof op.id === "string" ? op.id : op.op;

/** The ops on a report's own lines: each line that is a JSON op, or a JSON list of ops. */
function opLines(body: string): Op[] {
  return body.split("\n").map(line => line.trim()).filter(line => line.startsWith("{") || line.startsWith("[")).flatMap(line => {
    try { const value: unknown = JSON.parse(line); return (Array.isArray(value) ? value : [value]).filter(isOp); } catch { return []; }
  });
}

/** The keys a chat_board call's ops touch; a plan_set rewrites the plan, so it touches every key. */
function touched(args: unknown): Set<string> | "all" {
  const raw = typeof args === "object" && args !== null ? (args as { ops?: unknown }).ops : undefined;
  const ops = (Array.isArray(raw) ? raw : []).filter(isOp);
  return ops.some(op => op.op === "plan_set") ? "all" : new Set(ops.map(keyOf));
}

/** Reads a chat's transcript in order into its duty reports with board ops (`reports`). */
export class OpsReader {
  readonly reports: OpsReport[] = [];
  private readonly calls = new Map<string, Set<string> | "all">();

  read(message: Said): void {
    const open = this.reports.filter(report => !report.ended);
    if (message.role === "custom" && message.customType === "agent_message") {
      const text = textOf(message.content);
      const from = DUTY_HEADER.exec(text)?.[1]!.trim();
      const ops = from ? opLines(text) : [];
      if (from && ops.length) this.reports.push({ from, at: message.timestamp ?? 0, ops: new Map(ops.map(op => [keyOf(op), op])), applied: new Set(), ended: false, asked: false });
    } else if (message.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (call.type === "toolCall" && call.name === CHAT_BOARD_TOOL && typeof call.id === "string") this.calls.set(call.id, touched(call.arguments));
      }
      if (ENDS_TURN.has(message.stopReason ?? "")) for (const report of open) report.ended = true;
    } else if (message.role === "toolResult" && message.toolCallId !== undefined) {
      const keys = this.calls.get(message.toolCallId);
      this.calls.delete(message.toolCallId);
      if (keys && !message.isError) for (const report of open) for (const key of keys === "all" ? report.ops.keys() : keys) report.applied.add(key);
    } else if (message.role === "user") {
      const text = textOf(message.content).trim();
      const report = text.startsWith(OPS_STEER_PREFIX) ? this.reports.findLast(candidate => text.includes(` from ${candidate.from} `)) : undefined;
      if (report && !report.asked) { report.asked = true; report.ended = false; }
    }
  }
}

/** The ops of a report its chat did not apply: no chat_board call the board took touched their keys. */
export const unapplied = (report: OpsReport): string[] => [...report.ops.keys()].filter(key => !report.applied.has(key));

/** The plan item with `id` and the id of its parent (null at the top), or undefined. */
function located(plan: readonly PlanItem[], id: string, parent: string | null = null): { item: PlanItem; parent: string | null } | undefined {
  for (const item of plan) {
    if (item.id === id) return { item, parent };
    const found = located(item.children, id, item.id);
    if (found) return found;
  }
  return undefined;
}
const same = (key: string, held: unknown, sent: unknown): boolean =>
  sent === null ? held === undefined : key === "waitUntil" && typeof held === "string" && typeof sent === "string" ? Date.parse(held) === Date.parse(sent)
    : JSON.stringify(held) === JSON.stringify(sent);
/** The board already holds the op: a removed step is gone, and an updated one has every field the op sets, however it got there. */
export function onBoard(op: Op, board: ChatBoard | null): boolean {
  if (!board || typeof op.id !== "string") return false;
  const found = located(board.plan, op.id);
  if (op.op === "plan_remove") return !found;
  if (op.op !== "plan_update" || !found) return false;
  return Object.entries(op).every(([key, sent]) => key === "op" || key === "id" ||
    (key === "parent" ? found.parent === sent : same(key, (found.item as unknown as Record<string, unknown>)[key], sent)));
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";
/** The `[board]` line for a report's ops the board does not hold. */
export const opsSteerLine = (report: OpsReport, left: readonly string[]): string =>
  `${OPS_STEER_PREFIX}${left.length} of ${report.ops.size} from ${report.from} at ${clock(report.at)} (${left.join(", ")}); apply them or write why in each step's note.`;

/**
 * What the server sends a chat for its newest duty report with board ops: undefined while the turn that read it runs (or there is none to judge
 * yet), null when there is nothing to say (the chat touched every op, the board holds the rest, or the line was sent), else the `[board]` line.
 * Older reports are left alone: each check-in sends again the ops it still needs. The line is in the transcript, so a restart never sends it twice.
 */
export function opsSteer(messages: Iterable<Said>, board: ChatBoard | null): string | null | undefined {
  const reader = new OpsReader();
  for (const message of messages) reader.read(message);
  const report = reader.reports.at(-1);
  if (!report || report.asked) return report && null;
  if (!report.ended) return undefined;
  const left = unapplied(report).filter(key => !onBoard(report.ops.get(key)!, board));
  return left.length ? opsSteerLine(report, left) : null;
}

/** The time of a chat's newest duty report with an op line, from the hub's messages (custom text is clipped there, so this only finds it). */
export function newestReportAt(messages: readonly Said[]): number | undefined {
  const report = messages.findLast(message => message.role === "custom" && message.customType === "agent_message" &&
    DUTY_HEADER.test(textOf(message.content)) && /"op"\s*:/.test(textOf(message.content)));
  return report?.timestamp;
}

/** The transcript messages of a session file's branch tail (`readBranchTail`), whole, as the hub's projection clips custom text and tool arguments. */
export async function tailMessages(sessionFile: string): Promise<Said[] | undefined> {
  const tail = await readBranchTail(sessionFile);
  return tail?.entries.flatMap((entry: SessionEntry): Said[] => entry.type === "message" ? [entry.message as Said]
    : entry.type === "custom_message" ? [{ role: "custom", customType: entry.customType, content: entry.content, timestamp: Date.parse(entry.timestamp) }] : []);
}
