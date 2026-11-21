/**
 * The owner's sends that have not landed yet, kept in localStorage, so a reload (his own, or the page's after a release, `reload.ts`) or a
 * closed thread view loses none of them. A send is kept at Enter: with its images' refs once they are uploaded, and until then with
 * `uploading`, the count of its images whose bytes wait in IndexedDB (held-images.ts). It is dropped when it lands or he discards it. A kept send with an `error` showed Not delivered; one without was on its way when the page went, so the
 * next page sends it again with the same requestId, which the server takes once. On 11-04 the owner's #dev-search-general post lived only
 * in an open tab as Not delivered, and a reload would have lost it.
 */
import type { ConversationId, ImageRef } from "./types.ts";

export interface HeldSend {
  conversation: ConversationId;
  requestId: string;
  text: string;
  images: ImageRef[];
  /** The send's images are not uploaded yet: this many, their bytes in held-images.ts under the requestId, and `images` is empty. */
  uploading?: number;
  mentions?: string[];
  threadRoot?: string;
  whenBusy?: "steer" | "followUp";
  at: number;
  error?: string;
}

const KEY = "chat.heldSends";

const isRef = (value: unknown): value is ImageRef =>
  typeof (value as ImageRef)?.url === "string" && typeof (value as ImageRef)?.mimeType === "string";

/** One stored entry, or null for anything an older page or a hand edit left that is not one. */
function parse(value: unknown): HeldSend | null {
  const v = value as Partial<HeldSend> | null;
  if (typeof v?.conversation !== "string" || typeof v.requestId !== "string" || typeof v.text !== "string" || typeof v.at !== "number") return null;
  if (!Array.isArray(v.images) || !v.images.every(isRef)) return null;
  return {
    conversation: v.conversation, requestId: v.requestId, text: v.text, images: v.images, at: v.at,
    ...(typeof v.uploading === "number" && v.uploading > 0 ? { uploading: v.uploading } : {}),
    ...(Array.isArray(v.mentions) && v.mentions.every(m => typeof m === "string") ? { mentions: v.mentions } : {}),
    ...(typeof v.threadRoot === "string" ? { threadRoot: v.threadRoot } : {}),
    ...(v.whenBusy === "steer" || v.whenBusy === "followUp" ? { whenBusy: v.whenBusy } : {}),
    ...(typeof v.error === "string" ? { error: v.error } : {}),
  };
}

function readAll(): HeldSend[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.flatMap(item => parse(item) ?? []) : [];
  } catch {
    return [];
  }
}

function writeAll(list: HeldSend[]): void {
  if (typeof localStorage === "undefined") return;
  if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
  else localStorage.removeItem(KEY);
}

export const heldSends = {
  /** The kept sends of one conversation: its top level, or one channel thread with `threadRoot`. */
  of(conversation: ConversationId, threadRoot?: string): HeldSend[] {
    return readAll().filter(s => s.conversation === conversation && s.threadRoot === threadRoot);
  },
  has(requestId: string): boolean {
    return readAll().some(s => s.requestId === requestId);
  },
  /** Whether the send is kept with all it needs to go out from another page: its images' refs, or no image. */
  hasRefs(requestId: string): boolean {
    return readAll().some(s => s.requestId === requestId && !s.uploading);
  },
  keep(send: HeldSend): void {
    writeAll([...readAll().filter(s => s.requestId !== send.requestId), send]);
  },
  /** Marks a kept send Not delivered with its error; a send that was never kept stays so. */
  fail(requestId: string, error: string): void {
    const list = readAll();
    if (list.some(s => s.requestId === requestId)) writeAll(list.map(s => (s.requestId === requestId ? { ...s, error } : s)));
  },
  drop(requestId: string): void {
    const list = readAll();
    if (list.some(s => s.requestId === requestId)) writeAll(list.filter(s => s.requestId !== requestId));
  },
};
