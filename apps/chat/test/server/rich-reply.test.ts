/**
 * The fixture's rich answer (server/host/fixture.ts `richReply`) and the screenshot it embeds through GET /api/local-image.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/rich-reply.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
let dir: string;
before(async () => {
  s = await start();
  dir = mkdtempSync(join(tmpdir(), "apps-chat-local-image-"));
});
after(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMjAwAAANJQEBEtoaJgAAAABJRU5ErkJggg==", "base64");
const image = (path: string) => fetch(`${s.base}/api/local-image?path=${encodeURIComponent(path)}`);

test("Crawler VP's seeded rich answer uses every format the chat renders", async () => {
  const page = await s.get<TimelinePage>(`/api/c/${ids.crawler}/items`);
  const turn = page.items.findLast((i): i is Extract<Item, { kind: "turn" }> => i.kind === "turn" && i.text.includes("[!IMPORTANT]"));
  assert.ok(turn, "the rich answer is in Crawler VP");
  for (const part of ["```mermaid", "| Surface | State |", "- [x] ", "- [ ] ", "> [!WARNING]", "<details><summary>", "](https://github.com/", "wiki:", "thread:", "`apps/chat/", "![Board panel"]) {
    assert.ok(turn.text.includes(part), `has ${part}`);
  }
  const shot = /!\[[^\]]*\]\(([^)]+)\)/.exec(turn.text)![1]!;
  const res = await image(shot);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
  assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
});

test("a send that says rich streams the same answer", async () => {
  const sent = await s.send("POST", `/api/c/${ids.frontend}/send`, { text: "show me a rich answer", requestId: "rich-1" });
  assert.equal(sent.status, 200);
  const deadline = Date.now() + 10_000;
  let text = "";
  while (Date.now() < deadline && !text.includes("</details>")) {
    const page = await s.get<TimelinePage>(`/api/c/${ids.frontend}/items`);
    text = page.items.filter(i => i.kind === "turn").at(-1)?.text ?? "";
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(text.startsWith("The board panel redesign is live on staging"), text.slice(0, 80));
  assert.ok(text.includes("</details>"));
});

test("/api/local-image serves an image file by its path and nothing else", async () => {
  const png = join(dir, "shot.png");
  writeFileSync(png, PNG);
  const ok = await image(png);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);

  const fake = join(dir, "key.png");
  writeFileSync(fake, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  assert.equal((await image(fake)).status, 415, "a file whose bytes are no PNG");
  assert.equal((await image("/etc/hostname")).status, 415, "a file that is no image");
  assert.equal((await image("shot.png")).status, 400, "a relative path");
  assert.equal((await image(join(dir, "missing.png"))).status, 404);
});

test("a reopen of a local image moves no bytes while the file is the same, and a new screenshot at its path loads again", async () => {
  const png = join(dir, "reopen.png");
  writeFileSync(png, PNG);
  const first = await image(png);
  const tag = first.headers.get("etag");
  assert.equal(first.status, 200);
  assert.ok(tag, "the answer carries a tag");
  const again = await fetch(`${s.base}/api/local-image?path=${encodeURIComponent(png)}`, { headers: { "if-none-match": tag! } });
  assert.equal(again.status, 304, "the browser's copy is still the file");
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  assert.equal(again.headers.get("etag"), tag);

  writeFileSync(png, Buffer.concat([PNG, Buffer.alloc(16)]));
  const changed = await fetch(`${s.base}/api/local-image?path=${encodeURIComponent(png)}`, { headers: { "if-none-match": tag! } });
  assert.equal(changed.status, 200, "the agent wrote a new screenshot to the same path");
  assert.notEqual(changed.headers.get("etag"), tag);
  assert.equal((await changed.arrayBuffer()).byteLength, PNG.length + 16);
});
