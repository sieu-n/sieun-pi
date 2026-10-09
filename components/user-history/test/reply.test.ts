import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCERPT_CHARS, plainLines, renderSaid, replyExcerpt, replyText, splitQuote } from "../src/client/reply.ts";

test("replyExcerpt strips markdown to the words a reader sees", () => {
  assert.equal(replyExcerpt("Hi **there**, see `a<b` & [the doc](https://x.y) ![shot](i.png) now"), "Hi there, see a<b & the doc shot now");
  assert.equal(replyExcerpt("# Done\n\n- one\n- two"), "Done\none two");
  assert.equal(replyExcerpt("| a | b |\n|---|---|\n| 1 | 2 |"), "a b 1 2");
  assert.equal(replyExcerpt("```js\nconst x = 1;\n```"), "const x = 1;");
  assert.equal(replyExcerpt("> already quoted\n\nreply"), "already quoted\nreply");
});

test("replyExcerpt keeps two lines and about 160 characters, with an ellipsis when it cut", () => {
  assert.equal(replyExcerpt("short"), "short");
  assert.equal(replyExcerpt("one\n\ntwo\n\nthree"), "one\ntwo\u2026");
  const long = Array.from({ length: 40 }, (_, index) => "word" + index).join(" ");
  const excerpt = replyExcerpt(long);
  assert.ok(excerpt.endsWith("\u2026"));
  assert.ok(excerpt.length <= EXCERPT_CHARS + 1, `${excerpt.length} characters`);
  assert.ok(!excerpt.slice(0, -1).endsWith(" "), "no space before the ellipsis");
  assert.match(excerpt, /word\d+\u2026$/, "cut on a word boundary");
  assert.equal(replyExcerpt("a".repeat(170)), "a".repeat(160) + "\u2026", "one long word cuts at the limit");
  assert.equal(replyExcerpt("   \n\n"), "");
  assert.deepEqual(plainLines("x\r\n\r\ny"), ["x", "y"]);
});

test("replyText sends the quote as > lines, a blank line, then the owner's text", () => {
  assert.equal(replyText("the chat said this", "and I answer"), "> the chat said this\n\nand I answer");
  assert.equal(replyText("line one\nline two\u2026", "ok"), "> line one\n> line two\u2026\n\nok");
  assert.equal(replyText(null, "plain"), "plain");
  assert.equal(replyText("", "plain"), "plain");
});

test("splitQuote reads a leading > block back out of the owner's message", () => {
  assert.deepEqual(splitQuote("> line one\n> line two\n\nmy answer\nsecond line"), { quote: "line one\nline two", body: "my answer\nsecond line" });
  assert.deepEqual(splitQuote(replyText("q", "a")), { quote: "q", body: "a" });
  assert.deepEqual(splitQuote(">bare\n\nx"), { quote: "bare", body: "x" });
  assert.deepEqual(splitQuote("> only a quote"), { quote: "only a quote", body: "" });
  assert.deepEqual(splitQuote("no quote\n> later"), { quote: null, body: "no quote\n> later" });
  assert.deepEqual(splitQuote(""), { quote: null, body: "" });
});

test("renderSaid draws a leading quote as a blockquote over the owner's text, and plain text as before", () => {
  assert.equal(renderSaid(replyText("the chat said **this**\nand that\u2026", "ok, do it")), '<blockquote class="quote">the chat said <strong>this</strong><br>and that\u2026</blockquote>ok, do it');
  assert.equal(renderSaid("> only the quote"), '<blockquote class="quote">only the quote</blockquote>');
  assert.equal(renderSaid("plain **words**\nnext"), "plain <strong>words</strong><br>next");
  assert.equal(renderSaid("a <b> tag"), "a &lt;b&gt; tag");
});
