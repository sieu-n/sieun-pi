/**
 * The chat web client draws every control from its one shared component set, web/src/lib/ui (owner rule c78, 2026-10-15: "PLEASE FOR THE
 * LOVE OF GOD USE CONSISTENT COMPONENTS", and 10-22: "in general i hate to see agent inventing the design system from scratch whenever
 * making new view"). lib/ui/README.md lists the parts. Until 10-28 only that README said so, and no check read the pages, while jobs built
 * the shell, Agents, Search, Board, Usage, Hosts and Settings pages from scratch in two days.
 *
 * A .svelte file outside lib/ui fails when its markup draws its own <select>, text field, checkbox, radio or <textarea>, or an element of its
 * own with a menu, list box, tab, radio group or dialog role. A role passed to a capitalised lib/ui part, such as NavItem's role="option", and
 * a selector string in a script are not drawn by the file. ALLOWED holds the real exceptions, each with its reason, and only shrinks.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "../../web/src");
const SHARED = "lib/ui/";

const ALLOWED: Record<string, string> = {
  "pages/search/SearchDialog.svelte":
    "The Cmd-K search results: a list box whose rows are lib/ui NavItems, kept under the search field's focus while the list moves, which Menu does not do.",
};

const CONTROL_ROLES = /^(?:menu|menubar|listbox|tablist|tab|radiogroup|radio|dialog|alertdialog)$/;
const TEXT_TYPES = new Set(["text", "email", "search", "url", "password", "number", "tel"]);

/** The file's markup, with its script and style blocks and its comments blanked out. */
const markupOf = (source: string): string =>
  source.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, " ");

/** Every control the file draws by hand, by kind; empty when it takes them all from lib/ui. */
function handMade(source: string): string[] {
  const markup = markupOf(source);
  const found = new Set<string>();
  if (/<select[\s>]/.test(markup)) found.add("<select>");
  if (/<textarea[\s>]/.test(markup)) found.add("<textarea>");
  for (const input of markup.matchAll(/<input\b((?:[^>{]|\{[^}]*\})*)>/g)) {
    const type = /(?:^|\s)type\s*=\s*["']([^"']*)["']/.exec(input[1] ?? "")?.[1];
    if (type === "checkbox" || type === "radio") found.add(`<input type="${type}">`);
    else if (type === undefined || TEXT_TYPES.has(type)) found.add("text <input>");
  }
  for (const tag of markup.matchAll(/<([a-z][\w-]*)\b((?:[^>{]|\{[^}]*\})*)>/g)) {
    const role = /(?:^|\s)role\s*=\s*\{?\s*["']([\w-]+)["']/.exec(tag[2] ?? "")?.[1];
    if (role && CONTROL_ROLES.test(role)) found.add(`its own role="${role}"`);
  }
  return [...found];
}

const pages = (readdirSync(SRC, { recursive: true }) as string[])
  .map(file => relative(SRC, join(SRC, file)).split("\\").join("/"))
  .filter(file => file.endsWith(".svelte") && !file.startsWith(SHARED))
  .sort();

test("finds the hand-made controls it guards", () => {
  assert.deepEqual(handMade('<select bind:value={v}></select>'), ["<select>"]);
  assert.deepEqual(handMade('<input bind:value={q} placeholder="Find" />'), ["text <input>"]);
  assert.deepEqual(handMade('<input type="checkbox" checked />'), ['<input type="checkbox">']);
  assert.deepEqual(handMade('<textarea rows="3"></textarea>'), ["<textarea>"]);
  assert.deepEqual(handMade('<div role="tablist"><button role="tab">Running</button></div>'), ['its own role="tablist"', 'its own role="tab"']);
  assert.deepEqual(handMade('<div class="pop" role="menu"></div>'), ['its own role="menu"']);
  assert.deepEqual(handMade('<div role="dialog" aria-modal="true"></div>'), ['its own role="dialog"']);
  assert.deepEqual(handMade('<NavItem role="option" label="a" /><Tabs items={x} bind:value={v} />'), []);
  assert.deepEqual(handMade('<script>document.querySelector(\'[role="dialog"], [role="menu"]\');</script><Button>Go</Button>'), []);
  assert.deepEqual(handMade('<input type="file" hidden /> <input type="range" /> <!-- <select></select> -->'), []);
});

test("reads the pages of the chat web client", () => {
  assert.ok(pages.length > 20, `only ${pages.length} pages under web/src outside lib/ui`);
  assert.ok(pages.some(file => file.startsWith("pages/")));
});

test("no page outside lib/ui draws its own menu, select, input, text area, tabs or dialog", () => {
  const bad = pages.filter(file => !ALLOWED[file])
    .map(file => [file, handMade(readFileSync(join(SRC, file), "utf8"))] as const)
    .filter(([, kinds]) => kinds.length > 0)
    .map(([file, kinds]) => `${file}: ${kinds.join(", ")}`);
  assert.deepEqual(bad, []);
});

test("keeps ALLOWED to files that still need the exception", () => {
  const stale = Object.keys(ALLOWED).filter(file => !pages.includes(file) || handMade(readFileSync(join(SRC, file), "utf8")).length === 0);
  assert.deepEqual(stale, []);
});
