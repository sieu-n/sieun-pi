/**
 * `GET /api/local-image?path=<abs path>`: an image file an agent wrote on this box and linked in a reply as `![alt](/abs/path.png)`, `~/x.png`
 * or `file:` (web/src/lib/ui/markdown.ts `imageSource`). It serves image files only, after legacy/prime/user-history's `readLocalImage`.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};
/** Hard: a guard on the chat server's memory, since the whole file is read into one buffer. */
export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

export class LocalImageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The file's first bytes match the type its name says, so a renamed text file or key is never served as an image. */
function hasSignature(bytes: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png": return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif": return ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6));
    case "image/webp": return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
    case "image/svg+xml": return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString("utf8", 0, 4096));
    default: return false;
  }
}

export async function readLocalImage(path: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded) || expanded.includes("\0")) throw new LocalImageError(400, "Give an absolute image path.");
  let file: string;
  try {
    file = await realpath(expanded);
  } catch {
    throw new LocalImageError(404, "Image file not found.");
  }
  const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!mimeType) throw new LocalImageError(415, "Only PNG, JPEG, GIF, WebP and SVG files show as images.");
  const info = await stat(file);
  if (!info.isFile()) throw new LocalImageError(404, "Image file not found.");
  if (info.size > MAX_LOCAL_IMAGE_BYTES) throw new LocalImageError(413, "Image files over 25 MiB do not show.");
  const bytes = await readFile(file);
  if (!hasSignature(bytes, mimeType)) throw new LocalImageError(415, "The file is not the image type its name says.");
  return { bytes, mimeType };
}
