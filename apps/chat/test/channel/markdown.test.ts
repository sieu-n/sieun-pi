/**
 * web/src/lib/ui/markdown.ts in node: the HTML the renderer writes before DOMPurify (which needs a window and runs in the browser specs).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/channel/markdown.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_FOLD_LINES, renderInline, renderMarkdown, wikiLinkPath, wikiPages, withAuthor } from "../../web/src/lib/ui/markdown.ts";
import { readable } from "../../web/src/lib/ui/mermaid.ts";

const board = { chatId: "vent", titles: new Map([["p2", "Watch the week"]]) };

test("GitHub callouts become styled notes without their marker, and a plain quote stays a quote", () => {
  const html = renderMarkdown("> [!WARNING]\n> The deploy needs your ok.\n\n> [!note]\n> Lower case works.\n\n> Just a quote.");
  assert.match(html, /<div class="callout callout-warning" role="note" data-callout="warning"><p class="callout-title"><svg[^>]*>.*<\/svg>Warning<\/p><p>The deploy needs your ok\.<\/p>/s);
  assert.match(html, /callout-note.*Note<\/p><p>Lower case works\./s);
  assert.doesNotMatch(html, /\[!/);
  assert.match(html, /<blockquote>\n<p>Just a quote\.<\/p>/);
});

test("mermaid blocks get a slot, a hidden source, an error line and the Expand, Source and Copy buttons", () => {
  const html = renderMarkdown("```mermaid\nflowchart TD\n  a --> b\n```");
  assert.match(html, /class="code-block diagram-block" data-diagram="mermaid"/);
  for (const part of ["data-diagram-expand", "data-diagram-toggle", "data-copy", '<p class="diagram-error" hidden>', '<div class="diagram-slot">', "<pre hidden>"]) assert.ok(html.includes(part), part);
  assert.ok(html.includes("a --&gt; b"));
});

test("code blocks carry a language label and a copy button, and fold past the line limit", () => {
  const short = renderMarkdown("```ts\nconst a = 1;\n```");
  assert.match(short, /<span class="code-lang">ts<\/span>.*data-copy/s);
  assert.doesNotMatch(short, /folded|data-expand/);
  assert.match(renderMarkdown("```\nplain\n```"), /<span class="code-lang">text<\/span>/);
  const lines = CODE_FOLD_LINES + 4;
  const long = renderMarkdown("```sh\n" + Array.from({ length: lines }, (_, i) => `echo ${i}`).join("\n") + "\n```");
  assert.match(long, /class="code-block folded"/);
  assert.ok(long.includes(`data-lines="${lines}" aria-expanded="false">Show all ${lines} lines</button>`));
});

test("task lists render read-only checkboxes on task items", () => {
  const html = renderMarkdown("- [x] Done step.\n- [ ] Open step.");
  assert.match(html, /<li class="task-item done"><input type="checkbox" disabled checked> Done step\.<\/li>/);
  assert.match(html, /<li class="task-item"><input type="checkbox" disabled> Open step\.<\/li>/);
});

test("details and summary survive, and every other raw tag shows as text", () => {
  const html = renderMarkdown("<details><summary>Log, 3 lines</summary>\n\n```\na\n```\n\n</details>\n\nA <script>alert(1)</script> and <img src=x onerror=alert(1)> and a <br/> break.");
  assert.match(html, /^<details><summary>Log, 3 lines<\/summary><div class="code-block">/);
  assert.match(html, /<\/details>/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("a <br> break"));
});

test("tables sit in a scroll wrapper", () => {
  assert.match(renderMarkdown("| a | b |\n| --- | ---: |\n| 1 | 2 |"), /<div class="table-wrap"><table>.*<td align="right">2<\/td>.*<\/table><\/div>/s);
});

test("file paths in code spans and in text become pills that copy, and other code spans stay code", () => {
  const html = renderMarkdown("See `apps/chat/server/http.ts:42`, `markdown.ts:10` and web/src/lib/ui/prose.css, but not `npm test` or `a/b`.");
  assert.match(html, /<a class="artifact-link file-link path-pill" data-target="file:apps\/chat\/server\/http\.ts:42"[^>]*><svg[^>]*>.*?<\/svg><span class="link-text">apps\/chat\/server\/http\.ts:42<\/span><\/a>/);
  assert.ok(html.includes('data-target="file:markdown.ts:10"'));
  assert.ok(html.includes('data-target="file:web/src/lib/ui/prose.css"'), "a bare path in text, without the trailing comma");
  assert.ok(html.includes("<code>npm test</code>"));
  assert.ok(html.includes("<code>a/b</code>"));
  assert.doesNotMatch(renderMarkdown("Open https://example.com/a/b.ts now."), /path-pill/, "a URL is no path");
});

test("thread, job and wiki links are pills, and board ids the board knows are chips", () => {
  const html = renderMarkdown("Read thread:0f1e0000-0000-4000-8000-000000000001:14, job:check-ci, [the job](job:Read the logs), wiki:sessions/a.md and p2, not p9.", { board });
  assert.ok(html.includes('data-target="thread:0f1e0000-0000-4000-8000-000000000001:14"'));
  assert.ok(html.includes('<span class="link-text">thread 0f1e0000:14</span>'));
  assert.ok(html.includes('data-target="job:check-ci"'));
  assert.ok(html.includes('data-target="job:Read the logs"'));
  assert.ok(html.includes('class="artifact-link wiki-link" data-target="wiki:sessions/a.md"'));
  assert.ok(html.includes('data-board-id="p2"'));
  assert.doesNotMatch(html, /data-board-id="p9"/);
});

test("GitHub pull requests, issues and commits are cards, with the link text as the title", () => {
  const html = renderInline("[Fold long code](https://github.com/sieu-n/sieun-pi/pull/42) and https://github.com/sieu-n/sieun-pi/issues/7 and [the fix](https://github.com/sieu-n/sieun-pi/commit/51e88622a1b2c3d4)");
  assert.match(html, /<a class="gh-card" data-gh="pull" href="https:\/\/github\.com\/sieu-n\/sieun-pi\/pull\/42"[^>]*>.*<span class="gh-repo">sieu-n\/sieun-pi<\/span><span class="gh-ref">#42<\/span><span class="gh-title">Fold long code<\/span><\/a>/s);
  assert.match(html, /data-gh="issues".*<span class="gh-ref">#7<\/span><\/a>/s);
  assert.match(html, /data-gh="commit".*<span class="gh-ref">51e8862<\/span><span class="gh-title">the fix<\/span>/s);
});

test("web links carry the site icon and the domain, a bare URL shows host and path, and an image URL embeds", () => {
  const html = renderInline("[Vite guide](https://vite.dev/guide/) and https://example.com/a/b?c=1 and https://example.com/shot.png");
  assert.match(html, /<a class="web-link" href="https:\/\/vite\.dev\/guide\/"[^>]*><img class="favicon" src="https:\/\/vite\.dev\/favicon\.ico"[^>]*><span class="link-text">Vite guide<\/span><span class="link-domain">vite\.dev<\/span><\/a>/);
  assert.match(html, /<span class="link-text">example\.com\/a\/b\?c=1<\/span><\/a>/);
  assert.match(html, /<img class="md-image" src="https:\/\/example\.com\/shot\.png"/);
  assert.doesNotMatch(renderInline("[vite.dev docs](https://vite.dev/)"), /link-domain/, "no domain when the text names it");
});

test("a local screenshot path loads through /api/local-image", () => {
  assert.match(renderMarkdown("![Board panel](/tmp/shot.png)"), /<img class="md-image" src="\/api\/local-image\?path=%2Ftmp%2Fshot\.png" alt="Board panel"/);
});

test("a wide diagram keeps 80% of its drawn width before it scrolls", () => {
  assert.equal(readable('<svg id="m" width="100%" style="max-width: 1000px;" viewBox="0 0 1000 200">'), '<svg id="m" width="100%" style="max-width: 1000px; min-width: min(800px, 1000px);" viewBox="0 0 1000 200">');
});

test("a mention chip takes the longest known name, commas, spaces and a trailing dot included", () => {
  const mentions = new Map([
    ["search product, misc.", { id: "ag_search-product-misc", kind: "agent" as const }],
    ["search", { id: "ag_search", kind: "agent" as const }],
    ["vent", { id: "ag_vent", kind: "agent" as const }],
  ]);
  const html = renderMarkdown("@Search product, misc. research the auth stack, then ask @Vent. Not @Ventura or @Searching.", { mentions });
  assert.match(html, /data-mention-id="ag_search-product-misc">.*<span class="text">Search product, misc\.<\/span><\/button> research/s);
  assert.match(html, /data-mention-id="ag_vent">.*<span class="text">Vent<\/span><\/button>\. Not @Ventura or @Searching\./s);
  assert.equal(html.match(/data-mention-id/g)?.length, 2);
});

test("every wiki form a chat writes names the page's content path, and a content-folder path is a wiki link", () => {
  for (const form of ["domains/x.html", "/domains/x.html", "page/domains/x.html", "wiki/page/domains/x.html", "host.ts.net:5176/page/domains/x.html#top", "https://h.ts.net:5176/page/domains/x.html", "https://h.ts.net:5184/wiki/domains/x.html?q=1"]) {
    assert.equal(wikiLinkPath(form), "domains/x.html", form);
  }
  assert.equal(wikiLinkPath("https://example.com/domains/x.html"), null);
  assert.equal(wikiLinkPath("../etc/passwd"), null);
  const html = renderMarkdown("[page](wiki:https://h.ts.net:5176/page/domains/x.html), apps/llm-wiki/content/domains/y.html and ~/.pi/wiki/content/domains/z.html");
  for (const page of ["x", "y", "z"]) assert.ok(html.includes(`data-target="wiki:domains/${page}.html"`), page);
});

test("a code span that is one target or one job name is its link, and bare absolute paths are pills or images", () => {
  const html = renderMarkdown("`wiki:a/b.html`, `thread:abc-1`, `job:x`, `fast search` and `npm test`; /home/sieun/work/post-parity/ and ~/work/x, /tmp/shot.png, but not and/or or /s.", { jobs: ["fast search"] });
  for (const target of ["wiki:a/b.html", "thread:abc-1", "job:x", "job:fast search", "file:/home/sieun/work/post-parity/", "file:~/work/x"]) assert.ok(html.includes(`data-target="${target}"`), target);
  assert.ok(html.includes("<code>npm test</code>"));
  assert.match(html, /<img class="md-image thumb" src="\/api\/local-image\?path=%2Ftmp%2Fshot\.png"/);
  assert.ok(html.includes("but not and/or or /s."));
});

test("a job named as a whole word is a job link, but not inside a word, a hyphenated word, quotes or a link", () => {
  const html = renderMarkdown('Ask fast search, then fast-search-x, "fast search", [fast search](https://e.com) and xfast search.', { jobs: ["fast", "fast search"] });
  assert.equal(html.match(/data-target="job:fast search"/g)?.length, 1);
  assert.doesNotMatch(html, /data-target="job:fast"/);
});

test("loopback links keep their port and draw a server icon, not a favicon, and links into this app open in place", () => {
  const html = renderMarkdown("Open localhost:5180/campaigns and http://127.0.0.1:8080/x.", { plain: true });
  assert.match(html, /<a class="web-link local-link" href="http:\/\/localhost:5180\/campaigns"[^>]*><svg[^>]*>.*?<\/svg><span class="link-text">localhost:5180\/campaigns<\/span><\/a>/);
  assert.ok(html.includes('href="http://127.0.0.1:8080/x"'));
  assert.doesNotMatch(html, /favicon/);
  const mentions = new Map([["vent-dev", { id: "ch_181e61a3", kind: "channel" as const }], ["vent", { id: "ag_vent", kind: "agent" as const }]]);
  const app = renderMarkdown("https://h.ts.net:5184/#/c/ch_181e61a3 and https://h.ts.net:5184/#/c/dm_vent", { mentions });
  assert.match(app, /<a class="artifact-link app-link" href="#\/c\/ch_181e61a3"[^>]*>.*<span class="link-text">#vent-dev<\/span>/);
  assert.match(app, /href="#\/c\/dm_vent"[^>]*>.*?<span class="link-text">vent<\/span>/);
  assert.doesNotMatch(app, /target="_blank"/);
});

test("a post's board ids and job names resolve against its author's board and jobs", () => {
  const room = { board, jobs: ["room job"], authors: new Map([["ag_other", { board: { chatId: "other", titles: new Map([["p9", "Other step"]]) }, jobs: ["other job"] }]]) };
  const own = renderMarkdown("p9, p2, other job and room job", withAuthor(room, "ag_other"));
  assert.ok(own.includes('data-board-id="p9" data-chat-id="other"'));
  assert.doesNotMatch(own, /data-board-id="p2"/);
  assert.ok(own.includes('data-target="job:other job"'));
  assert.doesNotMatch(own, /job:room job/);
  assert.equal(withAuthor(room, "owner"), room);
});

test("wikiPages lists each linked page once, with no images and no other targets", () => {
  assert.deepEqual(
    wikiPages("wiki:a/b.html and [x](wiki:a/b.html), [[c/d.md]], https://h:5184/wiki/e.html ![i](wiki:f.png) `apps/llm-wiki/content/g.html` ~/.pi/wiki/content/h.html [j](job:x)"),
    ["a/b.html", "c/d.md", "e.html", "g.html", "h.html"],
  );
  assert.deepEqual(wikiPages("no pages here"), []);
});
