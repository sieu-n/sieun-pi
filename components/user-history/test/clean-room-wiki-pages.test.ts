// On 10-18 the archived blind-test chats "Reddit index gaps" and "Bluesky index gaps" left wiki pages that said "measured daily" while nothing
// measured them, so clean-room teardown archives the curated pages its chat made and names them test output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveEdits, archiveTestPages, TEST_DESCRIPTION, testPages } from "../scripts/clean-room/wiki-pages.ts";

const SETUP = Date.parse("2026-10-18T04:51:20Z");
const page = (title: string) => `<!--wiki\n{"title": "${title}", "description": "The top 10 holes, measured daily.", "status": "current"}\n-->\n<h1>${title}</h1>\n`;

test("teardown archives the pages the test chat made and leaves older pages, other chats' pages and session logs", async () => {
  const changes = [
    { path: "apps/crawler-v3/reddit-index-gaps/index.html", version: 1, ts: "2026-10-18T06:07:00Z" },
    { path: "apps/crawler-v3/reddit-index-gaps/index.html", version: 2, ts: "2026-10-18T06:30:00Z" },
    { path: "apps/crawler-v3/index.html", version: 73, ts: "2026-10-18T06:08:00Z" },
    { path: "sessions/2026/10/18/0454-reddit-index-gaps/index.html", version: 1, ts: "2026-10-18T04:54:00Z" },
    { path: "domains/devops/agent-work-queue.html", version: 1, ts: "2026-10-18T04:00:00Z" },
    { path: "domains/devops/chat-release-path.html", version: 1, ts: "2026-10-18T07:39:00Z" },
  ];
  const transcript = "POST http://localhost:5176/api/agent/page apps/crawler-v3/reddit-index-gaps/index.html apps/crawler-v3/index.html " +
    "sessions/2026/10/18/0454-reddit-index-gaps/index.html domains/devops/agent-work-queue.html";
  assert.deepEqual(testPages(changes, [transcript], SETUP), ["apps/crawler-v3/reddit-index-gaps/index.html"]);

  const files = new Map([["apps/crawler-v3/reddit-index-gaps/index.html", page("Reddit index gaps")]]);
  const patches: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/agent/changes") return Response.json({ changes });
    if (path.startsWith("/raw/")) { const raw = files.get(path.slice(5)); return raw ? new Response(raw) : new Response("", { status: 404 }); }
    const body = JSON.parse(String(init?.body)) as { path: string; edits: { old_string: string; new_string: string }[] };
    patches.push(body.path);
    files.set(body.path, body.edits.reduce((text, edit) => text.replace(edit.old_string, edit.new_string), files.get(body.path)!));
    return Response.json({ path: body.path });
  }) as typeof fetch;
  assert.deepEqual(await archiveTestPages("http://wiki", [transcript], SETUP, fake), { archived: ["apps/crawler-v3/reddit-index-gaps/index.html"], failed: [] });
  const after = files.get("apps/crawler-v3/reddit-index-gaps/index.html")!;
  // The title stays as the h1 has it, since the wiki refuses a title that differs from the first <h1> (r3g's teardown, 10-18).
  assert.match(after, /"title": "Reddit index gaps"/);
  assert.match(after, /"status": "archived"/);
  assert.ok(after.includes(TEST_DESCRIPTION));
  assert.doesNotMatch(after, /measured daily/);
  assert.deepEqual(await archiveTestPages("http://wiki", [transcript], SETUP, fake), { archived: [], failed: [] });
  assert.deepEqual(patches, ["apps/crawler-v3/reddit-index-gaps/index.html"]);
  assert.deepEqual(archiveEdits("<h1>no frontmatter</h1>"), []);
});

test("a page a hub links keeps its status and still gets the test-output description", async () => {
  const path = "apps/crawler-v3/platforms/linkedin/fields.html";
  const changes = [{ path, version: 1, ts: "2026-10-18T11:40:00Z" }];
  let raw = page("LinkedIn fields");
  const sent: number[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    const at = new URL(url).pathname;
    if (at === "/api/agent/changes") return Response.json({ changes });
    if (at.startsWith("/raw/")) return new Response(raw);
    const body = JSON.parse(String(init?.body)) as { edits: { old_string: string; new_string: string }[] };
    sent.push(body.edits.length);
    if (body.edits.some(edit => edit.new_string.startsWith('"status"'))) return Response.json({ error: "linked from 1 current hub page(s)" }, { status: 409 });
    raw = body.edits.reduce((text, edit) => text.replace(edit.old_string, edit.new_string), raw);
    return Response.json({ path });
  }) as typeof fetch;
  assert.deepEqual(await archiveTestPages("http://wiki", [path], Date.parse("2026-10-18T11:22:00Z"), fake), { archived: [path], failed: [] });
  assert.deepEqual(sent, [2, 1]);
  assert.ok(raw.includes(TEST_DESCRIPTION));
  assert.match(raw, /"status": "current"/);
  assert.deepEqual(await archiveTestPages("http://wiki", [path], Date.parse("2026-10-18T11:22:00Z"), fake), { archived: [path], failed: [] }, "a rerun of teardown passes");
});
