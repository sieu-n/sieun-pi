import type { ThreadMessage } from "./types.ts";

/** A depth-0 session a thread started with `rlm.create_session`, read from the handle its tool result printed. */
export interface CreatedSession { sessionId: string; name: string }
const HANDLE = /RLMCreateSessionHandle\(active_session_id='[^']*', session_id='([^']+)', name=(?:'([^']*)'|None)/g;
/** The create_session handles one tool result's text printed, in order. */
export const sessionHandles = (text: string): CreatedSession[] => [...text.matchAll(HANDLE)].map(match => ({ sessionId: match[1]!, name: match[2] ?? "" }));
/** Created sessions in first-seen order, one per session id, from the ipython tool results in the transcript. */
export function createdSessions(messages: readonly ThreadMessage[]): CreatedSession[] {
  const found = new Map<string, CreatedSession>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      for (const handle of sessionHandles(part.text)) if (!found.has(handle.sessionId)) found.set(handle.sessionId, handle);
    }
  }
  return [...found.values()];
}
