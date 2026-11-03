/**
 * Link previews (server/unfurl.ts): the card a page's <head> states, the redirects it follows, and the addresses it never fetches.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/unfurl.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateAddress, readHead, Unfurler } from "../../server/unfurl.ts";

const page = (head: string, body = "<p>body</p>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("a page's Open Graph tags make the card, with <title> and the host as fallbacks and entities decoded", () => {
  const full = readHead(page(`<title>Plain</title><meta property="og:title" content="Svelte &amp; you"><meta property="og:description" content='Docs for &quot;runes&quot;'>
    <meta property="og:site_name" content="Svelte"><meta property="og:image" content="/img/card.png">`), "https://svelte.dev/docs");
  assert.deepEqual(full, { url: "https://svelte.dev/docs", site: "Svelte", title: "Svelte & you", description: 'Docs for "runes"', image: "https://svelte.dev/img/card.png" });
  assert.deepEqual(readHead(page(`<title> Only a
    title </title><meta name="description" content="From the description tag">`), "https://www.example.com/a"),
  { url: "https://www.example.com/a", site: "example.com", title: "Only a title", description: "From the description tag" });
  assert.equal(readHead(page(""), "https://example.com"), null, "no title, no card");
  assert.equal(readHead(page(`<meta property="og:title" content="x"><meta property="og:image" content="http://plain.example/x.png">`), "https://a.example")?.image, undefined, "an http image would be mixed content");
});

test("loopback, LAN, tailnet and link-local addresses count as private", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.9", "100.101.102.103", "169.254.1.1", "0.0.0.0", "::1", "fd7a:115c::1", "fe80::1", "::ffff:127.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("a fetch follows public redirects, reads only the head, and refuses a private host anywhere on the way", async () => {
  const calls: string[] = [];
  const hosts: Record<string, string> = { "a.example": "93.184.216.34", "b.example": "93.184.216.35", "inside.example": "10.0.0.5" };
  const unfurler = new Unfurler(async (url) => {
    calls.push(url);
    if (url === "https://a.example/start") return new Response(null, { status: 301, headers: { location: "https://b.example/page" } });
    if (url === "https://a.example/sneaky") return new Response(null, { status: 302, headers: { location: "https://inside.example/admin" } });
    if (url === "https://b.example/file.pdf") return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
    return new Response(page(`<meta property="og:title" content="Landed">`), { headers: { "content-type": "text/html; charset=utf-8" } });
  }, async (host) => [hosts[host]!]);
  assert.equal((await unfurler.get("https://a.example/start#frag"))?.title, "Landed");
  assert.deepEqual(calls, ["https://a.example/start", "https://b.example/page"]);
  assert.equal(await unfurler.get("https://a.example/sneaky"), null);
  assert.ok(!calls.includes("https://inside.example/admin"));
  assert.equal(await unfurler.get("https://inside.example/"), null);
  assert.equal(await unfurler.get("http://127.0.0.1:5184/api/me"), null);
  assert.equal(await unfurler.get("https://b.example/file.pdf"), null, "only an HTML page makes a card");
  await unfurler.get("https://a.example/start");
  assert.equal(calls.filter((c) => c === "https://a.example/start").length, 1, "a link is read once");
  assert.throws(() => unfurler.get("ftp://a.example/x"), /http or https/);
});
