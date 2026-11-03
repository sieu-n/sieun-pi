/**
 * Slack parity of a post's text in web/src/lib/ui/markdown.ts, in node before DOMPurify.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/channel/post-parity.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../../web/src/lib/ui/markdown.ts";

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
