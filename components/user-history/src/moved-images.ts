import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * A root session's artifacts folder, where the daemon keeps each direct subagent's folder by child id: `session-artifacts/<session id>`
 * beside the folder of its session file (prime-agent `getSessionArtifactPathForFile`).
 */
export const artifactsDir = (sessionFile: string): string => join(dirname(dirname(sessionFile)), "session-artifacts", basename(sessionFile, ".jsonl"));

/** The name the chat serves an image under, `api/images/<key>`: the same whether its base64 sits in the session file or was moved to a file. */
export function imageKey(mimeType: string, data: string): string {
  return createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MOVED = /^images\/([a-f0-9]{64})\.(png|jpg|gif|webp)$/;

/**
 * An image part whose bytes `scripts/session-compact.ts` moved out of an old entry of the session file: `data` is empty and `file` names
 * `images/<key>.<ext>` in the session's artifacts folder. Only entries before the session's last compaction are moved, so Prime never sends one
 * to a model.
 */
export interface MovedImagePart { type: "image"; data: ""; mimeType: string; file: string }

/** The key and mime type of an image part whose bytes were moved to a file; undefined for any other part. */
export function movedImage(part: unknown): { key: string; mimeType: string; file: string } | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const { type, data, mimeType, file } = part as Record<string, unknown>;
  if (type !== "image" || data !== "" || typeof mimeType !== "string" || typeof file !== "string") return undefined;
  const match = MOVED.exec(file);
  if (!match || EXTENSIONS[mimeType] !== match[2]) return undefined;
  return { key: match[1]!, mimeType, file };
}

/** Every moved image part in session entries' content (messages and custom messages), with where `sessionFile` keeps its bytes. */
export function movedImages(entries: readonly unknown[], sessionFile: string): { key: string; mimeType: string; path: string }[] {
  const found: { key: string; mimeType: string; path: string }[] = [];
  for (const entry of entries) {
    const record = entry as { type?: unknown; message?: { content?: unknown }; content?: unknown };
    const content = record.type === "message" ? record.message?.content : record.type === "custom_message" ? record.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const moved = movedImage(part);
      if (moved) found.push({ key: moved.key, mimeType: moved.mimeType, path: join(artifactsDir(sessionFile), moved.file) });
    }
  }
  return found;
}

/** The moved form of an inline image part, and the file its bytes go to; undefined for a type the chat does not serve. */
export function moveImage(mimeType: string, data: string): { part: MovedImagePart; key: string } | undefined {
  const extension = EXTENSIONS[mimeType];
  if (!extension) return undefined;
  const key = imageKey(mimeType, data);
  return { part: { type: "image", data: "", mimeType, file: `images/${key}.${extension}` }, key };
}
