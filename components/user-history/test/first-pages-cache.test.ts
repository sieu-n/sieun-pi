import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPrebuilt } from "../src/chat-assets.ts";
import { FirstPages, inlineJson } from "../src/first-page.ts";
import type { ThreadEvent } from "../src/shared/types.ts";

// Guards the 10-18 cold opens from Korea that waited 5.2 to 6.3 s for the shell's first byte right after a chat restart: a restart serves each
// thread's first page from the file the last process wrote, and never a page whose session file grew since.
test("a first page is served from memory, then from its file after a restart, and never once its session file grew", async () => {
  const dir = mkdtempSync(join(tmpdir(), "first-pages-"));
  const session = join(dir, "s.jsonl");
  writeFileSync(session, "{}\n");
  const frames = [{ type: "snapshot", snapshot: { messages: [{ role: "user", content: "</script>", timestamp: 1 }] } }] as unknown as ThreadEvent[];
  const pages = new FirstPages(join(dir, "pages"), 10_000);
  const text = pages.put("t1", frames, session);
  assert.equal(text, inlineJson(frames));
  assert.doesNotMatch(text, /<\/script>/);
  assert.equal(await pages.get("t1"), text);
  await pages.flush();
  const restarted = new FirstPages(join(dir, "pages"));
  assert.equal(await restarted.get("t1"), text);
  assert.equal(await restarted.get("t2"), undefined);
  appendFileSync(session, "{}\n");
  assert.equal(await restarted.get("t1"), undefined);
  assert.equal(await pages.get("t1"), undefined);
  pages.put("t3", frames);
  assert.equal(await pages.get("t3"), undefined, "a thread with no session file has nothing to check the page against");
});

test("a release's prebuilt client bundle is read from disk at start, and a folder missing a file compiles instead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prebuilt-"));
  for (const [name, body] of [["app.js", "js"], ["app.js.br", "jsbr"], ["app.js.gz", "jsgz"], ["app.css", "css"], ["app.css.br", "cssbr"], ["app.css.gz", "cssgz"]]) writeFileSync(join(dir, name!), body!);
  const bundle = await readPrebuilt(dir);
  assert.ok(bundle);
  assert.equal(bundle.js.body.toString(), "js");
  assert.equal(bundle.js.br?.toString(), "jsbr");
  assert.equal(bundle.css.gzip?.toString(), "cssgz");
  assert.match(bundle.version, /^[0-9a-f]{16}$/);
  rmSync(join(dir, "app.css.gz"));
  assert.equal(await readPrebuilt(dir), null);
});
