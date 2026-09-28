import { realpath, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { hasImageSignature } from "./chat-images.ts";
import { asset, type Asset } from "./chat-assets.ts";

/*
 * Rich blocks (mermaid today) draw inside `<iframe sandbox="allow-scripts">` pointing at `render`. The sandbox gives the frame
 * an opaque origin: it cannot read the chat's storage, cookies or API, and the chat page keeps its strict CSP. The frame gets
 * its own looser policy (inline styles for mermaid's SVG) and talks to the chat only through postMessage.
 */

let renderBundle: Promise<Asset> | null = null;
/** The renderer bundle is large (mermaid), so it builds on the first diagram, not at service start. */
export function buildRenderBundle(): Promise<Asset> {
  renderBundle ??= build({
    entryPoints: [fileURLToPath(new URL("./render/main.ts", import.meta.url))], bundle: true, write: false, format: "iife", target: "es2022",
    minify: true, sourcemap: false, legalComments: "none", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
  }).then(result => {
    const js = result.outputFiles[0];
    if (!js) throw new Error("Render bundle produced no output");
    return asset(js.contents, "text/javascript; charset=utf-8");
  }).catch(error => { renderBundle = null; throw error; });
  return renderBundle;
}

export const renderPage = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
#out { display: flex; justify-content: safe center; overflow-x: auto; padding: 12px 8px; }
#out svg { display: block; flex: none; }
</style>
</head>
<body>
<div id="out"></div>
<script src="render.js"></script>
</body>
</html>
`;

/** The frame's own policy. `origin` is the chat's origin, the only page allowed to embed it. */
export function renderPolicy(origin: string, base: string): string {
  return `default-src 'none'; script-src ${origin}${base}render.js; style-src 'unsafe-inline'; img-src data:; font-src data:; ` +
    `base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};
export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

export class LocalImageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** An image file an agent wrote on this Mac and linked in a reply as `![alt](/abs/path.png)` or `~/path.png`. */
export async function readLocalImage(path: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded) || expanded.includes("\0")) throw new LocalImageError(400, "Give an absolute image path.");
  let file: string;
  try { file = await realpath(expanded); } catch { throw new LocalImageError(404, "Image file not found."); }
  const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!mimeType) throw new LocalImageError(415, "Only PNG, JPEG, GIF, WebP and SVG files show as images.");
  const info = await stat(file);
  if (!info.isFile()) throw new LocalImageError(404, "Image file not found.");
  if (info.size > MAX_LOCAL_IMAGE_BYTES) throw new LocalImageError(413, "Image files over 25 MiB do not show.");
  const bytes = await readFile(file);
  if (mimeType !== "image/svg+xml" && !hasImageSignature(bytes, mimeType as Parameters<typeof hasImageSignature>[1])) {
    throw new LocalImageError(415, "The file is not the image type its name says.");
  }
  return { bytes, mimeType };
}
