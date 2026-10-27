// Guards owner rule c1 (owner 10-16, "stop using bold in your replies"): a chat reply renders no bold.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mentionIndex } from "../src/client/board.ts";
import { renderMarkdown } from "../src/client/markdown.ts";
import { renderSaid } from "../src/client/reply.ts";
import type { ChatBoard } from "../src/shared/types.ts";

/**
 * Owner, 10-16: "stop using bold in your replies, i read these on my phone and it's noisy". A chat message renders no bold markup, and no
 * stylesheet rule that reaches the conversation column or a report card sets a weight above 400.
 */
const client = new URL("../src/client/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, client), "utf8");
const styleOf = (svelte: string): string => /<style>([\s\S]*)<\/style>/.exec(svelte)?.[1] ?? "";

type Rule = { selectors: string[]; body: string };
function rules(css: string): Rule[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selectors: match[1]!.split(",").map(part => part.trim()).filter(Boolean), body: match[2]! }));
}
function heavy(body: string): boolean {
  const weight = /(?:^|[;\s])font-weight\s*:\s*([^;]+)/.exec(body)?.[1]?.trim();
  if (!weight) return false;
  return /^(bold|bolder)$/.test(weight) || Number(weight) > 400;
}
const subject = (selector: string): string => selector.replace(/:global\(([^)]*)\)/g, "$1").split(/[\s>+~]+/).at(-1)!;

const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Ship it", status: "doing", children: [] }] };
const index = mentionIndex("chat-1", board, ["w74"]);
const REPLY = [
  "# Heading one", "## Heading two", "###### Heading six",
  "Plain **bold words** and __more bold__, *italic* stays, `code` stays.",
  "See [the doc](https://example.com), wiki:sessions/a/b.html, job w74 and p1.",
  "- **lead** item", "",
  "| **a** | b |", "|---|---|", "| 1 | **2** |", "",
  "Raw <b>tag</b> and <strong>tag</strong>.",
].join("\n");

test("a chat reply renders no bold or heading markup and keeps italic, code, links and mentions", () => {
  const html = renderMarkdown(REPLY, "", index, true);
  assert.doesNotMatch(html, /<(strong|b|h[1-6])[\s>]/, html);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<p>Heading one<\/p>/);
  assert.match(html, /bold words/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.match(html, /data-target="wiki:sessions\/a\/b.html"/);
  assert.match(html, /data-mention="p1"/);
  assert.match(html, /data-job="w74"/);
  assert.match(renderMarkdown(REPLY), /<h1>Heading one<\/h1>[\s\S]*<strong>bold words<\/strong>/, "a page outside a chat keeps its markdown");
});

test("the owner's bubble and the reply quote in it render no bold", () => {
  assert.equal(renderSaid("> the chat said **this**\n\nok **do** it"), '<blockquote class="quote">the chat said this</blockquote>ok do it');
});

test("no stylesheet rule that reaches a chat message sets a weight above 400", () => {
  const html = renderMarkdown(REPLY, "", index, true) + renderSaid("> a **b**\n\nc p1", index);
  const tags = new Set([...html.matchAll(/<([a-z][a-z0-9]*)/g)].map(match => match[1]!));
  // The classes the rendered message carries, plus the containers a message renders into.
  const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1]!.split(/\s+/)).concat(["prose", "plain", "said", "bubble-prose", "card-prose", "reader-prose"]));
  const plain = rules(read("app.css")).filter(rule => !heavy(rule.body) && /font-weight/.test(rule.body)).flatMap(rule => rule.selectors).filter(selector => selector.startsWith(".prose.plain"));
  const reached = (selector: string): boolean => {
    const part = subject(selector);
    const tag = /^[a-z][a-z0-9]*/.exec(part)?.[0];
    const named = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]!);
    return (tag ? tags.has(tag) : /\./.test(part)) && named.every(name => classes.has(name));
  };
  const bold: string[] = [];
  for (const rule of rules(read("app.css")).filter(rule => heavy(rule.body))) {
    for (const selector of rule.selectors) {
      if (!reached(selector)) continue;
      if (selector.startsWith(".prose ") && plain.some(override => subject(override) === subject(selector))) continue;
      bold.push(`app.css ${selector}`);
    }
  }
  // Every class the chat's message feed draws, read from its markup.
  const chat = read("Chat.svelte");
  const feed = chat.slice(chat.indexOf("{#snippet actions"), chat.indexOf('<div class="foot">'));
  const feedClasses = new Set([...feed.matchAll(/class="([^"{]+)/g)].flatMap(match => match[1]!.trim().split(/\s+/)).concat([...feed.matchAll(/class:([\w-]+)/g)].map(match => match[1]!)));
  for (const rule of rules(styleOf(chat)).filter(rule => heavy(rule.body))) {
    for (const selector of rule.selectors) {
      if ([...subject(selector).matchAll(/\.([\w-]+)/g)].some(match => feedClasses.has(match[1]!))) bold.push(`Chat.svelte ${selector}`);
    }
  }
  for (const rule of rules(styleOf(read("ReportCard.svelte"))).filter(rule => heavy(rule.body))) bold.push(...rule.selectors.map(selector => `ReportCard.svelte ${selector}`));
  assert.deepEqual(bold, []);
});
