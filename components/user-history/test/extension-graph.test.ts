import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Prime loads each extension once per session, through jiti with moduleCache off, so every module the extension imports statically is
 * evaluated again for each session on a worker. Before 10-18 extension/index.ts imported chat-service.ts for the /agent-chat command, and with
 * it the whole chat service, 128 files and esbuild-svelte's Svelte compiler. In Bun with Prime's own packages loaded first, the first load
 * took 45 MB of RSS against 17 MB without the service, and each further session took 1.6 MB of heap against 0.75 MB.
 */
const EXTENSION = resolve(dirname(fileURLToPath(import.meta.url)), "../extension/index.ts");
const STATIC = /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+["']([^"']+)["']/gm;

function staticGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>(), packages = new Set<string>(), stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(STATIC)) {
      const spec = match[1] ?? "";
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
      else if (!spec.startsWith("node:")) packages.add(spec);
    }
  }
  return { files, packages };
}

test("the extension's static imports leave out the chat service and its bundler", () => {
  const { files, packages } = staticGraph(EXTENSION);
  const names = [...files].map(file => file.slice(file.lastIndexOf("/src/") + 5));
  for (const heavy of ["chat-service.ts", "chat-backend.ts", "chat-server.ts", "chat-assets.ts", "chats.ts"]) assert.ok(!names.includes(heavy), heavy);
  for (const bundler of ["esbuild", "esbuild-svelte"]) assert.ok(!packages.has(bundler), bundler);
});
