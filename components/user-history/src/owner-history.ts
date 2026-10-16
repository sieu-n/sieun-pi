import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { missing } from "./locked-json.ts";
import { type OwnerMessage, ownerMessages, ownerTexts } from "./shared/brief-check.ts";
import { ownerSaid } from "./chat-corrections.ts";
import { agentScheduleProblem, type DutySchedule } from "./shared/chat-duties.ts";
import { ownerMessageId } from "./shared/chat-feed.ts";
import type { ThreadMessage } from "./shared/types.ts";

/**
 * Every owner message in a session file, oldest first, read line by line; empty for a missing file. A thread's state holds only the file's
 * tail (session-tail.ts, TAIL_MESSAGES), so an owner message from days back is only in the file.
 */
export async function fileOwnerMessages(file: string): Promise<OwnerMessage[]> {
  return ownerMessages(await userMessages(file));
}

/** Every word the owner wrote in a session file (`ownerTexts`): his messages and his board answers. */
export async function fileOwnerTexts(file: string): Promise<string[]> {
  return ownerTexts(await userMessages(file));
}

/** The owner's own ask for a duty cadence an agent may not set (c66): his words, verbatim, and the id of the message that holds them. */
export interface OwnerCadence { words: string; messageId: string }

/** Whether `words` name the schedule's cadence: "60min", "every 90 minutes", "2h", "hourly". */
function namesCadence(words: string, minutes: number): boolean {
  const text = words.toLowerCase();
  if (new RegExp(`(^|\\D)${minutes}\\s*-?\\s*(m|mins?|minutes?)\\b`).test(text)) return true;
  if (minutes % 60 === 0 && new RegExp(`(^|\\D)${minutes / 60}\\s*-?\\s*(h|hrs?|hours?)\\b`).test(text)) return true;
  return minutes === 60 && /\b(hourly|every hour|an hour)\b/.test(text);
}

/**
 * Null when an agent may give the duty this schedule: `agentScheduleProblem` passes it, or the owner asked for it himself. His ask is `ok`: the
 * message id the chat reads after each owner message (`ownerMessageId`) names one of his messages in `owner`, the words are in that message
 * (`ownerSaid`, as correction_add checks them), and they name the cadence. On 10-14 09:17Z he wrote "setup a 60min cadence duty" (mv7w4mb3)
 * for the Mac stays usable duty. Else the refusal.
 */
export function ownerCadenceRefusal(schedule: DutySchedule, ok: Partial<OwnerCadence> | undefined, owner: readonly OwnerMessage[]): string | null {
  const refused = agentScheduleProblem(schedule);
  if (!refused || schedule.kind !== "every") return null;
  const hint = " When the owner asked for this cadence himself, pass his words with --owner-words and his message id with --owner-message.";
  if (!ok?.words?.trim() && !ok?.messageId?.trim()) return refused + hint;
  if (!ok.words?.trim() || !ok.messageId?.trim()) return `The owner override needs both his verbatim words and his message id; ${ok.words?.trim() ? "--owner-message" : "--owner-words"} is missing.`;
  const message = owner.find(entry => ownerMessageId(entry.at) === ok.messageId!.trim());
  if (!message) return `No owner message ${ok.messageId.trim()} in this chat. Give the id the chat read after his message ([message id: ...]).`;
  if (!ownerSaid(ok.words, [message.text])) return `"${ok.words}" is not in the owner's message ${ok.messageId.trim()}. Quote him exactly.`;
  if (!namesCadence(ok.words, schedule.minutes)) return `"${ok.words}" does not name every ${schedule.minutes} minutes, so it does not cover this schedule.`;
  return null;
}

async function userMessages(file: string): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  try {
    for await (const line of createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) {
      if (!line.includes('"user"')) continue;
      let entry: { type?: unknown; message?: { role?: unknown; timestamp?: unknown } };
      try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
      if (entry.type === "message" && entry.message?.role === "user" && typeof entry.message.timestamp === "number") messages.push(entry.message as ThreadMessage);
    }
  } catch (error) { if (missing(error)) return []; throw error; }
  return messages;
}
