import { bytes } from "./format.ts";
import { IMAGE_MIME_TYPES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TOTAL_IMAGE_BYTES } from "../shared/limits.ts";

/** Unsent composer text, images and the quote a Reply started, by draft key; they live for the page, so a reload drops them. */
export interface DraftAttachment { id: number; name: string; mimeType: string; size: number; data: string; url: string }
export interface Draft { text: string; images: DraftAttachment[]; quote: string | null }
export const drafts = new Map<string, Draft>();

export function hasUnsentDrafts(): boolean { return [...drafts.values()].some(draft => draft.text.trim().length > 0 || draft.images.length > 0); }

let attachmentId = 0;

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
    return { id: ++attachmentId, name: file.name || "image", mimeType: file.type, size: file.size, data, url: URL.createObjectURL(file) };
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
