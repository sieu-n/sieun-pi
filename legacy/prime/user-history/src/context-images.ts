import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

// Prime resizes terminal pastes and @file images, but not images sent through the
// daemon prompt API (browser chat) or returned by tools. Anthropic rejects any image
// over 2000 px once a request carries more than 20 images, so one full-size
// screenshot breaks every later turn of its thread.

export interface ContextImage { type: "image"; data: string; mimeType: string }
export type FitImage = (image: ContextImage) => Promise<ContextImage>;

export const MAX_IMAGE_EDGE = 2000;
export const IMAGE_CACHE_ENTRIES = 256;

type WorkerReply = { fits: true } | { data: string; mimeType: string } | { error: string };

/**
 * The image shrunk so its longer edge is at most maxEdge. A header that shows the image fits skips the decode, and the shrink runs on a worker
 * thread: on 11-03 a photon resize on the event loop stalled Prime worker 597bd6f3376c for 5.6 s, 10.0 s, 9.4 s and 7.7 s.
 */
export async function fitImageEdge(image: ContextImage, maxEdge = MAX_IMAGE_EDGE): Promise<ContextImage> {
  const size = imageSize(image);
  if (size && Math.max(size.width, size.height) <= maxEdge) return image;
  const reply = await new Promise<WorkerReply>((resolve, reject) => {
    const worker = new Worker(new URL("./context-images-worker.mjs", import.meta.url), { workerData: { data: image.data, mimeType: image.mimeType, maxEdge } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`the image worker exited with code ${code} before it replied`)));
  });
  if ("error" in reply) throw new Error(reply.error);
  if ("fits" in reply) return image;
  return { type: "image", data: reply.data, mimeType: reply.mimeType };
}

/** The pixel size a PNG, GIF or JPEG header names, or undefined for another format or a header it cannot read. */
export function imageSize(image: ContextImage): { width: number; height: number } | undefined {
  const bytes = Buffer.from(image.data.slice(0, 1 << 16), "base64");
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "GIF") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

/**
 * What goes in place of an image the fit failed on: the image itself when its header shows it fits, else a text line. On 10-19 from 15:56Z
 * frontend bro (01a11ba8) failed every turn with "messages.44.content.1.image ... exceed max allowed size for many-image requests: 3000 pixels"
 * on the owner's 3600 x 2214 screenshot, because its worker's fit failed and the unfitted image went out on every call.
 */
export type Fitted = ContextImage | { type: "text"; text: string };

const PROCESS_CACHE = Symbol.for("sieun-pi.context-images.cache");

// Prime loads the extension with jiti's module cache off, so each load gets a fresh module; one map on globalThis lets every session of a worker
// reuse a fit instead of shrinking the same image again.
function processCache(): Map<string, Promise<Fitted>> {
  const holder = globalThis as { [PROCESS_CACHE]?: Map<string, Promise<Fitted>> };
  return holder[PROCESS_CACHE] ??= new Map();
}

export class ImageFitter {
  private readonly cache: Map<string, Promise<Fitted>>;

  constructor(private readonly fit: FitImage = fitImageEdge, private readonly limit = IMAGE_CACHE_ENTRIES, private readonly log: (line: string) => void = () => {}) {
    this.cache = fit === fitImageEdge ? processCache() : new Map();
  }

  /** The image fitted to MAX_IMAGE_EDGE. A failed fit is not kept, so the next call tries again. */
  image(image: ContextImage): Promise<Fitted> {
    const key = createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
    let fitted = this.cache.get(key);
    if (!fitted) {
      fitted = this.fit(image).catch(error => {
        this.cache.delete(key);
        const size = imageSize(image);
        const why = error instanceof Error ? error.message : String(error);
        this.log(`context image ${key.slice(0, 12)} ${size ? `${size.width}x${size.height}` : "of unknown size"} (${image.mimeType}): fit failed: ${why}`);
        if (size && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE) return image;
        return { type: "text" as const, text: `[An image${size ? ` of ${size.width} x ${size.height} px` : ""} was left out of this request: it may be over ` +
          `${MAX_IMAGE_EDGE} px, and shrinking it failed (${why}).]` };
      });
      this.cache.set(key, fitted);
      if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    }
    return fitted;
  }

  // Replaces oversized images in place; returns undefined when nothing changed.
  async messages<T>(messages: T[]): Promise<T[] | undefined> {
    let changed = false;
    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (let index = 0; index < content.length; index++) {
        const part = content[index] as Partial<ContextImage> | null;
        if (part?.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") continue;
        const fitted = await this.image({ type: "image", data: part.data, mimeType: part.mimeType });
        if (fitted.type === "text") content[index] = fitted;
        else if (fitted.data === part.data) continue;
        else content[index] = { ...part, data: fitted.data, mimeType: fitted.mimeType };
        changed = true;
      }
    }
    return changed ? messages : undefined;
  }
}
