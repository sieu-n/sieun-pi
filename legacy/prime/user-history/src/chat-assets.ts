import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { iconPng } from "./chat-icon.ts";
import { bundleCacheDir, clientSourceHash, readChunkList, readChunks, writeChunks } from "./client-bundle.ts";
import { scopeClass, type PrepaintModule } from "./prepaint.ts";

const sveltePlugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;

/** `br` and `gzip` are the body compressed at the best level ahead of time (`packAsset`); an asset without them is gzipped on its first request. */
export interface Asset { body: Buffer; etag: string; contentType: string; br?: Buffer; gzip?: Buffer }
/**
 * `version` names this build; the page carries it and the sessions stream reports it, so an open tab sees a restart onto new code.
 * `app` returns the installable-app file for a route under the capability path (manifest and icons), or undefined.
 * `prepaint` is the server half of the build (prepaint.ts), or undefined where it did not load.
 * `chunks` are the parts of app.js the page loads on its own (`chunk.<hash>.js`), and `preload` names the ones app.js imports at once.
 */
export interface ClientBundle { js: Asset; css: Asset; version: string; app?: (route: string) => Asset | undefined; prepaint?: PrepaintModule; chunks?: Record<string, Asset>; preload?: string[] }

export function asset(body: Uint8Array, contentType: string): Asset {
  const buffer = Buffer.from(body);
  return { body: buffer, etag: '"' + createHash("sha256").update(buffer).digest("hex").slice(0, 32) + '"', contentType };
}

/**
 * The name the page asks for an asset by: its content hash is in the name, so the browser keeps it with `immutable` and a later load reads
 * it from disk with no request. On 10-18 app.js and app.css went out as `no-cache`, and every load from Korea paid a round trip to revalidate
 * them before the script could start.
 */
export function assetName(stem: string, extension: string, asset: Asset): string {
  return `${stem}.${asset.etag.replace(/"/g, "").slice(0, 16)}.${extension}`;
}

/** Brotli at quality 11 and gzip at level 9, once per build: app.js was 658 KB raw and 227 KB gzipped at level 9 on 10-18. */
export function packAsset(asset: Asset): Asset {
  return { ...asset, br: brotliCompressSync(asset.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: asset.body.length } }), gzip: gzipSync(asset.body, { level: 9 }) };
}

const svelteOptions = (generate: "client" | "server") => ({ runes: true, css: "external" as const, dev: false, generate, cssHash: ({ filename }: { filename?: string }) => scopeClass(filename ?? "") });

/**
 * The esbuild and Svelte compile of the client: app.js, its chunks and app.css. It holds its thread for seconds, so `buildClientBundle` runs it
 * in a worker. The views a page opens only on a click load on their own (client/lazy.ts): on 10-19 app.js was 697 KB raw and 197 KB brotli, and
 * from the Mac (195 ms a round trip) it ended 0.4 to 0.8 s after the shell. `preload` is every chunk app.js imports at once, at any depth.
 * Each lazy chunk's stylesheet repeats the rules of the components it shares with app.js, so app.css takes only their new rules (`mergeCss`).
 */
export async function compileClient(): Promise<{ js: Uint8Array; css: Uint8Array; chunks: Record<string, Uint8Array>; preload: string[] }> {
  const entry = fileURLToPath(new URL("./client/main.ts", import.meta.url));
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", target: "es2022", minify: true, sourcemap: false, legalComments: "none",
    outdir: "/virtual", entryNames: "app", chunkNames: "chunk.[hash]", splitting: true, metafile: true, logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [sveltePlugin({ compilerOptions: svelteOptions("client"), cache: false, filterWarnings: (warning: { code: string }) => !warning.code.startsWith("a11y") })],
  });
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const js = result.outputFiles.find(file => name(file.path) === "app.js");
  const css = result.outputFiles.find(file => name(file.path) === "app.css");
  if (!js) throw new Error("Client bundle produced no app.js");
  const chunks = Object.fromEntries(result.outputFiles.filter(file => name(file.path).startsWith("chunk.") && file.path.endsWith(".js")).map(file => [name(file.path), file.contents]));
  const lazyCss = result.outputFiles.filter(file => name(file.path).startsWith("chunk.") && file.path.endsWith(".css")).map(file => file.text);
  const outputs = result.metafile.outputs;
  const preload = new Set<string>();
  const walk = (path: string): void => {
    for (const imported of outputs[path]?.imports ?? []) {
      if (imported.kind !== "import-statement" || preload.has(name(imported.path))) continue;
      preload.add(name(imported.path));
      walk(imported.path);
    }
  };
  walk(Object.keys(outputs).find(path => name(path) === "app.js")!);
  return { js: js.contents, css: Buffer.from(mergeCss(css?.text ?? "", lazyCss)), chunks, preload: [...preload] };
}

