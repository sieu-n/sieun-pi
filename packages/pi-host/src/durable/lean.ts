/**
 * The page form of an entry for `durable_entries` with `lean`: what a timeline draws, without the bytes it never shows.
 *
 * 1. An image block keeps its type and mimeType and loses its data, because the page loads each image by its own URL.
 * 2. A text block of a tool result or a system message keeps its first LEAN_TEXT characters and an ellipsis line, because the timeline cuts
 *    a tool's output at 4000 characters and draws no system message.
 *
 * On 11-03 a 100-entry page of a job that took screenshots was 2.0 MB, 1.76 MB of it image data, and took 0.3 to 1 s to cross pi-host, the
 * relay and the chat server under load; the same page lean is about 0.25 of the size.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";

export const LEAN_TEXT = 4000;
const CLIPPED_ROLES = new Set(["toolResult", "system"]);

type Block = { type: string; text?: string; data?: string };

const clip = (text: string): string => (text.length > LEAN_TEXT ? `${text.slice(0, LEAN_TEXT)}\n...` : text);

function leanBlock(block: Block, clipText: boolean): Block {
  if (block.type === "image" && typeof block.data === "string" && block.data) return { ...block, data: "" };
  if (clipText && block.type === "text" && typeof block.text === "string" && block.text.length > LEAN_TEXT) return { ...block, text: clip(block.text) };
  return block;
}

export function leanEntry(entry: EntryRecord): EntryRecord {
  const model = (entry as { model?: unknown }).model;
  if (!Array.isArray(model)) return entry;
  let changed = false;
  const next = model.map((message: { role?: string; content?: unknown }) => {
    const clipText = CLIPPED_ROLES.has(message?.role ?? "");
    if (typeof message?.content === "string") {
      if (!clipText || message.content.length <= LEAN_TEXT) return message;
      changed = true;
      return { ...message, content: clip(message.content) };
    }
    if (!Array.isArray(message?.content)) return message;
    const content = (message.content as Block[]).map(block => leanBlock(block, clipText));
    if (content.every((block, index) => block === (message.content as Block[])[index])) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? ({ ...entry, model: next } as EntryRecord) : entry;
}
