import { keyIndex, messageKey, type MessageKey } from "../shared/message-key.ts";
import type { OlderPage, ThreadState } from "../shared/types.ts";

/** Where the newest page of the last snapshot starts and its cursor: the place a thread left alone goes back to (`trimToNewest`). */
export interface NewestPage { first: MessageKey | null; older: string | undefined }

export const newestPage = (state: ThreadState): NewestPage =>
  ({ first: state.messages.length ? messageKey(state.messages, 0) : null, older: state.older });

/**
 * A new snapshot over the state the tab holds. The snapshot carries the newest page only; when its first message is one the tab holds, the
 * older pages the owner scrolled into stay in front of it with their cursor. Any other snapshot (a compaction, a reset) replaces them.
 */
export function keepOlder(held: ThreadState | null, next: ThreadState): ThreadState {
  if (!held || !next.messages.length) return next;
  const at = keyIndex(held.messages, messageKey(next.messages, 0));
  if (at <= 0) return next;
  return withOlder({ ...next, messages: [...held.messages.slice(0, at), ...next.messages] }, held.older);
}

/** An older page put in front of the held messages, with the cursor for the page before it. */
export function prependOlder(state: ThreadState, page: OlderPage): ThreadState {
  return withOlder({ ...state, messages: [...page.messages, ...state.messages] }, page.older);
}

/** A thread back to the newest page of its last snapshot and what came after it, dropping the older pages loaded since. */
export function trimToNewest(state: ThreadState, newest: NewestPage | null): ThreadState {
  if (!newest?.first) return state;
  const at = keyIndex(state.messages, newest.first);
  return at > 0 ? withOlder({ ...state, messages: state.messages.slice(at) }, newest.older) : state;
}

function withOlder(state: ThreadState, older: string | undefined): ThreadState {
  const { older: _dropped, ...rest } = state;
  return older === undefined ? rest : { ...rest, older };
}
