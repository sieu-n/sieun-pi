/**
 * The fallback that gets the owner an answer he can see when a DM comm thread's turn ends with text and no post.
 *
 * In a Prime chat the text of a turn the owner started is his reply bubble when no tell_owner call went out (chat-feed.ts `chatLines`). In
 * sw factory a room shows only what a speaking call posts (apps/chat rooms.ts `readFeedThread`), so that text reached nobody. On 11-03 a
 * walk asked agent "wiki popup walk" in its DM to "Reply with exactly the markdown between the lines and nothing else, no tools", and the
 * comm thread wrote the markdown as its turn's text, which stayed in the thread until a second ask.
 *
 * So when a DM comm thread's root yields a final answer with text, on a turn the owner's post started, with no post since that post and no
 * hand-over to the work thread in the turn, pi-host queues Prime's server note for an unanswered owner message as the thread's next input
 * (`OWNER_RETRY_MARK` under `CHECK_IN_PREFIX`, as chat-recovery.ts restarts a failed owner turn). The note's turn is the owner's, so the model
 * posts its answer through tell_owner and every guard on it, the relay check included, or ends with no text when its reaction already
 * answered. The note goes in as a follow-up with a request id from the owner's post, not as the run's continuation: a continuation is
 * dropped when his next post waits at the run's end, and on 11-03 the walk's "Reply with exactly the word ALPHA" turn waited 29 min for an
 * account while his next ask queued, so its "ALPHA" was lost.
 * A handed turn gets no note: its text announces the hand-over, and the result posts when the work-done notice brings it. Group rooms get no
 * note either, since a post there often needs nothing from the agent.
 */
import { CHECK_IN_PREFIX, OWNER_RETRY_MARK, serverNote, TELL_OWNER_HELD } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import type { ThreadMessage } from "../../../../legacy/prime/user-history/src/shared/types.ts";

/** How the note opens; a turn that starts with it gets no second one. */
export const UNPOSTED_REPLY = `${CHECK_IN_PREFIX}Your turn ended with text and no post.`;
const CLIP = 200;

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap(part => (part?.type === "text" && typeof part.text === "string" ? [part.text as string] : [])).join("\n") : "";

/** The note for one owner post, quoted the way chat-recovery.ts quotes his unanswered message. */
export function unpostedReplyNote(owner: string): string {
  const quoted = owner.length > CLIP ? `${owner.slice(0, CLIP - 1)}…` : owner;
  return `${UNPOSTED_REPLY} The DM shows only what you post with tell_owner, so the owner saw nothing. ${OWNER_RETRY_MARK}"${quoted}". ` +
    "Post your answer with tell_owner now. If your reaction already answers it, end the turn with no text.";
}

/**
 * The note a DM comm thread's final answer gets, with the time of the owner post it is for, or undefined when it needs none. `messages` is the root's context as Prime reads it
 * (`threadMessages`), before `answer`; `handedAt` is when the comm thread last handed its work thread a task (`CommHandedDoc`), 0 for never.
 */
export function unpostedReply(messages: readonly ThreadMessage[], answer: { content: unknown }, handedAt: number, speaking: ReadonlySet<string>): { note: string; ownerAt: unknown } | undefined {
  if (!textOf(answer.content).trim()) return undefined;
  // A failed request that the pool retries in the same run ends no turn.
  const settled = messages.findLastIndex(message => message.role === "assistant" && !["toolUse", "error"].includes((message as { stopReason?: string }).stopReason ?? ""));
  const turn = messages.slice(settled + 1);
  const inputs = turn.filter(message => message.role === "user" || message.role === "custom");
  if (inputs.some(message => textOf(message.content).trim().startsWith(UNPOSTED_REPLY))) return undefined;
  const owner = inputs.findLast(message => message.role === "user" && serverNote(textOf(message.content).trim()) === undefined);
  if (!owner) return undefined;
  const startedAt = inputs[0]!.timestamp;
  if (handedAt > 0 && typeof startedAt === "number" && handedAt >= startedAt) return undefined;
  const posted = turn.some(message => message.role === "toolResult" && speaking.has(message.toolName) && !message.isError && !textOf(message.content).startsWith(TELL_OWNER_HELD));
  return posted ? undefined : { note: unpostedReplyNote(textOf(owner.content).trim()), ownerAt: owner.timestamp };
}

/** The note's request id: one per owner post, so a generation rerun after a crash queues it once. */
export const unpostedReplyRequest = (thread: string, ownerAt: unknown): string => `unposted:${thread}:${String(ownerAt)}`;
