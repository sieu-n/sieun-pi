import { CHAT_BOARD_TOOL } from "./chat-guard.ts";
import { type Said, textOf } from "./checkin-ops.ts";
import { DECISION_STEER_PREFIX } from "./shared/chat-feed.ts";

/*
 * Decisions on the scratchpad (c76, owner 10-15 in ops guy: "why don't you use the Plan scratchpad by the way?"). On 10-15 ops guy made a land
 * order at 05:41Z ("the order: our ops train lands the promtool glob c0008ee78d first"), kept SUMMARY_MAX_KEYS at 07:20Z, ruled at 07:43Z that
 * three runs "won't land" and skipped a re-probe at 07:50Z, each only in job and thread messages; its scratchpad got dated notes only at
 * 08:27Z, after the owner asked. Up to 10:20Z that day, 16 of its 18 turns that sent such a ruling added no scratch note.
 */

/** The words of a sent message that rule on something: a decision, a ruling, a land order, a drop, a skipped re-probe, a kept limit. */
export const RULING = /\b(decided|decision|ruled|ruling|the order|lands? first|won'?t land|will not land|no re-?probe|without (?:a )?re-?probe|wins over|ours drops|we drop|drop it from|mark (?:it|them) kept|kept with evidence)\b/i;
/** How much of a session file the check reads: ten times the longest turn of a busy chat (ops guy 10-15: at most 20 messages in a turn). */
export const DECISION_TAIL = { messages: 200, bytes: 4 * 1024 * 1024 };
const ENDS_TURN = new Set(["stop", "length"]);
const SHOWN = 3;

/** One agent message a chat's turn sent that rules on something: when, to whom, and the sentence with the ruling. */
export interface Ruling { at: number; to: string; words: string }
/** What one ended turn did: its rulings and whether a chat_board call the board took added or changed a scratch note. */
interface Turn { rulings: Ruling[]; noted: boolean; end: number }

interface Sent { message?: unknown; receiverRole?: unknown; target?: { sessionName?: unknown; sessionId?: unknown } }
const sentOf = (message: Said): Sent[] => {
  const sent = (message.details as { sentAgentMessages?: unknown } | undefined)?.sentAgentMessages;
  return Array.isArray(sent) ? sent.filter((item): item is Sent => typeof item === "object" && item !== null) : [];
};
/** The sentence of `text` that holds the ruling at `at`, clipped around the ruling's words. */
function sentence(text: string, at: number): string {
  const start = Math.max(0, ...[". ", "\n", ": "].map(mark => { const found = text.lastIndexOf(mark, at - mark.length); return found < 0 ? 0 : found + mark.length; }));
  const after = text.slice(at).search(/\.(\s|$)|\n/);
  const whole = text.slice(start, after < 0 ? undefined : at + after);
  const from = Math.max(0, at - start - 40);
  const words = whole.slice(from).replace(/\s+/g, " ").trim();
  return (from > 0 ? "\u2026" : "") + (words.length > 100 ? words.slice(0, 99) + "\u2026" : words);
}
const recipient = (sent: Sent): string => typeof sent.target?.sessionName === "string" && sent.target.sessionName !== "Untitled" ? sent.target.sessionName
  : typeof sent.target?.sessionId === "string" ? `thread:${sent.target.sessionId}` : String(sent.receiverRole ?? "another thread");
const scratchOps = (args: unknown): boolean => {
  const raw = typeof args === "object" && args !== null ? (args as { ops?: unknown }).ops : undefined;
  return Array.isArray(raw) && raw.some(op => typeof op === "object" && op !== null && String((op as { op?: unknown }).op).startsWith("scratch_"));
};

/**
 * The server's steer for a chat's last ended turn: undefined while no turn has ended or the tail does not reach the turn's start, else that
 * turn's end and the `[board]` line, null when the turn sent no ruling, added a scratch note, or already got the line. The line is in the
 * transcript, so a restart never sends it twice.
 */
export function decisionSteer(messages: Iterable<Said>): { at: number; line: string | null } | undefined {
  const turns: Turn[] = [];
  let current: Turn = { rulings: [], noted: false, end: 0 };
  let started = false;
  let asked = false;
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (call.type === "toolCall" && call.name === CHAT_BOARD_TOOL && typeof call.id === "string" && scratchOps(call.arguments)) calls.add(call.id);
      }
      if (ENDS_TURN.has(message.stopReason ?? "")) {
        if (started) turns.push({ ...current, end: message.timestamp ?? 0 });
        current = { rulings: [], noted: false, end: 0 };
        started = true;
        asked = false;
      }
    } else if (message.role === "toolResult") {
      if (message.toolCallId !== undefined && calls.delete(message.toolCallId) && !message.isError) current.noted = true;
      for (const sent of sentOf(message)) {
        const text = typeof sent.message === "string" ? sent.message : "";
        const found = RULING.exec(text);
        if (found) current.rulings.push({ at: message.timestamp ?? 0, to: recipient(sent), words: sentence(text, found.index) });
      }
    } else if (message.role === "user" && textOf(message.content).trim().startsWith(DECISION_STEER_PREFIX)) asked = true;
  }
  const turn = turns.at(-1);
  if (!turn) return undefined;
  if (asked || turn.noted || !turn.rulings.length) return { at: turn.end, line: null };
  return { at: turn.end, line: decisionLine(turn.rulings) };
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";
/** The `[board]` line for a turn's rulings with no scratch note. */
export const decisionLine = (rulings: readonly Ruling[]): string =>
  `${DECISION_STEER_PREFIX}your last turn sent ${rulings.length === 1 ? "a ruling" : `${rulings.length} rulings`} and added no scratch note: ` +
  rulings.slice(0, SHOWN).map(ruling => `to ${ruling.to} at ${clock(ruling.at)}, "${ruling.words}"`).join("; ") +
  (rulings.length > SHOWN ? `; and ${rulings.length - SHOWN} more` : "") +
  ". Add one dated scratch note for each decision this chat made, with a link to the thread or job (c76).";
