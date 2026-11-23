// Builds or serves a release folder's web client with the overlay's web/ files swapped in, writing only under the run's own folder.
// node vite.mjs build <outDir> <cacheDir> | node vite.mjs serve <port> <cacheDir>, run from the release's apps/chat/web.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { overlayFromEnv } from "./overlay.mjs";

const [command, target, cacheDir] = process.argv.slice(2);
const overlay = overlayFromEnv();
if (!overlay || !["build", "serve"].includes(command) || !target || !cacheDir) {
  console.error("usage (with the env scripts/spec-clean.mjs sets): node vite.mjs build <outDir> <cacheDir> | serve <port> <cacheDir>");
  process.exit(2);
}
const web = join(overlay.release, "web");
const { build, createServer } = await import(pathToFileURL(join(web, "node_modules/vite/dist/node/index.js")).href);
// The release's own config, imported here rather than given to vite as a file, because vite bundles a config file into node_modules/.vite-temp.
const { default: config } = await import(pathToFileURL(join(web, "vite.config.ts")).href);

const swapped = new Map([...overlay.files].filter(([path]) => path.startsWith("web/")).map(([path, source]) => [join(overlay.release, path), source]));
const clean = id => id.split("?")[0];
/** Loads each swapped file from its source, and resolves an import of a file the overlay adds that the release lacks. */
const overlayPlugin = {
  name: "spec-clean-overlay",
  enforce: "pre",
  resolveId(source, importer) {
    const base = source.startsWith("/") ? source : source.startsWith(".") && importer ? resolve(clean(importer), "..", source) : null;
    if (!base) return null;
    return ["", ".ts", ".js", ".svelte", ".svelte.ts"].map(ext => base + ext).find(path => swapped.has(path)) ?? null;
  },
  load(id) {
    const source = id.includes("?") ? undefined : swapped.get(id);
    return source ? readFileSync(source, "utf8") : null;
  },
};

const inline = { ...config, configFile: false, root: web, cacheDir, plugins: [overlayPlugin, ...(config.plugins ?? [])] };
if (command === "build") {
  await build({ ...inline, logLevel: "warn", build: { ...config.build, outDir: target, emptyOutDir: true } });
} else {
  const server = await createServer({ ...inline, server: { ...config.server, host: "127.0.0.1", port: Number(target), strictPort: true, watch: null } });
  await server.listen();
  console.log(`spec-clean vite on http://127.0.0.1:${target}`);
}
