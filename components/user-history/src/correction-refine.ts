import type { Ledger } from "./chat-corrections.ts";
import { ownerMessages } from "./shared/brief-check.ts";
import { CORRECTION_CHECK_PREFIX } from "./shared/chat-feed.ts";
import { messageText } from "./shared/turns.ts";
import type { ThreadMessage } from "./shared/types.ts";

/**
 * Words an owner message carries when it corrects how agents work. On 10-16, over the 674 owner messages of the 10 open chats, this matched 63
 * of the 89 the ledger holds and 159 of the other 585, many of them corrections no chat recorded ("I SAID SETUP DUTY", "nononono"). A match only
 * asks the chat to judge (`correctionStep`), so a miss costs one short turn the owner never sees.
 */
const CORRECTION_WORDS = new RegExp(String.raw`\b(i (?:said|told|tell you)|didn'?t i|again|never|stop|why (?:did|do|does|is|are|don'?t|the fuck)\b|wtf|what the fuck|un?slop\w*|` +
  String.raw`you keep|you seem|are you sure|r u|(?:no+){2,}|horrible|terrible|bad defaults?|bullshit|don'?t|do not|instead of|always|your (?:job|duty|responsibility)|it'?s your|` +
  String.raw`should(?:n'?t)? (?:not|be|have|never|always))\b|씨발|시발|미친|개소리|하라니까|하지\s*마|지\s*마\b|말고|왜|제발`, "i");
export const readsAsCorrection = (text: string): boolean => CORRECTION_WORDS.test(text);

/** The one line a chat gets when the owner's newest message reads as a correction and no correction_add followed it (c80: one plain line). */
export const CORRECTION_ASK = `${CORRECTION_CHECK_PREFIX}If the owner's last message corrects how you work, apply it and record it with correction_add now; if not, end the turn.`;

/** A ledger entry or repeat a chat recorded: when, the owner's words and the rule. */
interface Recorded { id: string; at: number; words: string; rule: string }
const recordedIn = (ledger: Ledger, chat: string): Recorded[] => ledger.corrections.flatMap(entry => [
  ...(entry.chat.id === chat ? [{ id: entry.id, at: Date.parse(entry.at), words: entry.words, rule: entry.rule }] : []),
  ...entry.repeats.filter(repeat => repeat.chat.id === chat).map(repeat => ({ id: entry.id, at: Date.parse(repeat.at), words: repeat.words, rule: entry.rule })),
]);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The session command that refines the harness on what the chat recorded: Prime runs `/refine` from prompt text in that chat's session. `global`
 * false (a clean-room chat) keeps the edit in that session, since the script, not the owner, wrote its messages.
 */
export function refineCommand(recorded: readonly Pick<Recorded, "id" | "words" | "rule">[], global = true): string {
  const items = recorded.map(item => `${item.id} "${oneLine(item.words)}" (rule: ${oneLine(item.rule)})`).join("; ");
  return `/refine${global ? " --global" : ""} The owner corrected an agent in this chat: ${items}. Make the smallest ${global ? "global " : ""}edit, a prompt ` +
    `note or memory in his terms, so every ${global ? "future session" : "later turn"} follows it, and fix any entry that says otherwise.`;
}

/** A refinement the chat ran itself (refine.run) or the service's `/refine`, after `at`; an auto-refinement is aimed at nothing in particular. */
const refinedSince = (messages: readonly ThreadMessage[], at: number): boolean =>
  messages.some(message => message.role === "custom" && message.customType === "refinement_notice" && message.timestamp >= at && /^\[(self|user)-refinement\]/.test(messageText(message)));

export type CorrectionStep = { kind: "refine" | "ask"; at: number; message: string };

/**
 * What the service sends a chat at the end of a turn, null for nothing. Every ledger entry or repeat the chat recorded since the owner's newest
 * message and at most `maxAgeMs` ago gets one global `/refine` aimed at it, unless a refinement the chat or the service ran already followed it.
 * With none, an owner message at most `maxAgeMs` old that reads as a correction gets CORRECTION_ASK; the turn that answers it records the
 * correction, and the scan at its end refines. `at` is the claim key: the newest recorded time, or the owner message's time.
 */
export function correctionStep(chat: string, ledger: Ledger, messages: readonly ThreadMessage[], now: number, maxAgeMs: number, global = true): CorrectionStep | null {
  const owner = ownerMessages(messages).at(-1);
  if (!owner) return null;
  const recorded = recordedIn(ledger, chat).filter(item => item.at >= owner.at && now - item.at <= maxAgeMs);
  if (recorded.length) {
    const at = Math.max(...recorded.map(item => item.at));
    return refinedSince(messages, at) ? null : { kind: "refine", at, message: refineCommand(recorded, global) };
  }
  return now - owner.at <= maxAgeMs && readsAsCorrection(owner.text) ? { kind: "ask", at: owner.at, message: CORRECTION_ASK } : null;
}
