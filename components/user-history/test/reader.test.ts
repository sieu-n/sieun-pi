import assert from "node:assert/strict";
import { test } from "node:test";
import { bubbleBlocks, renderInline, renderMarkdown, reportExcerpt } from "../src/client/markdown.ts";
import { idClass, mentionIndex } from "../src/client/board.ts";
import type { ChatBoard } from "../src/shared/types.ts";
import { diffLineKind, diffLines, readerAction, reportWikiPage } from "../src/client/reader.ts";
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

test("reportWikiPage: the first .html or .md wiki page a report names, in any of the three link forms; data files and other wiki routes are not pages", () => {
  const report = "Done.\n\nReport: apps/llm-wiki/content/sessions/2026/10/08/1534-metal-ci-capacity-study-v2/report.html\n(http://localhost:5176/page/sessions/2026/10/08/1534-metal-ci-capacity-study-v2/report.html; it supersedes v1)";
  assert.equal(reportWikiPage(report), "sessions/2026/10/08/1534-metal-ci-capacity-study-v2/report.html");
  assert.equal(reportWikiPage("see wiki:sessions/a/b.md."), "sessions/a/b.md");
  assert.equal(reportWikiPage("[page](http://localhost:5176/page/sessions/a/report.html)"), "sessions/a/report.html");
  assert.equal(reportWikiPage("at /Users/me/Documents/Github/auto-sns-agent/apps/llm-wiki/content/sessions/a/index.html, then"), "sessions/a/index.html");
  assert.equal(reportWikiPage("`apps/llm-wiki/content/sessions/a/notes.md`"), "sessions/a/notes.md");
  assert.equal(reportWikiPage("data at http://localhost:5176/page/sessions/a/data.json and apps/llm-wiki/content/sessions/x.png"), null);
  assert.equal(reportWikiPage("http://localhost:5176/search?q=report.html"), null);
  assert.equal(reportWikiPage("xapps/llm-wiki/content/sessions/a.md and wiki:a/../b.md"), null);
  assert.equal(reportWikiPage("no link here"), null);
});

test("a structured job reply renders its headers, table and diagram block, in the reader's markdown and in the card's excerpt", () => {
  const reply = "Yes, with conditions.\n\n## Numbers\n\n| what | value |\n|---|---|\n| CPUs | 20.8 of 72 |\n| RAM | 61.8 GiB |\n\n## Flow\n\n```mermaid\nflowchart LR\n  a[job] --> b[report]\n```\n\nReport: wiki:sessions/a/report.html\n";
  const html = renderMarkdown(reply);
  assert.match(html, /<h2>Numbers<\/h2>/);
  assert.match(html, /<div class="table-wrap"><table>\n<thead>\n<tr>\n<th>what<\/th>\n<th>value<\/th>/);
  assert.match(html, /<td>20\.8 of 72<\/td>/);
  assert.match(html, /<div class="code-block diagram-block" data-diagram="mermaid">/, "the diagram block the sandboxed frame draws");
  assert.match(html, /<pre><code>flowchart LR\n  a\[job\] --&gt; b\[report\]<\/code><\/pre>/);
  const excerpt = reportExcerpt(reply, 12);
  assert.equal(excerpt.cut, false);
  const card = renderMarkdown(excerpt.text);
  assert.match(card, /<h2>Numbers<\/h2>/);
  assert.match(card, /<table>/);
  assert.match(card, /data-diagram="mermaid"/);
  assert.equal(reportWikiPage(reply), "sessions/a/report.html");
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
  const index = mentionIndex("chat-1", board)!;
  const chips = (html: string): string[] => [...html.matchAll(/data-mention="([^"]+)"/g)].map(match => match[1]!);
  const chip = (id: string) => `<button type="button" class="mention-chip ${idClass("chat-1", id)}" data-mention="${id}" title="${index.titles.get(id)}"><span class="dot" aria-hidden="true"></span>${id}</button>`;
  assert.equal(renderMarkdown("p7 is done, see s3 and p99.", "", index), `<p>${chip("p7")} is done, see ${chip("s3")} and p99.</p>\n`);
  assert.equal(index.titles.get("p7"), "Build: " + "x".repeat(52) + "\u2026", "a title is cut at 60 characters");
  assert.deepEqual(chips(renderMarkdown("- p7 in a list\n- **p1 bold** and *s3*\n\n| id | state |\n|---|---|\n| p7 | done |\n| s3 | ok |", "", index)), ["p7", "p1", "s3", "p7", "s3"]);
  assert.deepEqual(chips(renderMarkdown("`p7` in code, and\n```\np7 block\n```\n[p7 link](https://x.com/p7) https://x.com/p7 [p7](job:p7)", "", index)), [], "code spans, code blocks, link text and URLs keep their ids");
  assert.deepEqual(chips(renderMarkdown("xp7 sp7 p7a 3p7 p7's (p7) p7. ~~p7~~ p7: end", "", index)), ["p7", "p7", "p7", "p7", "p7"], "only whole words");
  assert.deepEqual(chips(renderInline("hi p7 and s3\nnext line p1", index)), ["p7", "s3", "p1"], "the owner's bubble gets chips too");
  assert.deepEqual(chips(renderMarkdown("p7 s3")), [], "no board, no chips");
  assert.deepEqual(chips(renderMarkdown("p7 s3", "", mentionIndex("chat-1", { ...board, rev: 6, scratch: [] }))), ["p7"], "a new board rev renders again without the removed note");
  assert.equal(mentionIndex("chat-1", null), null);
  assert.equal(mentionIndex("chat-1", null, []), null);
});

