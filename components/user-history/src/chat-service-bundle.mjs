import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Bundles the chat service (src/chat-service.ts and every module it imports, the lazy ones too) into src/chat-service.bundle.mjs, which
 * chat-service-cli.mjs loads when it exists. tsx compiles each .ts file on its first import, and its compile cache keys on the file's full
 * path, so each release folder compiled every file again at each start: the 06:25Z start on us-metal02 on 10-20 held the main thread 7.1 s,
 * 1.8 s of it in tsx's transformSync. release-chat.mjs runs this at build time; a checkout without the file runs the source as before.
 */
export const BUNDLE = "chat-service.bundle.mjs";
const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * A module outside src/ keeps the meaning of its import.meta in the bundle, whose own import.meta names src/chat-service.bundle.mjs: its url,
 * filename and dirname become paths from the bundle to the module's own file.
 */
export function anchorImportMeta(source, file, outDir = SRC) {
  if (dirname(file) === outDir || !source.includes("import.meta")) return source;
  const path = relative(outDir, file).split(sep).join("/");
  const url = `new URL(${JSON.stringify(path)}, import.meta.url)`;
  return source
    .replaceAll("import.meta.url", `${url}.href`)
    .replaceAll("import.meta.filename", `decodeURIComponent(${url}.pathname)`)
    .replaceAll("import.meta.dirname", `decodeURIComponent(new URL(".", ${url}).pathname).replace(/\\/$/, "")`);
}

export async function bundleChatService({ entry = join(SRC, "chat-service.ts"), outfile = join(SRC, BUNDLE) } = {}) {
  const outDir = dirname(outfile);
  const result = await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node22",
    packages: "external", logLevel: "warning", plugins: [{ name: "anchor-import-meta", setup(input) {
      input.onLoad({ filter: /\.ts$/ }, async args => ({ contents: anchorImportMeta(await readFile(args.path, "utf8"), args.path, outDir), loader: "ts" }));
    } }] });
  if (result.warnings.length) throw new Error(`chat service bundle: ${result.warnings.length} warnings`);
  return outfile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = performance.now();
  const file = await bundleChatService();
  process.stdout.write(`chat service bundle: ${file} in ${Math.round(performance.now() - started)} ms\n`);
}
