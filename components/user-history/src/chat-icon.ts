import { crc32, deflateSync } from "node:zlib";

/**
 * The app icon and favicon, drawn in code so the repository holds no image files and no native build is needed: a white four-point spark on a
 * violet tile. Violet is on purpose off the chat's ocean accent, so the tab stands out in a strip of blue and gray icons. `any` keeps the macOS
 * icon grid (a rounded tile on 80% of the canvas, transparent around it); `full` fills the square for maskable and Apple touch icons, which the
 * system shapes itself; `favicon` is a rounded tile edge to edge with a larger spark, because a browser tab draws it at 16 px.
 */
type Shape = "any" | "full" | "favicon";

const TOP = [0x96, 0x64, 0xff] as const;
const BOTTOM = [0x4f, 0x3c, 0xe5] as const;
const TILE: Record<Shape, { half: number; radius: number; spark: number }> = {
  any: { half: 0.4, radius: 0.18, spark: 0.29 },
  full: { half: 0.5, radius: 0, spark: 0.3 },
  favicon: { half: 0.5, radius: 0.23, spark: 0.36 },
};

function roundedRect(x: number, y: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Which part of the icon the point (x, y) in unit coordinates is on: 0 outside, 1 tile, 2 spark. The spark is an astroid, |dx|^(2/3) + |dy|^(2/3) <= a^(2/3). */
function part(x: number, y: number, shape: Shape): number {
  const tile = TILE[shape];
  if (roundedRect(x, y, 0.5, 0.5, tile.half, tile.half, tile.radius) > 0) return 0;
  return Math.abs(x - 0.5) ** (2 / 3) + Math.abs(y - 0.5) ** (2 / 3) <= tile.spark ** (2 / 3) ? 2 : 1;
}

/** Color and alpha (0 to 1) of a part at (x, y). The tile runs from light violet at the top left to deep violet at the bottom right. */
function color(kind: number, x: number, y: number): [number, number, number, number] {
  if (kind === 0) return [0, 0, 0, 0];
  if (kind === 2) return [255, 255, 255, 1];
  const t = Math.min(Math.max((x * 0.35 + y * 0.65 - 0.05) / 0.9, 0), 1);
  return [TOP[0] + (BOTTOM[0] - TOP[0]) * t, TOP[1] + (BOTTOM[1] - TOP[1]) * t, TOP[2] + (BOTTOM[2] - TOP[2]) * t, 1];
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A square RGBA PNG of the icon. A pixel whose four corners lie on one part takes that part's color; an edge pixel averages 4 by 4 samples. */
export function iconPng(size: number, shape: Shape): Buffer {
  const grid = 4;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  let above = Array.from({ length: size + 1 }, (_, x) => part(x / size, 0, shape));
  for (let py = 0; py < size; py++) {
    const below = Array.from({ length: size + 1 }, (_, x) => part(x / size, (py + 1) / size, shape));
    const row = py * (size * 4 + 1);
    for (let px = 0; px < size; px++) {
      const at = row + 1 + px * 4;
      const corner = above[px]!;
      if (corner === above[px + 1] && corner === below[px] && corner === below[px + 1]) {
        const [cr, cg, cb, ca] = color(corner, (px + 0.5) / size, (py + 0.5) / size);
        rows.set([Math.round(cr), Math.round(cg), Math.round(cb), Math.round(ca * 255)], at);
        continue;
      }
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < grid; sy++) for (let sx = 0; sx < grid; sx++) {
        const x = (px + (sx + 0.5) / grid) / size, y = (py + (sy + 0.5) / grid) / size;
        const [cr, cg, cb, ca] = color(part(x, y, shape), x, y);
        r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
      }
      rows.set([a ? Math.round(r / a) : 0, a ? Math.round(g / a) : 0, a ? Math.round(b / a) : 0, Math.round((a / (grid * grid)) * 255)], at);
    }
    above = below;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
