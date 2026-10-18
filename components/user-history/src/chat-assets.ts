import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { iconPng } from "./chat-icon.ts";

const sveltePlugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;

/** `br` and `gzip` are the body compressed at the best level ahead of time (`packAsset`); an asset without them is gzipped on its first request. */
export interface Asset { body: Buffer; etag: string; contentType: string; br?: Buffer; gzip?: Buffer }
/**
 * `version` names this build; the page carries it and the sessions stream reports it, so an open tab sees a restart onto new code.
 * `app` returns the installable-app file for a route under the capability path (manifest and icons), or undefined.
 */
export interface ClientBundle { js: Asset; css: Asset; version: string; app?: (route: string) => Asset | undefined }

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

/** The esbuild and Svelte compile of the client: app.js and app.css. It holds its thread for seconds, so `buildClientBundle` runs it in a worker. */
export async function compileClient(): Promise<{ js: Uint8Array; css: Uint8Array }> {
  const entry = fileURLToPath(new URL("./client/main.ts", import.meta.url));
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", target: "es2022", minify: true, sourcemap: false, legalComments: "none",
    outdir: "/virtual", entryNames: "app", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [sveltePlugin({ compilerOptions: { runes: true, css: "external", dev: false }, cache: false, filterWarnings: (warning: { code: string }) => !warning.code.startsWith("a11y") })],
  });
  const js = result.outputFiles.find(file => file.path.endsWith(".js"));
  const css = result.outputFiles.find(file => file.path.endsWith(".css"));
  if (!js) throw new Error("Client bundle produced no app.js");
  return { js: js.contents, css: css?.contents ?? new Uint8Array() };
}

type Compiled = { ok: true; js: Asset; css: Asset } | { ok: false; error: string };

/** The worker's half: compile, then compress both assets there too, since brotli at quality 11 takes about a second for app.js. */
export async function compileAndPack(): Promise<{ js: Asset; css: Asset }> {
  const { js, css } = await compileClient();
  return { js: packAsset(asset(js, "text/javascript; charset=utf-8")), css: packAsset(asset(css, "text/css; charset=utf-8")) };
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
  const { js, css } = await compileAndPack();
  const draft = `${dir.replace(/\/+$/, "")}.${process.pid}.tmp`;
  await rm(draft, { recursive: true, force: true });
  await mkdir(draft, { recursive: true });
  for (const [stem, packed] of [["app.js", js], ["app.css", css]] as const) {
    const [body, br, gzip] = prebuiltFiles(stem);
    await writeFile(join(draft, body!), packed.body);
    await writeFile(join(draft, br!), packed.br!);
    await writeFile(join(draft, gzip!), packed.gzip!);
  }
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
    const [js, css] = await Promise.all([read("app.js", "text/javascript; charset=utf-8"), read("app.css", "text/css; charset=utf-8")]);
    return bundleOf(js, css);
  } catch { return null; }
}

const bundleOf = (js: Asset, css: Asset): ClientBundle => ({ js, css, version: createHash("sha256").update(js.etag + css.etag).digest("hex").slice(0, 16), app: appAsset });

/** The release's prebuilt bundle (`readPrebuilt`), else a compile in a worker thread (`chat-assets-worker.mjs`) so the server keeps answering. */
export async function buildClientBundle(dir = PREBUILT_DIR): Promise<ClientBundle> {
  return await readPrebuilt(dir) ?? await compileInWorker();
}

function compileInWorker(): Promise<ClientBundle> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./chat-assets-worker.mjs", import.meta.url));
    worker.once("message", (compiled: Compiled) => {
      void worker.terminate();
      if (!compiled.ok) { reject(new Error(compiled.error)); return; }
      resolve(bundleOf(revive(compiled.js), revive(compiled.css)));
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