test("job mentions: a whole-word job name, bare or alone in a code span, becomes a bolt chip with the preview attributes; other code, links, parts of words and unknown names stay text", () => {
  const index = mentionIndex("chat-1", null, ["w20", "w20-preview", "api.reviewer", "", "x", "a\nb", "w20"])!;
  const chips = (html: string): string[] => [...html.matchAll(/data-job="([^"]+)"/g)].map(match => match[1]!);
  const html = renderMarkdown("Ask w20-preview, then w20.", "", index);
  assert.match(html, /<button type="button" class="mention-chip job-chip" data-job="w20-preview" data-preview-chat="chat-1" data-preview-job="w20-preview"><svg [^>]+><path d="[^"]+"\/><\/svg>w20-preview<\/button>, then /);
  assert.deepEqual(chips(html), ["w20-preview", "w20"], "the longest name wins where one starts another");
  assert.deepEqual(chips(renderMarkdown("api.reviewer and api-reviewer and apixreviewer", "", index)), ["api.reviewer"], "a dot in a name is literal");
  assert.deepEqual(chips(renderMarkdown("`w20 x` `w20-probe` in code\n```\nw20 block\n```\n[w20](https://x.com/w20) https://x.com/w20 xw20 w20x w20-probe w20s job:w20 (w20) w20's", "", index)), ["w20", "w20", "w20"], "code, links, words and hyphenated words keep the name");
  assert.equal(renderMarkdown("`w20` ran", "", index), renderMarkdown("w20 ran", "", index), "a code span that is one job name is the same chip");
  assert.deepEqual(chips(renderMarkdown("`w20` and `w20-preview` and `api.reviewer`", "", index)), ["w20", "w20-preview", "api.reviewer"]);
  assert.match(renderMarkdown("`w20`"), /<code>w20<\/code>/, "no index: the code span stays code");
  assert.deepEqual(chips(renderInline("w20 said so", index)), ["w20"], "the owner's bubble gets job chips too");
  assert.deepEqual(chips(renderMarkdown("w20 and x", "", mentionIndex("chat-1", null, ["x"]))), [], "a one-letter name is never a chip; an unknown name stays text");
  assert.deepEqual(chips(renderMarkdown("w20")), [], "no index, no chips");
  assert.equal(mentionIndex("chat-1", null, ["w20"])!.titles.size, 0);
  assert.notEqual(mentionIndex("chat-1", null, ["w20"])!.key, mentionIndex("chat-1", null, ["w20", "w21"])!.key, "a new job changes the cache key");
  assert.match(renderMarkdown("[report](job:w20)", "", index), /class="artifact-link" data-target="job:w20" data-preview-chat="chat-1" data-preview-job="w20"/, "a job link carries the preview too");
  assert.doesNotMatch(renderMarkdown("[report](job:w20)"), /data-preview/, "no index, no preview on a link");
});

test("reportExcerpt keeps the first 12 blocks whole (a fence or a table is one block) and says whether more followed", () => {
  const fence = "```mermaid\ngraph TD; A-->B\n```";
  const text = "# Title\n\nOne.\n\n" + fence + "\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n- x\n- y\n";
  assert.deepEqual(reportExcerpt(text), { text: "# Title\n\nOne.\n\n" + fence + "\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n- x\n- y", cut: false });
  assert.deepEqual(reportExcerpt(text, 3), { text: "# Title\n\nOne.\n\n" + fence, cut: true });
  assert.deepEqual(reportExcerpt(text, 4).text.split("\n\n").length, 4);
  const paragraphs = Array.from({ length: 20 }, (_, index) => "p" + index).join("\n\n");
  const cut = reportExcerpt(paragraphs);
  assert.equal(cut.cut, true);
  assert.equal(cut.text.split("\n\n").length, 12);
  assert.deepEqual(reportExcerpt(""), { text: "", cut: false });
  assert.equal(reportExcerpt("Files:\n\n    apps/x.ts  the route\n    apps/y.ts  the lib\n\nDone.", 2).text, "Files:\n\n    apps/x.ts  the route\n    apps/y.ts  the lib", "an indented code block keeps its indent");
  assert.match(renderMarkdown(reportExcerpt(text, 3).text), /diagram-block/, "the cut text still renders the fence as a diagram");
});
