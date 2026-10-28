/**
 * The first search after a start answers in under a second, and so does every search after it, with exact totals (c191).
 * On 2026-10-28 the first search on :5184 took 14.8 s: the server read every match from pi-host with its snippet, built a hit for each, and
 * read each page hit's thread through the host to name its item, which opened cold thread files.
 * The thread here holds 10,000 matching entries, and every host read waits 50 ms, the way a read that opens a cold thread file waits.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SearchResult, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

const ENTRIES = 10_000;
const HOST_READ_MS = 50;
const LIMIT_MS = 1000;
let s: Running;

before(async () => {
  s = await start();
  const host = s.host as FixtureHost;
  const thread = host.addThread({ name: "Big", createdAt: Date.now() - 3600_000 });
  for (let i = 0; i < ENTRIES; i++) {
    const timestamp = Date.now() - (ENTRIES - i) * 1000;
    if (i % 50 === 0) host.append(thread, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: `check the zephyr relay ${i}` }], timestamp }] });
    else host.append(thread, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: `zephyr relay line ${i}` }], isError: false, timestamp }] });
  }
  const entries = host.entries.bind(host);
  host.entries = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, HOST_READ_MS));
    return entries(...args);
  };
});
after(() => s.close());

async function timed(path: string): Promise<{ ms: number; body: SearchResult }> {
  const started = performance.now();
  const body = await s.get<SearchResult>(path);
  return { ms: performance.now() - started, body };
}

test("the first search after a start answers in under a second with the exact count", async () => {
  const first = await timed("/api/search?q=zephyr%20relay");
  assert.equal(first.body.total, ENTRIES);
  assert.equal(first.body.hits.length, 20);
  assert.ok(first.ms < LIMIT_MS, `the first search took ${first.ms.toFixed(0)} ms`);
});

test("every search stays under a second, paged, filtered and sorted by date", async () => {
  const paths = ["/api/search?q=zephyr", "/api/search?q=relay&cursor=200&limit=100", "/api/search?q=zephyr%20from:owner", "/api/search?q=relay&sort=recent", "/api/search?q=zephyr%20line"];
  const times: number[] = [];
  for (let round = 0; round < 4; round++) for (const path of paths) times.push((await timed(path)).ms);
  times.sort((a, b) => a - b);
  assert.ok(times.at(-1)! < LIMIT_MS, `the slowest search took ${times.at(-1)!.toFixed(0)} ms`);
  assert.equal((await s.get<SearchResult>("/api/search?q=zephyr%20from:owner")).total, ENTRIES / 50);
  assert.equal((await s.get<SearchResult>("/api/search?q=zephyr%20line")).total, ENTRIES - ENTRIES / 50);
});

test("a thread hit opens the page around its entry, focused on the item that holds it", async () => {
  const { hits } = await s.get<SearchResult>("/api/search?q=zephyr%20line%209999");
  const hit = hits.find(h => h.kind === "tool")!;
  const page = await s.get<TimelinePage>(`/api/c/${encodeURIComponent(hit.conversation.id)}/items?around=${hit.messageId}`);
  const input = Number(hit.messageId.slice(1)) - (9_999 % 50);
  assert.equal(page.focus, `t${input}`);
  assert.ok(page.items.some(i => i.id === page.focus));
});
