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

/**
 * Files that read Enter where no IME composes: a key on a button, card or tree row, a Cmd or Ctrl+Enter shortcut, which the IME guide exempts,
 * or Enter only named in a comment.
 */
const NO_TEXT_ENTER = new Map([
  ["lib/api/held-sends.ts", "names Enter in a comment"],
  ["lib/shell/wiki-page.ts", "Cmd or Ctrl+Enter saves"],
  ["lib/ui/NavItem.svelte", "Enter on the item itself, not a field"],
  ["pages/agents/AgentCard.svelte", "Enter on the card itself, not a field"],
  ["pages/board/DutyDialog.svelte", "Cmd or Ctrl+Enter saves"],
  ["pages/skills/layouts/tree/TreeLayout.svelte", "Enter on a tree row"],
]);

test("every file with an Enter key handler checks composing(), so Enter in Find members cannot open a member mid-syllable again (fable check 11-24)", () => {
  const unguarded = sources(SRC)
    .map((path) => [relative(SRC, path).split("\\").join("/"), readFileSync(path, "utf8")] as const)
    .filter(([path, text]) => /key\s*[!=]==\s*"Enter"|\bEnter:|case "Enter"/.test(text) && !/\bcomposing\(/.test(text) && !NO_TEXT_ENTER.has(path))
    .map(([path]) => path);
  assert.deepEqual(unguarded, []);
});

test("every key handler reads composition through composing(), so none misses the WebKit keyCode 229 Enter (fable check 11-24)", () => {
  const bare = sources(SRC)
    .filter((path) => !path.endsWith(join("lib", "ui", "keyboard.ts")))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").flatMap((line, i) => (/\.isComposing\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [])));
  assert.deepEqual(bare, []);
});
