import assert from "node:assert/strict";
import { test } from "node:test";
import { bubbleBlocks, renderInline, renderMarkdown } from "../src/client/markdown.ts";
import { boardIndex, idClass } from "../src/client/board.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { diffLineKind, diffLines, readerAction, wikiBlocks } from "../src/client/reader.ts";
import { parseArtifactTarget } from "../src/shared/artifact-link.ts";

test("readerAction: a web URL opens a tab, a bare thread opens the thread, everything else opens the reader", () => {
  const action = (target: string) => readerAction(parseArtifactTarget(target)!, "chat1");
  assert.deepEqual(action("https://example.com/x"), { open: "tab", url: "https://example.com/x" });
  assert.deepEqual(action("thread:abc"), { open: "thread", sessionId: "abc" });
  assert.deepEqual(action("thread:abc@1700000000000"), { open: "reader", view: { kind: "message", thread: "abc", at: 1700000000000 } });
  assert.deepEqual(action("job:readme-check"), { open: "reader", view: { kind: "job", thread: "chat1", name: "readme-check" } });
  assert.deepEqual(action("wiki:sessions/a/report.html"), { open: "reader", view: { kind: "wiki", path: "sessions/a/report.html" } });
  assert.deepEqual(action("file:/Users/me/r.md"), { open: "reader", view: { kind: "file", path: "/Users/me/r.md" } });
});

test("diff lines: file headers before +/- lines, hunks, git metadata, context", () => {
  assert.deepEqual(diffLines("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file\n").map(line => line.kind),
    ["meta", "meta", "file", "file", "hunk", "context", "del", "add", "meta"]);
  assert.equal(diffLineKind("---"), "del", "a removed line of two dashes");
  assert.equal(diffLineKind("+++ b/README.md"), "file");
  assert.equal(diffLineKind("Binary files a/x and b/x differ"), "meta");
});

test("wiki blocks: a known heading becomes its own block even on the last line of a paragraph", () => {
  assert.deepEqual(wikiBlocks("Chats in sieun-pi\n\nA chat is a thread.\n1 · What it is\n\nAny thread.\nTwo lines.\n", ["Chats in sieun-pi", "1 · What it is"]), [
    { kind: "heading", text: "Chats in sieun-pi" }, { kind: "paragraph", text: "A chat is a thread." }, { kind: "heading", text: "1 · What it is" }, { kind: "paragraph", text: "Any thread.\nTwo lines." }]);
});

test("bubbleBlocks: lone images and diagram fences become cards, inline ones stay in the prose; an open fence is not closed", () => {
  const text = "Here it is.\n\n![shot](/tmp/a.png)\n\nSee ![icon](https://x/i.png) inline, then:\n\n```mermaid\ngraph TD; A-->B\n```\n\nDone.\n";
  const blocks = bubbleBlocks(text);
  assert.deepEqual(blocks.map(block => block.kind), ["prose", "image", "prose", "diagram", "prose"]);
  assert.equal(blocks[1]!.text, "![shot](/tmp/a.png)");
  assert.equal((blocks[3] as { closed: boolean }).closed, true);
  const open = bubbleBlocks("Drawing:\n\n```mermaid\ngraph TD; A-->B\n");
  assert.deepEqual(open.map(block => block.kind), ["prose", "diagram"]);
  assert.equal((open[1] as { closed: boolean }).closed, false);
  assert.deepEqual(bubbleBlocks("- a list\n- with `code`\n"), [{ kind: "prose", text: "- a list\n- with `code`\n" }]);
  assert.deepEqual(bubbleBlocks(""), []);
});

test("markdown links: artifact targets and chat permalinks become reader buttons, web links stay anchors", () => {
  assert.match(renderMarkdown("[report](job:readme-check)"), /<button type="button" class="artifact-link" data-target="job:readme-check"/);
  assert.match(renderMarkdown("[msg](thread:abc@12)"), /data-target="thread:abc@12"/);
  assert.match(renderMarkdown("[file](/Users/me/r.md)"), /data-target="file:\/Users\/me\/r.md"/);
  assert.match(renderMarkdown("[page](wiki:sessions/a)"), /data-target="wiki:sessions\/a"/);
  assert.match(renderMarkdown("[link](http://127.0.0.1:5182/cap/#01a11602-d8f5-722f-98b7-ebcf12104b7d@1791363653000)"), /data-target="thread:01a11602-d8f5-722f-98b7-ebcf12104b7d@1791363653000"/);
  assert.match(renderMarkdown("[web](https://example.com/a)"), /<a href="https:\/\/example.com\/a"[^>]*target="_blank"/);
  assert.match(renderMarkdown("[rel](docs/a.md)"), /<span class="path-link"/);
  assert.equal(renderInline("see `x` and **b**\nnext <b>raw</b>"), "see <code>x</code> and <strong>b</strong><br>next &lt;b&gt;raw&lt;/b&gt;");
});

test("board mentions: a whole-word id on the board becomes a chip in prose, lists, tables and bold; code, links, unknown ids and ids inside words stay text", () => {
  const board: ChatBoard = { v: 2, rev: 5, updatedAt: "", todos: [],
    plan: [{ id: "p1", text: "Goal one", status: "doing", children: [{ id: "p7", text: "Build: " + "x".repeat(80), status: "todo", children: [] }] }],
    scratch: [{ id: "s3", text: "Note three", links: [], at: "", children: [] }] };
  const index = boardIndex("chat-1", board)!;
  const chips = (html: string): string[] => [...html.matchAll(/data-mention="([^"]+)"/g)].map(match => match[1]!);
  const chip = (id: string) => `<button type="button" class="mention-chip ${idClass("chat-1", id)}" data-mention="${id}" title="${index.titles.get(id)}"><span class="dot" aria-hidden="true"></span>${id}</button>`;
  assert.equal(renderMarkdown("p7 is done, see s3 and p99.", "", index), `<p>${chip("p7")} is done, see ${chip("s3")} and p99.</p>\n`);
  assert.equal(index.titles.get("p7"), "Build: " + "x".repeat(52) + "\u2026", "a title is cut at 60 characters");
  assert.deepEqual(chips(renderMarkdown("- p7 in a list\n- **p1 bold** and *s3*\n\n| id | state |\n|---|---|\n| p7 | done |\n| s3 | ok |", "", index)), ["p7", "p1", "s3", "p7", "s3"]);
  assert.deepEqual(chips(renderMarkdown("`p7` in code, and\n```\np7 block\n```\n[p7 link](https://x.com/p7) https://x.com/p7 [p7](job:p7)", "", index)), [], "code spans, code blocks, link text and URLs keep their ids");
  assert.deepEqual(chips(renderMarkdown("xp7 sp7 p7a 3p7 p7's (p7) p7. ~~p7~~ p7: end", "", index)), ["p7", "p7", "p7", "p7", "p7"], "only whole words");
  assert.deepEqual(chips(renderInline("hi p7 and s3\nnext line p1", index)), ["p7", "s3", "p1"], "the owner's bubble gets chips too");
  assert.deepEqual(chips(renderMarkdown("p7 s3")), [], "no board, no chips");
  assert.deepEqual(chips(renderMarkdown("p7 s3", "", boardIndex("chat-1", { ...board, rev: 6, scratch: [] }))), ["p7"], "a new board rev renders again without the removed note");
  assert.equal(boardIndex("chat-1", null), null);
});
