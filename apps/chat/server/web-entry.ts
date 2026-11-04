/**
 * The web client's build, named by the entry script its index.html loads (`/assets/index-<hash>.js` after `vite build`). The server says it
 * in the hello and GET /api/me, and a page whose own entry script differs runs an older build and offers a reload (web/src/lib/api/stale.ts).
 * On 11-04 at 03:09Z a tab loaded before b2058046 sent images in a shape the server no longer took, and two of the owner's posts came back
 * Not delivered.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The `src` of index.html's module script in `webDir`, or null when there is no built index.html. */
export function webEntry(webDir: string): string | null {
  let html: string;
  try {
    html = readFileSync(join(webDir, "index.html"), "utf8");
  } catch {
    return null;
  }
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\btype=["']module["']/.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/.exec(tag)?.[1];
    if (src) return src;
  }
  return null;
}
