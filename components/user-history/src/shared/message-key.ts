import type { ThreadMessage } from "./types.ts";

/**
 * A message's name that survives paging: its `timestamp` and how many earlier messages of the thread share it. An index into the list a page
 * holds changes when an older page loads; the 7 biggest chats on 10-18 held 4 to 20 repeated timestamps per 1,000 messages, so the time alone
 * is not enough. A page never splits the messages that share a timestamp (session-tail.ts `readBranchPage`), so `n` over any loaded list is the
 * thread-wide value.
 */
export interface MessageKey { at: number; n: number }

export function messageKey(messages: readonly Pick<ThreadMessage, "timestamp">[], index: number): MessageKey {
  const at = messages[index]!.timestamp;
  let n = 0;
  for (let earlier = index - 1; earlier >= 0 && messages[earlier]!.timestamp === at; earlier--) n++;
  return { at, n };
}

/** The index of the message `key` names in a list, or -1. */
export function keyIndex(messages: readonly Pick<ThreadMessage, "timestamp">[], key: MessageKey): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.timestamp === key.at && messageKey(messages, index).n === key.n) return index;
  }
  return -1;
}

/**
 * Where a thread's older messages start, opaque to the page: `f<end>.<id>` is a place in the session file (`FilePlace`), and `m<at>.<n>` is
 * "before this message", which the server answers from the messages it holds or by finding the message in the file.
 */
export type OlderCursor = { kind: "file"; end: number; id: string } | { kind: "message"; key: MessageKey };

export function formatCursor(cursor: OlderCursor): string {
  return cursor.kind === "file" ? `f${cursor.end}.${cursor.id}` : `m${cursor.key.at}.${cursor.key.n}`;
}

export function parseCursor(text: string): OlderCursor | null {
  const file = /^f(\d+)\.([\w-]{1,128})$/.exec(text);
  if (file) { const end = Number(file[1]); return Number.isSafeInteger(end) ? { kind: "file", end, id: file[2]! } : null; }
  const message = /^m(\d+)\.(\d+)$/.exec(text);
  if (!message) return null;
  const at = Number(message[1]), n = Number(message[2]);
  return Number.isSafeInteger(at) && Number.isSafeInteger(n) ? { kind: "message", key: { at, n } } : null;
}