/** The top-level rules of minified CSS, an at-rule with its whole block as one. */
export function cssRules(text: string): string[] {
  const rules: string[] = [];
  let depth = 0, start = 0, quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) { if (char === "\\") index++; else if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { rules.push(text.slice(start, index + 1).trim()); start = index + 1; }
    else if (char === ";" && depth === 0) { rules.push(text.slice(start, index + 1).trim()); start = index + 1; }
  }
  const rest = text.slice(start).trim();
  if (rest) rules.push(rest);
  return rules;
}

/** `main` followed by each rule of `others` it lacks, once, in their order. */
export function mergeCss(main: string, others: readonly string[]): string {
  const seen = new Set(cssRules(main));
  const added: string[] = [];
  for (const text of others) for (const rule of cssRules(text)) if (!seen.has(rule)) { seen.add(rule); added.push(rule); }
  return added.length ? main.trimEnd() + "\n" + added.join("") + "\n" : main;
}

/**
 * The server half: client/prepaint-lines.ts and ChatLines.svelte compiled for Node, one ES module with no imports. The page modules that
 * reach the browser's store or API on import (store.svelte.ts, api.ts) are empty here, since a server render runs no event handler or effect.
 */
export async function compileServer(): Promise<string> {
  const entry = fileURLToPath(new URL("./client/prepaint-lines.ts", import.meta.url));
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node", target: "node22", minify: true, sourcemap: false, legalComments: "none",
    outdir: "/virtual", entryNames: "prepaint", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      { name: "browser-only", setup: build => {
        build.onResolve({ filter: /\/(store\.svelte|api)\.ts$/ }, args => ({ path: args.path, namespace: "browser-only" }));
        build.onLoad({ filter: /.*/, namespace: "browser-only" }, () => ({ contents: "export const store = {}; export const api = {};", loader: "js" }));
      } },
      sveltePlugin({ compilerOptions: svelteOptions("server"), cache: false, filterWarnings: () => false }),
    ],
  });
  const js = result.outputFiles.find(file => file.path.endsWith(".js"));
  if (!js) throw new Error("Server bundle produced no prepaint.js");
  return js.text;
}

/** The server half, loaded from its source. A build that fails to load leaves the page without the still view, never without the app. */
export async function loadPrepaint(source: string): Promise<PrepaintModule | undefined> {
  try { return await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as PrepaintModule; }
  catch (error) { process.stderr.write(`prepaint: the server bundle did not load: ${error instanceof Error ? error.message : String(error)}\n`); return undefined; }
}

type Packed = { js: Asset; css: Asset; chunks: Record<string, Asset>; preload: string[]; prepaint: string };
type Compiled = ({ ok: true } & Packed) | { ok: false; error: string };

/** The worker's half: compile, then compress both assets there too, since brotli at quality 11 takes about a second for app.js. */
export async function compileAndPack(): Promise<Packed> {
  const [{ js, css, chunks, preload }, prepaint] = await Promise.all([compileClient(), compileServer()]);
  const script = (body: Uint8Array) => packAsset(asset(body, "text/javascript; charset=utf-8"));
  return { js: script(js), css: packAsset(asset(css, "text/css; charset=utf-8")), chunks: Object.fromEntries(Object.entries(chunks).map(([name, body]) => [name, script(body)])), preload, prepaint };
}

/** A worker message carries Uint8Arrays where the asset had Buffers. */
const revive = (sent: Asset): Asset => ({ ...sent, body: Buffer.from(sent.body), ...(sent.br ? { br: Buffer.from(sent.br) } : {}), ...(sent.gzip ? { gzip: Buffer.from(sent.gzip) } : {}) });

/**
 * The packed bundle release-chat.mjs writes into a release before it goes live (`chat-assets-prebuild.mjs`), so a restart reads it from disk.
 * A checkout without it compiles at start. On 10-18 the compile took 6.5 s at a load of 50, and every page shell waited for it after each of
 * the day's 21 restarts by 08:40Z.
 */
export const PREBUILT_DIR = fileURLToPath(new URL("../.client-bundle/", import.meta.url));
const prebuiltFiles = (stem: string) => [stem, `${stem}.br`, `${stem}.gz`];

export async function writePrebuilt(dir = PREBUILT_DIR): Promise<void> {
  await writeBuilt(dir, await compileAndPack());
}

/** A packed bundle into `dir`, through a draft folder renamed into place, so a folder that exists is whole. */
async function writeBuilt(dir: string, { js, css, chunks, preload, prepaint }: Packed): Promise<void> {
  const draft = `${dir.replace(/\/+$/, "")}.${process.pid}.tmp`;
  await rm(draft, { recursive: true, force: true });
  await mkdir(draft, { recursive: true });
  for (const [stem, packed] of [["app.js", js], ["app.css", css]] as const) {
    const [body, br, gzip] = prebuiltFiles(stem);
    await writeFile(join(draft, body!), packed.body);
    await writeFile(join(draft, br!), packed.br!);
    await writeFile(join(draft, gzip!), packed.gzip!);
  }
  await writeChunks(draft, chunks, preload);
  await writeFile(join(draft, PREPAINT_FILE), prepaint);
  await rm(dir, { recursive: true, force: true });
  await rename(draft, dir);
}

