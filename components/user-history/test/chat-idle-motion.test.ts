// The chat page costs no CPU while the owner only looks at it (10-18: the chat app's renderer sat at 28 to 46% on his Mac, idle).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Chromium runs a transform animation on the main thread, every frame, while the page has an IntersectionObserver, and
 * content-visibility: auto on the sidebar rows and turns counts as one. One turning spinner held 60 style recalcs a second and about 30%
 * renderer CPU. Opacity runs on the compositor alone, and visibility in steps changes twice a second, so a looping animation animates only those.
 */
const client = new URL("../src/client/", import.meta.url);
const files = readdirSync(client, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".svelte") || name.endsWith(".css"));
const cssOf = (name: string): string => {
  const text = readFileSync(new URL(name, client), "utf8");
  return (name.endsWith(".css") ? text : /<style>([\s\S]*)<\/style>/.exec(text)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
};

/** Each `@keyframes` body by name, read with brace counting because the body nests one block per step. */
function keyframes(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1, at = match.index + match[0].length;
    while (depth && at < css.length) depth += css[at] === "{" ? 1 : css[at] === "}" ? -1 : 0, at++;
    found.set(match[1]!, css.slice(match.index + match[0].length, at - 1));
  }
  return found;
}
const animated = (body: string): string[] => [...body.matchAll(/([\w-]+)\s*:/g)].map(match => match[1]!);
const LOOP_SAFE = new Set(["opacity", "visibility"]);

test("every looping animation in the chat client animates only opacity or visibility", () => {
  const all = new Map<string, string>();
  for (const name of files) for (const [frame, body] of keyframes(cssOf(name))) all.set(frame, body);
  const loops: string[] = [];
  for (const name of files) {
    for (const match of cssOf(name).matchAll(/animation(?:-name)?\s*:\s*([^;}]*infinite[^;}]*)/g)) {
      const frame = match[1]!.split(/\s+/).find(word => all.has(word));
      assert.ok(frame, `${name}: no @keyframes found for "${match[1]}"`);
      loops.push(frame);
      const props = animated(all.get(frame)!).filter(prop => !LOOP_SAFE.has(prop));
      assert.deepEqual(props, [], `${name}: the looping animation ${frame} animates ${props.join(", ")}`);
    }
  }
  assert.ok(loops.includes("pulse"), "the spinner loop was not found, so this test reads the wrong files");
});

test("the usage trace runs no animation on each update", () => {
  assert.doesNotMatch(cssOf("ThroughputLine.svelte"), /animation/);
});
