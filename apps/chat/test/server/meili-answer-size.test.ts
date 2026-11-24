/**
 * Release af53200 ended twice on 11-24 with ERR_STRING_TOO_LONG: a search asked Meilisearch for every hit written since a cut weeks old, and
 * the answer passed V8's longest string. Meili.call now refuses an answer longer than it may hold. A waiting document weeks old no longer
 * makes a search read every newer hit (13.2 s for "vent"), its next-page cursor stays short however many documents wait, and a search while
 * Meilisearch is down or hung answers from memory, marked partial.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { Meili, MeiliError } from "../../server/meili.ts";
import { and, eq, postDocId, type PostDoc } from "../../server/search-engine.ts";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

async function answering(body: string, chunked: boolean): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", ...(chunked ? {} : { "content-length": Buffer.byteLength(body) }) });
    if (!chunked) return response.end(body);
    for (let at = 0; at < body.length; at += 256) response.write(body.slice(at, at + 256));
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

for (const chunked of [false, true]) {
  test(`an answer longer than the client may hold rejects with MeiliError (${chunked ? "chunked" : "content-length"})`, async () => {
    const big = JSON.stringify({ results: Array.from({ length: 200 }, (_, n) => ({ id: `d${n}`, text: "x".repeat(20) })) });
    const { server, url } = await answering(big, chunked);
    try {
      await assert.rejects(new Meili(url, "key", 1_000).call("GET", "/tasks"), MeiliError);
      assert.equal((await new Meili(url, "key", big.length).call<{ results: unknown[] }>("GET", "/tasks")).results.length, 200);
    } finally {
      server.close();
    }
  });
}

let s: Running;
before(async () => {
  s = await start();
});
after(() => s.close());

async function post(room: string, text: string): Promise<void> {
  const sent = await s.send("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID() });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
}

function spy(): { meili: Meili; asked: number[]; restore(): void } {
  const meili = (s.app.searchEngine as unknown as { meili: Meili }).meili;
  const search = meili.search.bind(meili);
  const asked: number[] = [];
  meili.search = (async (uid: string, body: Record<string, unknown>) => {
    asked.push(Number(body.hitsPerPage ?? body.limit ?? 0));
    return search(uid, body);
  }) as Meili["search"];
  return { meili, asked, restore: () => void (meili.search = search) };
}

test("a waiting document weeks old asks Meilisearch for one page, and every page ranks the same documents once it is indexed", async () => {
  const word = `zqold${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `old-${word}`, members: [] })).body.id;
  for (let n = 1; n <= 30; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  const { meili, asked, restore } = spy();
  const put = meili.put.bind(meili);
  const held: (() => void)[] = [];
  meili.put = (uid, docs) => new Promise(resolve => held.push(() => resolve(put(uid, docs))));
  const old: PostDoc = {
    id: postDocId(room, `old-${word}`), source: "post", text: `${word} post 0`, reactions: "", at: Date.now() - 21 * 24 * 60 * 60 * 1000, tier: 0,
    author: "owner", room, post: `old-${word}`, dm: false, listed: true, ownerPost: true, kind: "room.post", has: [],
  };
  const where = and(eq("source", "post"), eq("room", room));
  const shown: string[] = [];
  let since = "";
  try {
    s.app.searchEngine.postChanged(old.id, old);
    const first = await s.app.searchEngine.search(word, where, { sort: "relevance", limit: 10 });
    assert.ok(Math.max(...asked) <= 10, `one Meilisearch answer was asked for ${Math.max(...asked)} hits`);
    assert.equal(first.total, 31);
    assert.ok(first.since);
    since = first.since;
    shown.push(...first.docs.map(doc => doc.id));
  } finally {
    meili.put = put;
    restore();
  }
  for (const release of held) release();
  await s.app.searchEngine.settled();
  for (const limit of [20, 30, 40]) {
    const page = await s.app.searchEngine.search(word, where, { sort: "relevance", limit, since });
    assert.equal(page.total, 31);
    shown.push(...page.docs.slice(limit - 10).map(doc => doc.id));
  }
  assert.equal(new Set(shown).size, shown.length, "a hit came twice");
  assert.equal(shown.length, 31);
  assert.ok(shown.includes(old.id));
});

test("a search while Meilisearch does not answer finds room posts from memory and says it is partial", async () => {
  const word = `zqdown${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `down-${word}`, members: [] })).body.id;
  for (let n = 1; n <= 3; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  const meili = (s.app.searchEngine as unknown as { meili: Meili }).meili;
  const call = meili.call.bind(meili);
  meili.call = (() => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7700"), { code: "ECONNREFUSED" }))) as Meili["call"];
  try {
    const answer = await s.send<SearchResult>("GET", `/api/search?${new URLSearchParams({ q: word })}`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.total, 3);
    assert.deepEqual(answer.body.hits.map(hit => hit.snippet.replace(/<\/?mark>/g, "")).sort(), [1, 2, 3].map(n => `${word} post ${n}`));
    assert.ok(answer.body.missing?.some(line => line.box === "index"));
  } finally {
    meili.call = call;
  }
  const back = await s.send<SearchResult>("GET", `/api/search?${new URLSearchParams({ q: word })}`);
  assert.equal(back.body.partial, undefined);
  assert.equal(back.body.total, 3);
});

test("a next-page cursor stays short however many matching documents wait for Meilisearch", async () => {
  const word = `zqwait${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `wait-${word}`, members: [] })).body.id;
  for (let n = 1; n <= 5; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  const meili = (s.app.searchEngine as unknown as { meili: Meili }).meili;
  const put = meili.put.bind(meili);
  const held: (() => void)[] = [];
  meili.put = (uid, docs) => new Promise(resolve => held.push(() => resolve(put(uid, docs))));
  try {
    for (let n = 6; n <= 45; n += 1) await post(room, `${word} post ${n}`);
  } finally {
    meili.put = put;
  }
  const ask = (cursor?: string) => s.get<SearchResult>(`/api/search?${new URLSearchParams({ q: word, limit: "10", ...(cursor ? { cursor } : {}) })}`);
  const pages = [await ask()];
  assert.equal(pages[0]!.total, 45);
  assert.ok(pages[0]!.nextCursor!.length < 64, `the cursor is ${pages[0]!.nextCursor!.length} characters`);
  for (const release of held) release();
  await s.app.searchEngine.settled();
  while (pages.at(-1)!.nextCursor) pages.push(await ask(pages.at(-1)!.nextCursor));
  const shown = pages.flatMap(page => page.hits.map(hit => Number(/post (\d+)/.exec(hit.snippet.replace(/<\/?mark>/g, ""))![1])));
  assert.equal(new Set(shown).size, shown.length, `a hit came twice: ${shown.join(" ")}`);
  assert.equal(shown.length, 45);
});

test("a search while Meilisearch hangs answers from memory, marked partial, after the engine's wait", async () => {
  const word = `zqhang${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `hang-${word}`, members: [] })).body.id;
  for (let n = 1; n <= 3; n += 1) await post(room, `${word} post ${n}`);
  await s.app.searchEngine.settled();
  const engine = s.app.searchEngine as unknown as { meili: Meili; meiliWaitMs: number };
  const call = engine.meili.call.bind(engine.meili);
  const wait = engine.meiliWaitMs;
  engine.meili.call = (() => new Promise(() => undefined)) as Meili["call"];
  engine.meiliWaitMs = 200;
  try {
    const started = performance.now();
    const answer = await Promise.race([
      s.send<SearchResult>("GET", `/api/search?${new URLSearchParams({ q: word })}`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the search waited 5 s on a hung Meilisearch")), 5_000)),
    ]);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.partial, true);
    assert.equal(answer.body.total, 3);
    assert.ok(performance.now() - started < 2_000);
  } finally {
    engine.meili.call = call;
    engine.meiliWaitMs = wait;
  }
});