/** The prebuilt bundle in `dir`, or null when the folder or one of its files is missing. */
export async function readPrebuilt(dir = PREBUILT_DIR): Promise<ClientBundle | null> {
  const read = async (stem: string, contentType: string): Promise<Asset> => {
    const [body, br, gzip] = await Promise.all(prebuiltFiles(stem).map(name => readFile(join(dir, name))));
    return { ...asset(body!, contentType), br: br!, gzip: gzip! };
  };
  try {
    const [js, css, prepaint, list] = await Promise.all([read("app.js", "text/javascript; charset=utf-8"), read("app.css", "text/css; charset=utf-8"), readFile(join(dir, PREPAINT_FILE), "utf8"), readChunkList(dir)]);
    return await bundleOf({ js, css, prepaint, chunks: await readChunks(dir, list.names), preload: list.preload });
  } catch { return null; }
}

const PREPAINT_FILE = "prepaint.mjs";
const bundleOf = async ({ js, css, prepaint, chunks, preload }: Packed): Promise<ClientBundle> => {
  const loaded = await loadPrepaint(prepaint);
  return { js, css, version: createHash("sha256").update(js.etag + css.etag).digest("hex").slice(0, 16), app: appAsset, chunks, preload, ...(loaded ? { prepaint: loaded } : {}) };
};

/**
 * The release's prebuilt bundle (`readPrebuilt`), else the one a former start cached for the same client sources (client-bundle.ts
 * `bundleCacheDir`), else a compile in a worker thread (`chat-assets-worker.mjs`) so the server keeps answering, cached for the next start.
 * Releases on 10-18 came from a helper that wrote no prebuilt bundle, and each restart compiled the same client again.
 */
export async function buildClientBundle(dir = PREBUILT_DIR): Promise<ClientBundle> {
  const cache = bundleCacheDir(await clientSourceHash());
  const found = await readPrebuilt(dir) ?? await readPrebuilt(cache);
  if (found) return found;
  const { packed, bundle } = await compileInWorker();
  void writeBuilt(cache, packed).catch(error => { process.stderr.write(`client bundle cache ${cache}: ${error instanceof Error ? error.message : String(error)}\n`); });
  return bundle;
}

function compileInWorker(): Promise<{ packed: Packed; bundle: Promise<ClientBundle> }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./chat-assets-worker.mjs", import.meta.url));
    worker.once("message", (compiled: Compiled) => {
      void worker.terminate();
      if (!compiled.ok) { reject(new Error(compiled.error)); return; }
      const packed: Packed = { js: revive(compiled.js), css: revive(compiled.css), prepaint: compiled.prepaint, preload: compiled.preload,
        chunks: Object.fromEntries(Object.entries(compiled.chunks).map(([name, chunk]) => [name, revive(chunk)])) };
      resolve({ packed, bundle: bundleOf(packed) });
    });
    worker.once("error", reject);
    worker.once("exit", code => { reject(new Error(`The client bundle worker exited (${code}) with no bundle.`)); });
  });
}

/**
 * The web app manifest that lets Chrome or Aside install the chat as an app ("Install app" or "Open in app"): its own window and a Dock icon
 * that opens the capability URL. Every URL is relative to the manifest, which sits at `<capability>/manifest.webmanifest`, so the same file works
 * on 127.0.0.1 and on the Tailscale host. `id` is the start URL, so one capability is one installed app.
 */
export const appManifest = {
  id: "./", name: "Prime Agent chat", short_name: "Agent chat", description: "Browser chat for Prime Agent sessions on this Mac.",
  start_url: "./", scope: "./", display: "standalone", background_color: "#f8f9fb", theme_color: "#f8f9fb",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

const appSources: Record<string, () => Asset> = {
  "manifest.webmanifest": () => asset(Buffer.from(JSON.stringify(appManifest, null, 1) + "\n"), "application/manifest+json; charset=utf-8"),
  "favicon-32.png": () => asset(iconPng(32, "favicon"), "image/png"),
  "favicon-64.png": () => asset(iconPng(64, "favicon"), "image/png"),
  "icon-192.png": () => asset(iconPng(192, "any"), "image/png"),
  "icon-512.png": () => asset(iconPng(512, "any"), "image/png"),
  "icon-maskable-512.png": () => asset(iconPng(512, "full"), "image/png"),
  "apple-touch-icon.png": () => asset(iconPng(180, "full"), "image/png"),
};
const appBuilt = new Map<string, Asset>();

/** The manifest or an icon, drawn on its first request (the 512 px icon takes about 0.2 s) and kept for the life of the process. */
export function appAsset(route: string): Asset | undefined {
  if (!Object.hasOwn(appSources, route)) return undefined;
  let built = appBuilt.get(route);
  if (!built) { built = appSources[route]!(); appBuilt.set(route, built); }
  return built;
}
