/**
 * When a comm thread's tool round ends its turn. On 11-21 fresh channel agents in four blind runs on live :5184 ended 13 of 28 turns with a
 * summary no room shows, mostly right after a round that posted and closed together, such as tell_owner, set_emoji taking 👀 off,
 * set_thread_done and mark_message in one round, while their role text and mark_message's answer said to end with no text.
 *
 * A round ends the turn when its calls are only posts and closing calls, at least one call closes, and the turn has its answer: a post in
 * the round itself, or one an earlier round of the turn sent. Each of those calls that goes through returns pi-durable's `terminate` control
 * (`closingControl` in `for-me.ts`, the tell_owner hook in `prime-chat.ts`), and pi-durable ends the run with no further model request only
 * when every call of the round returns it, so a refused post or a mark that leaves an item pending lets the round run on. An agent that takes
 * 👀 off before it posts has no answer yet, so its turn runs on and the post still goes out.
 */
import type { Message } from "@earendil-works/pi-ai";

/** tell_owner's answer when the post went out (`TELL_OWNER_DONE` in legacy/prime/user-history/src/chat-guard.ts); a held post answers otherwise. */
export const TOLD = "told the owner";

type Call = { id: string; name: string; arguments: Record<string, unknown> };
const EYES = ["eyes", ":eyes:", "👀"];
const isEyes = (emoji: unknown): boolean => EYES.includes(String(emoji).trim());

/** A call that answers a post: a post, an edit of one, or a reaction other than 👀, which answers a post that needs no words. */
export const posts = (call: Omit<Call, "id">): boolean =>
  call.name === "tell_owner" || call.name === "edit_message" || (call.name === "set_emoji" && call.arguments.on === true && !isEyes(call.arguments.emoji));

/** A call that closes a handled post: the mark that completes it, the thread's done flag, or 👀 taken off. */
export const closes = (call: Omit<Call, "id">): boolean =>
  (call.name === "mark_message" && call.arguments.completed === true) || (call.name === "set_thread_done" && call.arguments.done === true) ||
  (call.name === "set_emoji" && call.arguments.on === false && isEyes(call.arguments.emoji));

const callsOf = (message: Message): Call[] =>
  message.role === "assistant" ? message.content.flatMap(part => (part.type === "toolCall" ? [{ id: part.id, name: part.name, arguments: part.arguments }] : [])) : [];

/** Whether an earlier result shows its post went out: no error, and for tell_owner the sent answer, since a held post is no error either. */
function wentOut(result: Message, call: Call): boolean {
  if (result.role !== "toolResult" || result.isError) return false;
  if (call.name !== "tell_owner") return true;
  return result.content.some(part => part.type === "text" && part.text.trim() === TOLD);
}

/**
 * Whether the round of call `callId` ends the turn, from the conversation's messages in order, which hold the round's assistant message and
 * may hold its finished results. False when the call's round is not among them.
 */
export function roundEndsTurn(messages: readonly Message[], callId: string): boolean {
  const at = messages.findLastIndex(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === callId));
  if (at < 0) return false;
  const round = callsOf(messages[at]!);
  if (!round.every(call => posts(call) || closes(call)) || !round.some(closes)) return false;
  if (round.some(posts)) return true;
  const results = new Map<string, Message>();
  for (let i = at - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return false;
    if (message.role === "toolResult") results.set(message.toolCallId, message);
    for (const call of callsOf(message)) {
      const result = results.get(call.id);
      if (posts(call) && result && wentOut(result, call)) return true;
    }
  }
  return false;
}
