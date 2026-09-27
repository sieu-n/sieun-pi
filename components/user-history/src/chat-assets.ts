import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";

const sveltePlugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;

export interface Asset { body: Buffer; etag: string; contentType: string }
/** `version` names this build; the page carries it and the sessions stream reports it, so an open tab sees a restart onto new code. */
export interface ClientBundle { js: Asset; css: Asset; version: string }

function asset(body: Uint8Array, contentType: string): Asset {
  const buffer = Buffer.from(body);
  return { body: buffer, etag: '"' + createHash("sha256").update(buffer).digest("hex").slice(0, 32) + '"', contentType };
}

export async function buildClientBundle(): Promise<ClientBundle> {
  const entry = fileURLToPath(new URL("./client/main.ts", import.meta.url));
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", target: "es2022", minify: true, sourcemap: false, legalComments: "none",
    outdir: "/virtual", entryNames: "app", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [sveltePlugin({ compilerOptions: { runes: true, css: "external", dev: false }, cache: false, filterWarnings: (warning: { code: string }) => !warning.code.startsWith("a11y") })],
  });
  const js = result.outputFiles.find(file => file.path.endsWith(".js"));
  const css = result.outputFiles.find(file => file.path.endsWith(".css"));
  if (!js) throw new Error("Client bundle produced no app.js");
  const script = asset(js.contents, "text/javascript; charset=utf-8");
  const style = asset(css?.contents ?? new Uint8Array(), "text/css; charset=utf-8");
  const version = createHash("sha256").update(script.etag + style.etag).digest("hex").slice(0, 16);
  return { js: script, css: style, version };
}
