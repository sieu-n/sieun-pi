/**
 * A speaking call's post, made while the call runs (apps/chat rooms.ts `speakNow`), so tell_owner and send_message answer with the post's
 * id, and the read-before-send check: when the thread the post goes in moved since the agent last read it, apps/chat posts nothing and
 * answers with the new posts, which the call returns as its error (owner p221, his pick p226 of fable auditor's p222 in #sw-factory-build).
 *
 * Only a thread's root conversation speaks in a room. A chat server that has no such route, or no such call in its feed, or that does not
 * answer, leaves the post to the feed, which posts it once the call's result lands, as before.
 */
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import type { ChatApp } from "./chat-app.ts";

export type Spoke = { posted: string } | { held: string } | undefined;

export async function speak(app: ChatApp | undefined, thread: string, conversation: ConversationId, callId: string | undefined, signal?: AbortSignal): Promise<Spoke> {
  if (!app || !callId || conversation !== ROOT_CONVERSATION_ID) return undefined;
  try {
    const answer = await app.speak(thread, callId, signal);
    if (answer.kind === "posted") return { posted: `${answer.room}/${answer.id}` };
    if (answer.kind === "held") return { held: answer.text };
    return undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}
