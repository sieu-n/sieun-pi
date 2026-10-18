import { bytes } from "./format.ts";
import { IMAGE_MIME_TYPES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TOTAL_IMAGE_BYTES } from "../shared/limits.ts";

/**
 * Unsent composer text, images and the quote a Reply started, by draft key. They live for the page; a reload onto new client code keeps them
 * through `saveDrafts`, which the next page load reads back once.
 */
export interface DraftAttachment { id: number; name: string; mimeType: string; size: number; data: string; url: string }
export interface Draft { text: string; images: DraftAttachment[]; quote: string | null }
export const drafts = new Map<string, Draft>();

const unsent = (draft: Draft): boolean => draft.text.trim().length > 0 || draft.images.length > 0;

let attachmentId = 0;
export const nextAttachmentId = (): number => ++attachmentId;

const SAVED_DRAFTS = "chat-drafts-for-reload";
type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Writes every unsent draft for the next load of this tab; false when storage refused them (images past its quota), so the page keeps them. */
export function saveDrafts(storage: DraftStore = sessionStorage): boolean {
  const kept = [...drafts].filter(([, draft]) => unsent(draft))
    .map(([key, draft]) => [key, { ...draft, images: draft.images.map(image => ({ ...image, url: "" })) }]);
  try {
    if (kept.length) storage.setItem(SAVED_DRAFTS, JSON.stringify(kept));
    return true;
  } catch { return false; }
}

/** Puts the drafts the last load of this tab saved back into `drafts`, once; an image gets a data URL, since the old blob URL died. */
export function restoreDrafts(storage: DraftStore = sessionStorage): void {
  let saved: [string, Draft][];
  try { saved = JSON.parse(storage.getItem(SAVED_DRAFTS) ?? "[]"); storage.removeItem(SAVED_DRAFTS); } catch { return; }
  for (const [key, draft] of saved) {
    for (const image of draft.images) { image.url = "data:" + image.mimeType + ";base64," + image.data; attachmentId = Math.max(attachmentId, image.id); }
    drafts.set(key, draft);
  }
}

if (typeof sessionStorage !== "undefined") restoreDrafts();

/** A pasted or dropped file as a draft image, or the toast text that says why it was not added; `totalBytes` is what the draft holds already. */
export async function readImage(file: File, totalBytes: number): Promise<DraftAttachment | string> {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return `${file.name || "This file"} is not a PNG, JPEG, GIF or WebP image.`;
  if (file.size > MAX_CHAT_IMAGE_BYTES) return `${file.name || "This image"} is ${bytes(file.size)}. The limit is ${bytes(MAX_CHAT_IMAGE_BYTES)} per image.`;
  if (totalBytes + file.size > MAX_CHAT_TOTAL_IMAGE_BYTES) return `Images add up to more than ${bytes(MAX_CHAT_TOTAL_IMAGE_BYTES)}.`;
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read " + file.name));
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.readAsDataURL(file);
    });
    return { id: nextAttachmentId(), name: file.name || "image", mimeType: file.type, size: file.size, data, url: URL.createObjectURL(file) };
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
