/**
 * An image at the width a post draws it: `GET /api/local-image?path=<path>&w=<px>` and `GET /api/uploads/<file>?w=<px>`, as WebP when the
 * browser takes it (`Accept: image/webp`) and else in the file's own type. On 11-23 a fresh open of p231-walk's copy of thread p134 pulled
 * its full-size screenshots, 1.7 MB, to draw them at most 480 px wide, and on a 4 Mbit/s link his clicks in the next 2.7 s waited 1.4 to
 * 2.2 s behind them (work/p231-slow-calls/p231-walk/summary.md). The same seven screenshots at 480 px are 96 KB as WebP, and 290 KB at 960 px.
 *
 * A rendition is built once and kept in `<data dir>/renditions/<sha256 of the file>-<width>-<type>`, so a second ask reads the kept file,
 * and a file whose bytes changed gets a new name and builds again. The upload or screenshot itself is never changed, and the route without
 * `w` still answers its exact bytes.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

/** The types a rendition is built from; GIF (which may move) and SVG (which scales) answer as they are. */
const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Widths round up to a multiple of this, so one image keeps a handful of renditions however the page asks. */
const WIDTH_STEP = 40;

// libvips keeps decoded images in a memory cache for the next operation on them; each rendition reads its file once, so it keeps none.
sharp.cache(false);

/** `w` as a width in px, rounded up to a multiple of 40; null when absent, undefined when it is not a positive whole number. */
export function renditionWidth(raw: string | null): number | null | undefined {
  if (raw === null) return null;
  if (!/^\d{1,5}$/.test(raw) || Number(raw) === 0) return undefined;
  return Math.ceil(Number(raw) / WIDTH_STEP) * WIDTH_STEP;
}

/** Whether an Accept header names WebP; every current browser sends `image/webp` for an img. */
export const takesWebp = (accept: string | undefined): boolean => !!accept && /\bimage\/webp\b/.test(accept);

/** The type of a kept rendition from its first bytes: a rendition that came out larger than its file is the file itself. */
function typeOf(bytes: Buffer): string {
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

export type Rendition = { bytes: Buffer; mimeType: string };
export type SourceFile = { path: string; mimeType: string; size: number; mtimeMs: number };

export class Renditions {
  /** Content hashes by path, size and change time, so a second ask of an unchanged file reads and hashes nothing. */
  private readonly hashes = new Map<string, string>();
  private readonly building = new Map<string, Promise<Buffer>>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Renditions this process built; the tests read it. */
  built = 0;

  constructor(readonly dir: string) {}

  /** The file at `width` px wide at most, or undefined for a type that keeps its own bytes. Throws when the file does not decode. */
  async get(file: SourceFile, width: number, webp: boolean): Promise<Rendition | undefined> {
    if (!RESIZABLE.has(file.mimeType)) return undefined;
    const type = webp ? "image/webp" : file.mimeType;
    const { hash, bytes } = await this.hashOf(file);
    const out = join(this.dir, `${hash}-${width}-${type.slice("image/".length)}`);
    const kept = await readFile(out).catch(() => undefined);
    if (kept) return { bytes: kept, mimeType: typeOf(kept) };
    let pending = this.building.get(out);
    if (!pending) {
      pending = this.build(file.path, bytes, out, width, type).finally(() => this.building.delete(out));
      this.building.set(out, pending);
    }
    const made = await pending;
    return { bytes: made, mimeType: typeOf(made) };
  }

  private async hashOf(file: SourceFile): Promise<{ hash: string; bytes?: Buffer }> {
    const key = `${file.path}\0${file.size}\0${file.mtimeMs}`;
    const known = this.hashes.get(key);
    if (known) return { hash: known };
    const bytes = await readFile(file.path);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    this.hashes.set(key, hash);
    return { hash, bytes };
  }

  /**
   * One build at a time. sharp runs each build on a thread of libuv's pool, which also serves the server's file reads and has 4 threads;
   * a build of one 1280 to 1512 px screenshot took 60 to 150 ms on us-metal02 (11-23), so seven at once held the whole pool for about 300 ms.
   */
  private build(path: string, read: Buffer | undefined, out: string, width: number, type: string): Promise<Buffer> {
    const run = this.queue.then(async () => {
      const source = read ?? (await readFile(path));
      const resized = sharp(source).rotate().resize({ width, withoutEnlargement: true });
      const made = await (type === "image/webp" ? resized.webp({ quality: 80 }) : type === "image/jpeg" ? resized.jpeg({ quality: 82, mozjpeg: true }) : resized.png({ compressionLevel: 9 })).toBuffer();
      const bytes = made.length < source.length ? made : source;
      await mkdir(this.dir, { recursive: true });
      const temp = `${out}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, out);
      this.built++;
      return bytes;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
