/**
 * Slack parity of a post's text in web/src/lib/ui/markdown.ts, in node before DOMPurify.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/channel/post-parity.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { previewLinks, renderMarkdown } from "../../web/src/lib/ui/markdown.ts";

test("a chat post keeps each line break, as Slack shows it, and a doc keeps markdown's soft wrap", () => {
  assert.match(renderMarkdown("line one\nline two", { plain: true }), /<p>line one<br>line two<\/p>/);
  assert.match(renderMarkdown("> quote one\n> quote two", { plain: true }), /quote one<br>quote two/);
  assert.match(renderMarkdown("line one\nline two"), /<p>line one\nline two<\/p>/);
});

test("a Slack emoji name renders as its emoji, and an unknown name, a time or a code span stays text", () => {
  const html = renderMarkdown("Done :white_check_mark: and :eyes:", { plain: true });
  assert.match(html, /<span class="emoji" title=":white_check_mark:">✅<\/span>/);
  assert.match(html, /<span class="emoji" title=":eyes:">👀<\/span>/);
  assert.match(renderMarkdown("at 10:30:45 and :not_an_emoji_name:"), /at 10:30:45 and :not_an_emoji_name:/);
  assert.match(renderMarkdown("`:eyes:`"), /<code>:eyes:<\/code>/);
});

test("a post previews each web link once, as Slack unfurls it, beside its wiki pages, and not one the text already draws", () => {
  const text = [
    "See https://svelte.dev/docs and [the docs](https://svelte.dev/docs#runes), plus wiki:a/b.html.",
    "Not https://github.com/sieu-n/sieun-pi/pull/12, https://example.com/shot.png, http://localhost:5180/x, https://h.ts.net:5184/#/c/dm_vent or `https://in.code/x`.",
    "```\nhttps://in.block/y\n```",
  ].join("\n\n");
  assert.deepEqual(previewLinks(text), [{ kind: "web", url: "https://svelte.dev/docs" }, { kind: "wiki", path: "a/b.html" }]);
});
