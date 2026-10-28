// Guards the d7 dirty minute at 01:01Z on 10-28: the chat answered api/wiki-page in 2.1 s under job-rig load while its event loop stayed
// under 0.3 s, because it waited on the wiki dev server's page object. When this box holds the wiki role, the page comes from its file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWikiPage } from "../src/chat-wiki.ts";

const PAGE = '<!--wiki {"title":"Fleet findings"}-->\n<h1>Fleet findings</h1>\n<p>body</p>\n';

function contentDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-wiki-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "apps/crawler"), { recursive: true });
  writeFileSync(join(dir, "apps/crawler/fleet.html"), PAGE);
  return dir;
}

/** A wiki server that answers only when its caller gives up, as the dev server did under load; it records each URL asked. */
function stalledWiki(asked: string[]): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    asked.push(url);
    return new Promise((_, fail) => init?.signal?.addEventListener("abort", () => fail(new Error("aborted"))));
  }) as unknown as typeof fetch;
}

test("a page on the box that holds the wiki role comes from its file without waiting on the wiki server, which still gets the view", async t => {
  const asked: string[] = [];
  const started = performance.now();
  const view = await readWikiPage("apps/crawler/fleet.html", stalledWiki(asked), "http://wiki.test:5176", contentDir(t), true);
  const took = performance.now() - started;
  assert.ok(took < 1000, `took ${Math.round(took)} ms`);
  assert.equal(view.kind, "html");
  assert.equal(view.kind === "html" ? view.html : "", PAGE);
  assert.equal(view.title, "Fleet findings");
  assert.equal(view.url, "http://wiki.test:5176/page/apps/crawler/fleet.html");
  assert.deepEqual(asked, ["http://wiki.test:5176/api/agent/page?path=apps%2Fcrawler%2Ffleet.html"]);
});

test("a path with no file of its own on the wiki box goes through the wiki server's answer", async t => {
  const answer = { title: "Apps", content: "<h1>Apps</h1>" };
  const wiki = (async () => new Response(JSON.stringify(answer), { status: 200 })) as unknown as typeof fetch;
  const view = await readWikiPage("apps/index.html", wiki, "http://wiki.test:5176", contentDir(t), true);
  assert.equal(view.kind === "html" ? view.html : "", "<h1>Apps</h1>");
  assert.equal(view.title, "Apps");
});

test("a box without the wiki role still reads the page through the wiki server", async t => {
  const asked: string[] = [];
  const wiki = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ title: "Remote", content: "<h1>Remote</h1>" })); }) as unknown as typeof fetch;
  const view = await readWikiPage("apps/crawler/fleet.html", wiki, "http://wiki.test:5176", contentDir(t), false);
  assert.equal(view.kind === "html" ? view.html : "", "<h1>Remote</h1>");
  assert.equal(asked.length, 1);
});
