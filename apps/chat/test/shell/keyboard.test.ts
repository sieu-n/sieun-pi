import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composing } from "../../web/src/lib/ui/keyboard.ts";

const SRC = fileURLToPath(new URL("../../web/src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(svelte|ts)$/.test(entry.name) ? [path] : [];
  });
}

test("an IME keydown counts as composing also when WebKit has already cleared isComposing", () => {
  assert.equal(composing({ isComposing: true, keyCode: 13 }), true);
  assert.equal(composing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(composing({ isComposing: false, keyCode: 13 }), false);
});

test("every key handler reads composition through composing(), so none misses the WebKit keyCode 229 Enter (fable check 11-24)", () => {
  const bare = sources(SRC)
    .filter((path) => !path.endsWith(join("lib", "ui", "keyboard.ts")))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").flatMap((line, i) => (/\.isComposing\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [])));
  assert.deepEqual(bare, []);
});
