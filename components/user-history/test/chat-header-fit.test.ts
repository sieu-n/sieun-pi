// Guards the owner's 10-22 screenshot of the AI harness chat at 1280 px, where the path, "Check-in 1h" and "High" in the chat header ran over each other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The header's left half (ThreadTitle) and the controls (Chat) share one row. Items that cannot shrink ran past the left half and under the
 * controls. Now the left half clips what does not fit and keeps room for its title, the path ellipsizes, and the controls shrink through the
 * account's email while every other control keeps its size.
 */
const client = new URL("../src/client/", import.meta.url);
const styleOf = (name: string): string => (/<style>([\s\S]*)<\/style>/.exec(readFileSync(new URL(name, client), "utf8"))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
function rule(css: string, selector: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1]!.split(",").map(part => part.trim()).includes(selector));
  assert.ok(found, `no rule for ${selector}`);
  return found[2]!;
}
const prop = (body: string, name: string): string | undefined => new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

test("the header's left half clips its items and keeps room for the title", () => {
  const css = styleOf("ThreadTitle.svelte");
  const wrap = rule(css, ".title-wrap");
  assert.equal(prop(wrap, "overflow"), "hidden");
  assert.notEqual(prop(wrap, "min-width"), "0");
  const cwd = rule(css, ".cwd");
  assert.notEqual(prop(cwd, "flex"), "none");
  assert.equal(prop(cwd, "text-overflow"), "ellipsis");
});

test("the header controls shrink only through the account chip", () => {
  const css = styleOf("Chat.svelte");
  assert.notEqual(prop(rule(css, ".controls"), "flex"), "none");
  assert.equal(prop(rule(css, ".controls > :global(:not(.account))"), "flex"), "none");
  assert.equal(prop(rule(css, ".controls > :global(.account)"), "overflow"), "hidden");
});
