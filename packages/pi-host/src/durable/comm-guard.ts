/**
 * What a comm thread may post (`apps/chat/docs/agent-model.md`, the comm and work split): a result, an answer or a question, never a relay of
 * its own work. tell_owner runs this check in a comm thread before Prime's guard (`prime-chat.ts`), and a refusal comes back as the tool's
 * error, so the model reads why and ends the turn.
 *
 * 1. A post in the turn that handed the work thread a task (`CommHandedDoc`, written by `threads.ts` `sendRoot`) is refused, unless it asks a
 *    question with no relay words. The agent's 👀 on the post shows it is on it, and the result comes once, from the work thread's report or
 *    the work-done notice. On 11-03 vent's comm thread handed the panel list over and then posted "The vent thread is now listing every panel,
 *    ...", and the agent factory comm thread answered the owner's complaint about that line with "Got it, ..." and "The agent factory work
 *    thread is building all five now, ...", both after its hand-over in the same turn.
 * 2. A post with hand-over words (`relay-line.ts`) is refused on any turn.
 * 3. A post with progress words is refused on a turn the owner did not start; on his turn it may answer his status question.
 */
import { relayWords } from "./relay-line.ts";

export interface CommPostTurn {
  /** Whether the owner's or a member's post started the turn, as Prime's guard reads it (`tellTurn`). */
  owner: boolean;
  /** Whether this comm thread handed its work thread a task after the turn's input arrived. */
  handed: boolean;
}

const asks = (text: string): boolean => text.includes("?");

/** Why a comm thread's post must not go out, or undefined when it may. */
export function commPostRefusal(text: string, turn: CommPostTurn): string | undefined {
  const relay = relayWords(text);
  if (turn.handed && (relay || !asks(text))) {
    return "Not sent: you handed this to your work thread in this turn. Your 👀 on the post already shows that you are on it, so post nothing " +
      "about the hand-over and end the turn now. Post the result once, when the work thread's report or the [work-done ...] notice brings it. " +
      "Only a question the owner must answer before the work can go on goes out now.";
  }
  if (relay?.kind === "handoff") {
    return `Not sent: "${relay.words}" announces a hand-over or a result to come. Your 👀 on the post already shows that the work runs, so post ` +
      "nothing until the result is in, then post the result once.";
  }
  if (relay && !turn.owner) {
    return `Not sent: "${relay.words}" is progress on work still going, and nobody asked for it on this turn. End the turn with no ` +
      "message, and post once when the result is in.";
  }
  return undefined;
}

/** The time the current turn's input arrived: the newest owner or agent message before the call, by its timestamp. */
export function turnStartedAt(messages: readonly { role: string; timestamp?: unknown }[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user" || message.role === "custom") return typeof message.timestamp === "number" ? message.timestamp : undefined;
  }
  return undefined;
}
