import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { iconPng } from "./chat-icon.ts";

const sveltePlugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;

export interface Asset { body: Buffer; etag: string; contentType: string }
/**
 * `version` names this build; the page carries it and the sessions stream reports it, so an open tab sees a restart onto new code.
 * `app` returns the installable-app file for a route under the capability path (manifest and icons), or undefined.
 */
export interface ClientBundle { js: Asset; css: Asset; version: string; app?: (route: string) => Asset | undefined }

export function asset(body: Uint8Array, contentType: string): Asset {
  const buffer = Buffer.from(body);
  return { body: buffer, etag: '"' + createHash("sha256").update(buffer).digest("hex").slice(0, 32) + '"', contentType };
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

type Compiled = { ok: true; js: Uint8Array; css: Uint8Array } | { ok: false; error: string };

/** The client bundle, compiled in a worker thread (`chat-assets-worker.mjs`) so the server keeps answering while it builds. */
export function buildClientBundle(): Promise<ClientBundle> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./chat-assets-worker.mjs", import.meta.url));
    worker.once("message", (compiled: Compiled) => {
      void worker.terminate();
      if (!compiled.ok) { reject(new Error(compiled.error)); return; }
      const script = asset(compiled.js, "text/javascript; charset=utf-8");
      const style = asset(compiled.css, "text/css; charset=utf-8");
      resolve({ js: script, css: style, version: createHash("sha256").update(script.etag + style.etag).digest("hex").slice(0, 16), app: appAsset });
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
