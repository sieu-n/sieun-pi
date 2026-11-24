/**
 * Release af53200 ended twice on 11-24 with ERR_STRING_TOO_LONG: a search asked Meilisearch for every hit written since a cut weeks old, and
 * the answer passed V8's longest string. Meili.call now refuses an answer longer than it may hold, and that search reads its hits a page at a
 * time, with the same results.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { Meili, MeiliError } from "../../server/meili.ts";
import { eq } from "../../server/search-engine.ts";
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

test("the hits written since an old cut come a page at a time and rank as they did in one answer", async () => {
  const word = `zqpage${Math.random().toString(36).slice(2, 8)}`;
  const room = (await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: `page-${word}`, members: [] })).body.id;
  // One to three words start with the searched one, so the engine's rule ranks by how many before how new.
  for (let n = 1; n <= 30; n += 1) await post(room, `${["a", "b", "c"].slice(0, 1 + (n % 3)).map(end => word + end).join(" ")} post ${n}`);
  await s.app.searchEngine.settled();
  const meili = (s.app.searchEngine as unknown as { meili: Meili }).meili;
  const search = meili.search.bind(meili);
  const answers: number[] = [];
  meili.search = (async (uid: string, body: Record<string, unknown>) => {
    const answer = await search(uid, body);
    answers.push(answer.hits.length);
    return answer;
  }) as Meili["search"];
  const ask = () => s.app.searchEngine.search(word, eq("source", "post"), { sort: "relevance", limit: 5, since: 0 });
  try {
    const whole = await ask();
    meili.pageHits = 4;
    answers.length = 0;
    const paged = await ask();
    assert.ok(answers.length > 30 / 4, `${answers.length} answers`);
    assert.ok(Math.max(...answers) <= 5, `one answer held ${Math.max(...answers)} hits`);
    assert.equal(paged.total, 30);
    assert.deepEqual(paged.docs.map(doc => doc.id), whole.docs.map(doc => doc.id));
    assert.equal(paged.total, whole.total);
    const shown = paged.docs.map(doc => Number(/post (\d+)/.exec(doc.text)![1]));
    assert.deepEqual(shown, [29, 26, 23, 20, 17]);
  } finally {
    meili.search = search;
    meili.pageHits = 1_000;
  }
});
