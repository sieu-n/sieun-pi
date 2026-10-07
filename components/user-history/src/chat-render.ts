import { realpath, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, sep } from "node:path";
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

export class LocalFileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** An image file an agent wrote on this Mac and linked in a reply as `![alt](/abs/path.png)` or `~/path.png`. */
export async function readLocalImage(path: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded) || expanded.includes("\0")) throw new LocalFileError(400, "Give an absolute image path.");
  let file: string;
  try { file = await realpath(expanded); } catch { throw new LocalFileError(404, "Image file not found."); }
  const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!mimeType) throw new LocalFileError(415, "Only PNG, JPEG, GIF, WebP and SVG files show as images.");
  const info = await stat(file);
  if (!info.isFile()) throw new LocalFileError(404, "Image file not found.");
  if (info.size > MAX_LOCAL_IMAGE_BYTES) throw new LocalFileError(413, "Image files over 25 MiB do not show.");
  const bytes = await readFile(file);
  if (mimeType !== "image/svg+xml" && !hasImageSignature(bytes, mimeType as Parameters<typeof hasImageSignature>[1])) {
    throw new LocalFileError(415, "The file is not the image type its name says.");
  }
  return { bytes, mimeType };
}

export const MAX_LOCAL_TEXT_BYTES = 2 * 1024 * 1024;
/** How the reader shows a text file: markdown rendered, a diff with line colors, anything else as code named by its extension. */
export type TextKind = { kind: "markdown" } | { kind: "diff" } | { kind: "code"; language: string };
export function textKind(path: string): TextKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return { kind: "markdown" };
  if (extension === ".diff" || extension === ".patch") return { kind: "diff" };
  return { kind: "code", language: extension.slice(1) };
}
/** A file whose first 8 KiB hold a NUL byte is binary, whatever its name says. */
const TEXT_PROBE_BYTES = 8 * 1024;
export const isTextBytes = (bytes: Uint8Array): boolean => !bytes.subarray(0, TEXT_PROBE_BYTES).includes(0);
/** Where a `file:` artifact link may point: job reports and session artifacts, chat data, and the repositories. */
export const LOCAL_TEXT_ROOTS = ["~/.prime/agent/session-artifacts", "~/.prime/agent/browser-chat", "~/Documents/Github"];
/** The chat service's own secrets (capability, write and stop tokens) live in browser-chat; the route never serves them. */
const SECRET_FILES = new Set(["configuration.json"]);

/**
 * A text file a `file:` artifact link points at, read-only. Any UTF-8 text file (no NUL byte in its first 8 KiB) up to 2 MiB, whose real
 * path (symlinks resolved) is inside one of `roots` and has no hidden part (.git, .env, ...) below the root. `kind` says how to show it.
 */
export async function readLocalText(path: string, roots: readonly string[] = LOCAL_TEXT_ROOTS): Promise<{ path: string; text: string } & TextKind> {
  const home = (value: string) => value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
  const expanded = home(path);
  if (!isAbsolute(expanded) || expanded.includes("\0")) throw new LocalFileError(400, "Give an absolute file path.");
  let file: string;
  try { file = await realpath(expanded); } catch { throw new LocalFileError(404, "File not found."); }
  const realRoots = await Promise.all(roots.map(root => realpath(home(root)).catch(() => null)));
  const inside = realRoots.some(root => {
    if (!root || !file.startsWith(root + sep)) return false;
    const parts = file.slice(root.length + 1).split(sep);
    return !parts.some(part => part.startsWith(".")) && !(parts.length === 1 && SECRET_FILES.has(parts[0]!));
  });
  if (!inside) throw new LocalFileError(403, "That file is outside the folders the chat may open.");
  const info = await stat(file);
  if (!info.isFile()) throw new LocalFileError(404, "File not found.");
  if (info.size > MAX_LOCAL_TEXT_BYTES) throw new LocalFileError(413, "Files over 2 MiB do not open here.");
  const bytes = await readFile(file);
  if (!isTextBytes(bytes)) throw new LocalFileError(415, "The file is not text.");
  try { return { path: file, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), ...textKind(file) }; }
  catch { throw new LocalFileError(415, "The file is not UTF-8 text."); }
}
