/**
 * Files the owner attaches that are not images, such as a PDF, a CSV or a zip. Their bytes sit beside the images (POST /api/uploads),
 * and the post shows a file card. A model reads only image blocks, so an agent gets each such file as one line in the text it reads,
 * with the file's path on the chat's box, and opens it with its own tools. In a DM the line also carries the card back: the timeline of
 * a thread reads the line out of the owner's input and draws the card again (`withFileCards`).
 */
import type { ImageRef } from "../web/src/lib/api/types.ts";

export const isImage = (ref: Pick<ImageRef, "mimeType">): boolean => ref.mimeType.startsWith("image/");

/**
 * An image a model reads as an image block: the four types Anthropic takes. Any other image, such as a TIFF pasted on a Mac or an SVG,
 * reaches the agent as a file line with its path, because on 11-22 the owner's TIFF in a channel post made every later turn of
 * Search product, misc.'s comm thread fail with a 400 on its media type.
 */
const MODEL_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isModelImage = (ref: Pick<ImageRef, "mimeType">): boolean => MODEL_IMAGES.has(ref.mimeType);

/** The line an agent reads for one attached file that is not an image. */
export function fileNote(ref: ImageRef, box: string, path: string): string {
  return `[attached file ${JSON.stringify(ref.name ?? "file")} (${ref.mimeType}, ${ref.size ?? 0} bytes), saved on ${box} at ${path}]`;
}

/** The text with a line for each attached file a model does not read as an image; those images go to the model as image blocks instead. */
export function withFileNotes(text: string, refs: readonly ImageRef[], box: string, pathOf: (ref: ImageRef) => string): string {
  const notes = refs.filter(ref => !isModelImage(ref)).map(ref => fileNote(ref, box, pathOf(ref)));
  return notes.length ? [text, ...notes].filter(Boolean).join("\n\n") : text;
}

const NOTE = /^\[attached file ("(?:[^"\\]|\\.)*") \(([^,()]+), (\d+) bytes\), saved on \S+ at \S*\/([\w.-]+)\]$/gm;

/** An owner input as a thread holds it: its text without the file lines, and a card ref for each of them after its images. */
export function withFileCards(text: string, images: ImageRef[]): { text: string; images: ImageRef[] } {
  const files: ImageRef[] = [];
  const rest = text.replace(NOTE, (_line, name: string, mimeType: string, size: string, stored: string) => {
    files.push({ url: `/api/uploads/${stored}`, mimeType, name: JSON.parse(name) as string, size: Number(size) });
    return "";
  });
  return files.length ? { text: rest.replace(/\n{3,}/g, "\n\n").trim(), images: [...images, ...files] } : { text, images };
}

/** The extension a stored upload gets: the attached file's own, else one from its type, else `bin`. */
export function uploadExtension(mimeType: string, name?: string): string {
  const own = name?.match(/\.([A-Za-z0-9]{1,10})$/)?.[1];
  if (own) return own.toLowerCase();
  return mimeType.split("/")[1]?.replace(/[^a-z0-9]/g, "").slice(0, 10) || "bin";
}

/** How GET /api/uploads/<file> answers a file that is not an image: a PDF and plain text open in the tab, anything else downloads. */
const INLINE: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8", json: "text/plain; charset=utf-8",
};

export function uploadHeaders(ext: string, downloadName: string | null, download = false): Record<string, string> {
  const type = download ? undefined : INLINE[ext];
  const name = downloadName ? `; filename*=UTF-8''${encodeURIComponent(downloadName)}` : "";
  return {
    "content-type": type ?? "application/octet-stream",
    "content-disposition": `${type ? "inline" : "attachment"}${name}`,
    "x-content-type-options": "nosniff",
    // An uploaded file is the owner's and served from the app's origin; text runs no script in a sandbox, and Chrome's PDF viewer needs none.
    ...(type && ext !== "pdf" ? { "content-security-policy": "sandbox" } : {}),
  };
}
