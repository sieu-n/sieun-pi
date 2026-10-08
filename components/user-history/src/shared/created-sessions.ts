import type { ThreadMessage } from "./types.ts";

/** A depth-0 session a thread started with `rlm.create_session`, read from the handle its tool result printed. */
export interface CreatedSession { sessionId: string; name: string }
const HANDLE = /RLMCreateSessionHandle\(active_session_id='[^']*', session_id='([^']+)', name=(?:'([^']*)'|None)/g;
/** Created sessions in first-seen order, one per session id, from the ipython tool results in the transcript. */
export function createdSessions(messages: readonly ThreadMessage[]): CreatedSession[] {
  const found = new Map<string, CreatedSession>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      for (const match of part.text.matchAll(HANDLE)) {
        const sessionId = match[1]!;
        if (!found.has(sessionId)) found.set(sessionId, { sessionId, name: match[2] ?? "" });
      }
    }
  }
  return [...found.values()];
}
