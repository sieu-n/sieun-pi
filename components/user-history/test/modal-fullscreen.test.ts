import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import esbuildSvelte from "esbuild-svelte";
import { ICON_PATHS } from "../src/client/icons.ts";

const sveltePlugin = typeof esbuildSvelte === "function" ? esbuildSvelte : esbuildSvelte.default;

type ModalProps = { full?: boolean; maximizable?: boolean };

/** Modal.svelte rendered on the server, so the test reads the header the browser gets on first paint. */
async function modalRenderer(): Promise<(props: ModalProps) => string> {
  const entry = `import { render } from "svelte/server";
import { createRawSnippet } from "svelte";
import Modal from "./src/client/Modal.svelte";
export const html = props => render(Modal, { props: { title: "Page", onclose() {}, children: createRawSnippet(() => ({ render: () => "<p>body</p>" })), ...props } }).body;`;
  const result = await build({
    stdin: { contents: entry, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "js" },
    bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
    plugins: [sveltePlugin({ compilerOptions: { runes: true, generate: "server", css: "injected" }, cache: false, filterWarnings: (warning: { code: string }) => !warning.code.startsWith("a11y") })],
  });
  const code = result.outputFiles[0]!.text;
  const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64")) as { html: (props: ModalProps) => string };
  return module.html;
}

const buttons = (html: string): string[] => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(match => match[1]!);

test("modal: a maximizable modal shows Full screen beside Close, drawn with the shared icons; a full one and a plain one show Close alone", async () => {
  const html = await modalRenderer();
  const reader = html({ maximizable: true });
  assert.deepEqual(buttons(reader), ["Full screen", "Close"]);
  assert.match(reader, /aria-pressed="false"/);
  assert.ok(reader.includes(`d="${ICON_PATHS.expandBox}"`), "the toggle draws the expandBox icon while the modal is windowed");
  assert.ok(reader.includes(`d="${ICON_PATHS.x}"`), "Close draws the shared x icon");
  assert.doesNotMatch(reader, /<dialog[^>]*class="[^"]*\bfull\b/);
  assert.deepEqual(buttons(html({ maximizable: true, full: true })), ["Close"], "a phone already fills the window, so it has no toggle");
  assert.deepEqual(buttons(html({})), ["Close"]);
});
