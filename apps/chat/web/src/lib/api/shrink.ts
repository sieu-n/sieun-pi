/**
 * A PNG as the smaller WebP the upload sends, when the encode costs less time than the smaller upload saves. On 11-19 the owner, 197 ms
 * from the box, waited 2,093 ms for one POST /api/uploads of a 1,756,844 byte PNG screenshot (3178 x 2282); Chrome's WebP at quality 0.9
 * makes that shot 235,458 bytes at 40.1 dB PSNR with its text as sharp at 2x zoom, where quality 1 (lossless) keeps 1,012,878 bytes and
 * JPEG at 0.9 keeps 473,741. The pixel size stays, so an agent reads the same shot. Any other type, a browser that cannot write WebP, an
 * image that fails to decode and a WebP that is no smaller all upload the file as it is.
 *
 * The encode runs in a worker (shrink.worker.ts): on 11-19 in the box Chrome the same encode on the page's thread held it for 273 to
 * 1,760 ms at a time over 5 runs, and in the worker for 32 to 108 ms.
 */
const WEBP_QUALITY = 0.9;

/** The bytes TCP sends in its first round trip: 10 segments of 1,460 bytes (RFC 6928). A smaller file has no round trip to save. */
const FIRST_FLIGHT = 14_600;

/** What this browser's encodes cost and gave so far, as sums: pixels, the ms they took, and the PNG and WebP bytes. */
export interface Measured { px: number; ms: number; from: number; to: number }

/**
 * Whether to encode a PNG of `bytes` and `px` pixels. A sender in slow start doubles what it sends each round trip, so a file `ratio`
 * times smaller saves log2(ratio) round trips, down to the one a first flight takes: at a 200 ms round trip the 11-19 shot went up in
 * 1,455 to 1,661 ms as PNG and 1,005 to 1,008 ms as WebP, 450 to 650 ms saved where 200 * log2(7.46) is 580. The encode costs this
 * browser's measured ms per pixel, 1,064 to 1,242 ms for that shot in the box Chrome, where it lost. With no encode measured yet or no
 * round trip known, the encode runs and is the measurement.
 */
export function worthIt(png: { bytes: number; px: number }, measured: Measured | undefined, roundTripMs: number | undefined): boolean {
  if (png.bytes <= FIRST_FLIGHT) return false;
  if (!measured || roundTripMs === undefined) return true;
  const saved = roundTripMs * Math.min(Math.log2(measured.from / measured.to), Math.log2(png.bytes / FIRST_FLIGHT));
  return png.px * (measured.ms / measured.px) < saved;
}

const KEY = "chat:shrink";

function measured(): Measured | undefined {
  try {
    const { px, ms, from, to } = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Measured>;
    return [px, ms, from, to].every(n => typeof n === "number" && n > 0) ? { px: px!, ms: ms!, from: from!, to: to! } : undefined;
  } catch {
    return undefined;
  }
}

function record(one: Measured): void {
  const sum = measured();
  try {
    localStorage.setItem(KEY, JSON.stringify(sum ? { px: sum.px + one.px, ms: sum.ms + one.ms, from: sum.from + one.from, to: sum.to + one.to } : one));
  } catch {
    // A full or closed storage only means the next attach measures again.
  }
}

/** A PNG's pixel count from its IHDR chunk: width and height are the big-endian 32-bit numbers at bytes 16 and 20. */
async function pixels(png: Blob): Promise<number> {
  const header = new DataView(await png.slice(0, 24).arrayBuffer());
  return header.byteLength < 24 ? 0 : header.getUint32(16) * header.getUint32(20);
}

let worker: Worker | undefined;
const waiting = new Set<(webp: Blob | undefined) => void>();

function encode(file: Blob): Promise<Blob | undefined> {
  return new Promise(resolve => {
    try {
      if (!worker) {
        worker = new Worker(new URL("./shrink.worker.ts", import.meta.url), { type: "module" });
        worker.onerror = () => {
          worker = undefined;
          for (const answer of waiting) answer(undefined);
          waiting.clear();
        };
      }
      const { port1, port2 } = new MessageChannel();
      waiting.add(resolve);
      port1.onmessage = (event: MessageEvent<Blob | undefined>) => {
        port1.close();
        waiting.delete(resolve);
        resolve(event.data);
      };
      worker.postMessage({ file, quality: WEBP_QUALITY, port: port2 }, [port2]);
    } catch {
      resolve(undefined);
    }
  });
}

/** The bytes to upload for `file`, and the ms the encode took when one ran. `roundTripMs` is the page's round trip to the server, if known. */
export async function shrink(file: Blob, roundTripMs: number | undefined): Promise<{ blob: Blob; encodeMs?: number }> {
  if (file.type !== "image/png" || typeof Worker === "undefined") return { blob: file };
  const px = await pixels(file);
  if (!worthIt({ bytes: file.size, px }, measured(), roundTripMs)) return { blob: file };
  const started = performance.now();
  const webp = await encode(file);
  const encodeMs = Math.round(performance.now() - started);
  if (!webp) return { blob: file, encodeMs };
  if (px > 0) record({ px, ms: Math.max(encodeMs, 1), from: file.size, to: webp.size });
  return { blob: webp.size < file.size ? webp : file, encodeMs };
}
