/**
 * The /wiki surface and the job workspace routes (server/wiki) against the wiki engine this box runs on 127.0.0.1:5176, one case per user
 * path: read a page as HTML, markdown or stored HTML, reach an engine route through /wiki, and write pages into a session folder the job
 * opens and closes itself. Step p1374, owner 11-03: "Accessed & write via api of 5184/wiki/X?".
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/wiki.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readConfig } from "../../server/config.ts";
import { FIXTURE_IDS } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

const engine = readConfig([]).wikiEngine;
const engineUp = await fetch(`${engine.origin}${engine.base}/api/agent/health`).then(r => r.ok, () => false);
const skip = engineUp ? false : `no wiki engine answers at ${engine.origin}`;
const HUB = "apps/search/index.html";

let server: Running;
let job: string;

before(async () => {
  if (!engineUp) return;
  server = await start();
  const node = server.app.threads.tree(FIXTURE_IDS.vent).find(n => n.parent === 1)!;
  job = `${FIXTURE_IDS.vent}:${node.id}`;
});

after(async () => {
  await server?.close();
});

test("GET /wiki/<path> renders the engine's page, with its links routed back under /wiki", { skip }, async () => {
  const response = await fetch(`${server.base}/wiki/${HUB}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /<title>search · virev\.ai/);
  if (!engine.base) assert.ok(html.includes('href="/wiki/timeline"') && !html.includes('href="/timeline"'));
});

test("?format=md and Accept: text/markdown answer markdown with the frontmatter as a YAML header", { skip }, async () => {
  const md = await (await fetch(`${server.base}/wiki/${HUB}?format=md`)).text();
  assert.match(md, /^---\npath: "apps\/search\/index\.html"\nversion: \d+\ntitle: "search · virev\.ai"\n/);
  assert.match(md, /\n---\n\n# search · virev\.ai\n/);
  assert.doesNotMatch(md, /<!--wiki/);
  const negotiated = await fetch(`${server.base}/wiki/${HUB}`, { headers: { accept: "text/markdown" } });
  assert.match(negotiated.headers.get("content-type") ?? "", /text\/markdown/);
  assert.equal(await negotiated.text(), md);
});

test("?format=html answers the stored page with its frontmatter comment", { skip }, async () => {
  const response = await fetch(`${server.base}/wiki/${HUB}?format=html`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^<!--wiki \{/);
  assert.equal((await fetch(`${server.base}/wiki/apps/search/no-such-page.html?format=md`)).status, 404);
});

test("an engine route under /wiki passes through to the engine", { skip }, async () => {
  const health = await server.get<{ ok: boolean; pageCount: number }>("/wiki/api/agent/health");
  assert.equal(health.ok, true);
  assert.ok(health.pageCount > 0);
});

test("a job opens its workspace, writes, edits and closes it, and every write names the job", { skip }, async () => {
  const opened = await server.send("POST", `/api/c/${job}/workspace`, { slug: "apps-chat-wiki-test", goal: "Check the /wiki routes of apps/chat end to end.", tags: ["test"] });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.conversation, job);
  assert.equal(opened.body.agent, "ag_vent");
  assert.equal(opened.body.opened, true);
  const folder: string = opened.body.id;
  const again = await server.send("POST", `/api/c/${job}/workspace`, {});
  assert.deepEqual([again.status, again.body.id, again.body.opened], [200, folder, false]);
  const log = await (await fetch(`${server.base}/wiki/${folder}/index.html?format=html`)).text();
  assert.match(log, /"agent": ?"vent"/);

  const as = { "x-pi-conversation": job };
  const page = `${folder}/notes.html`;
  const put = await fetch(`${server.base}/wiki/${page}`, {
    method: "PUT", headers: { ...as, "content-type": "text/markdown" },
    body: "---\ntitle: \"Wiki route notes\"\nkind: \"note\"\n---\n\n# Wiki route notes\n\nThe chat server wrote this page through its wiki routes.\n",
  });
  const written = await put.json() as { version: number; author: string };
  assert.equal(put.status, 201, JSON.stringify(written));
  assert.equal(written.author, `vent (${job})`);
  const stored = await (await fetch(`${server.base}/wiki/${page}?format=html`)).text();
  assert.match(stored, /^<!--wiki \{"title":"Wiki route notes","kind":"note"\} -->\n<h1>Wiki route notes<\/h1>/);

  const create = await fetch(`${server.base}/wiki/${page}`, { method: "POST", headers: as, body: "<h1>Again</h1>" });
  assert.equal(create.status, 409);

  const patched = await fetch(`${server.base}/wiki/${page}`, {
    method: "PATCH", headers: { ...as, "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ old_string: "wrote this page", new_string: "wrote and then edited this page" }], baseVersion: written.version }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());
  assert.match(await (await fetch(`${server.base}/wiki/${page}?format=md`)).text(), /wrote and then edited this page/);

  const anonymous = await fetch(`${server.base}/wiki/${folder}/anonymous.html`, { method: "PUT", body: "<h1>Anonymous</h1>\n<p>Nobody named a conversation for this page.</p>" });
  const unknown = await anonymous.json() as { author: string; warning: string };
  assert.equal(anonymous.status, 201, JSON.stringify(unknown));
  assert.equal(unknown.author, "unknown");
  assert.match(unknown.warning, /x-pi-conversation/);

  const event = await server.send("POST", `/api/c/${job}/workspace/events`, { summary: "Wrote two pages through /wiki." });
  assert.equal(event.status, 201, JSON.stringify(event.body));
  const closed = await server.send("POST", `/api/c/${job}/workspace/close`, { outcome: "The /wiki routes read and write.", no_durable_knowledge: true });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const frozen = await fetch(`${server.base}/wiki/${page}`, { method: "PUT", headers: as, body: "<h1>Late</h1>" });
  const refused = await frozen.json() as { error: string };
  assert.equal(frozen.status, 403);
  assert.match(refused.error, /closed/);
});
