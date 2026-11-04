/**
 * A tab left open across a release runs the old web build, and the server says which build it serves now, so the page can offer a reload.
 * On 11-04 at 03:09Z a tab loaded the day before sent images in a shape the server had dropped, and two of the owner's posts came back
 * Not delivered.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/web-build.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { LiveEvent, Me } from "../../web/src/lib/api/types.ts";
import { webEntry } from "../../server/web-entry.ts";
import { isStale, pageEntry } from "../../web/src/lib/api/stale.ts";
import { start, type Running } from "./helpers.ts";

const BUILT = `<!doctype html><html><head>
<script>try { localStorage.getItem("chat.colorMode"); } catch {}</script>
<script type="module" crossorigin src="/assets/index-NEW123.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-abc.js">
</head><body><div id="app"></div></body></html>`;

let s: Running;
let web: string;
before(async () => {
  web = mkdtempSync(join(tmpdir(), "apps-chat-web-"));
  writeFileSync(join(web, "index.html"), BUILT);
  s = await start();
  s.app.config.webDir = web;
});
after(async () => {
  await s.close();
  rmSync(web, { recursive: true, force: true });
});

test("the server names the web build it serves in GET /api/me and the hello", async () => {
  const me = (await s.send("GET", "/api/me")).body as Me;
  assert.equal(me.web, "/assets/index-NEW123.js");
  const hello = await new Promise<Extract<LiveEvent, { type: "hello" }>>((resolve, reject) => {
    const socket = new WebSocket(`${s.base.replace("http", "ws")}/api/live`);
    socket.onmessage = message => {
      const event = JSON.parse(String(message.data)) as LiveEvent;
      if (event.type === "hello") {
        socket.close();
        resolve(event);
      }
    };
    socket.onerror = () => reject(new Error("no live socket"));
  });
  assert.equal(hello.me.web, "/assets/index-NEW123.js");
});

test("a page that loaded another build is stale, and a dev page or a server with no build says nothing", () => {
  const page = (src: string | null) => ({ querySelector: (selector: string) => (selector.includes("module") && src ? { getAttribute: () => src } : null) }) as unknown as Document;
  assert.equal(pageEntry(page("/assets/index-OLD999.js")), "/assets/index-OLD999.js");
  assert.equal(isStale("/assets/index-NEW123.js", pageEntry(page("/assets/index-OLD999.js"))), true);
  assert.equal(isStale("/assets/index-NEW123.js", pageEntry(page("/assets/index-NEW123.js"))), false);
  assert.equal(isStale(null, "/src/main.ts"), false);
  assert.equal(webEntry(join(web, "missing")), null);
});
