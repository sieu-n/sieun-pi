// 11-01 after 05:20Z: prod crawler 0b7addc2cb answered the old /api/live paths in their successors' flat shape, so prod's portal (main 416fae9ac8)
// answered GET /v1/tiktok/live/profile 200 with no data (req_20a6dc07f84b09204e9ab4510ff863f1) and d2, which judged the status alone, read 82.2.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { bodyGap, nextPage, pageTwoRequest, probe, retryDropped, type Operation } from "../scripts/duties/portal-parity.ts";

const documented = (data: unknown): Operation => ({ responses: { "200": { content: { "application/json": { example: { data, meta: {} } } } } } });
const profile = documented({ platform: "tiktok", username: "flighthouse", follower_count: 1 });
const linkedin = documented({ profile: { username: "williamhgates" }, posts: [] });

test("an answer with every top-level field of the docs example works", () => {
  assert.equal(bodyGap(profile, { data: { platform: "tiktok", username: "khaby.lame", follower_count: null, extra: 1 }, meta: {} }), null);
});

test("a 200 with no data, or data in another shape, is a gap that names what is missing", () => {
  assert.match(bodyGap(profile, { meta: { cost: "$0.0005" } })!, /data is missing/);
  assert.match(bodyGap(linkedin, { data: { id: "1", username: "williamhgates", posts: [] } })!, /data lacks profile/);
  assert.match(bodyGap(documented([{ id: 1 }]), { data: { items: [] } })!, /shows a list/);
  assert.match(bodyGap(profile, { data: [] })!, /data is a list/);
});

test("an operation whose docs show no data example is not judged on its body", () => {
  assert.equal(bodyGap({}, { meta: {} }), null);
  assert.equal(bodyGap(documented("ok"), { data: 1 }), null);
  const examples: Operation = { responses: { "200": { content: { "application/json": { examples: { one: { value: { data: { a: 1 } } } } } } } } };
  assert.match(bodyGap(examples, { data: { b: 1 } })!, /data lacks a/);
});

// 11-04: d2's prod profile searches reached the crawler unlabeled and counted in its latency SLO.
test("every call names this duty as a probe to the portal", async (t) => {
  const sent: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    sent.push(new Headers(init.headers));
    return new Response(JSON.stringify({ data: {}, meta: {} }), { status: 200 });
  });
  await probe("https://api.test", { id: "org_1", key: "kb_live_x" }, "creators.profile_search",
    { method: "POST", path: "/v1/creators/profiles/search", query: {}, body: { query: "natgeo", limit: 2 } }, "prod");
  assert.equal(sent[0]!.get("x-virev-caller"), "probe:portal-parity");
});

// 11-08: d2 read POST /v1/creators/content/search as working while its page 2, sent back as the body's searchAfter, answered 500.
test("a POST search's next page goes back in its request body under the name the body takes", () => {
  const search: Operation = { requestBody: { content: { "application/json": { schema: { properties: { query: {}, searchAfter: {} } } } } } };
  const cursor = [41.444668, -9223372036854776000, 0, "3375368562002916919"];
  const next = nextPage(search, { data: { items: [], nextSearchAfter: cursor }, meta: {} });
  assert.deepEqual(next, { param: "searchAfter", value: cursor, in: "body" });
  const page1 = { method: "POST", path: "/v1/creators/content/search", query: {}, body: { query: "skincare", limit: 2 } };
  assert.deepEqual(pageTwoRequest(page1, next!).body, { query: "skincare", limit: 2, searchAfter: cursor });
  assert.equal(nextPage(search, { data: { items: [], nextSearchAfter: null }, meta: {} }), null);
  const ads: Operation = { requestBody: { content: { "application/json": { schema: { properties: { cursor: {} } } } } } };
  assert.deepEqual(nextPage(ads, { data: { ads: [], next_cursor: "abc", has_more: true } }), { param: "cursor", value: "abc", in: "body" });
});

// 11-16 13:09Z: a 20 min d2 run was read as one hung call; undici cuts only header waits and chunk gaps, so a body that never ends had no end.
test("a call with no answer by its deadline fails for the portal as no answer", { timeout: 5_000 }, async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.write("{"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const answer = await probe(`http://127.0.0.1:${port}`, { id: "org_1", key: "kb_live_x" }, "GET /v1/hang",
      { method: "GET", path: "/v1/hang", query: {} }, "docs example", 200);
    assert.deepEqual([answer.verdict, answer.code, answer.note], ["portal", "no_answer", "docs example: no answer in 0.2 s"]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// 11-25 21:32:19Z: us-metal02's uplink failover moved the default route and ended every socket on 155.254.27.166 with ss -K, and the d2 run
// then in flight read 40 prod and 114 staging calls as unprobed, "fetch failed (ECONNABORTED read ECONNABORTED)", prod 80% and staging 35.3%.
const dropped = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(`read ${code}`), { code }) });

test("a call whose connection this box dropped goes out again and is scored on the answer it gets", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++sent === 1) throw dropped("ECONNABORTED");
    return new Response(JSON.stringify({ data: { username: "natgeo" }, meta: {} }), { status: 200 });
  });
  let resent = 0;
  const answer = await probe("https://api.test", { id: "org_1", key: "kb_live_x" }, "GET /v1/instagram/profile",
    { method: "GET", path: "/v1/instagram/profile", query: { username: "natgeo" } }, "docs example", 10_000, [0, 0], async () => { resent++; });
  assert.equal(sent, 2);
  assert.equal(resent, 1);
  assert.equal(answer.verdict, "ok");
  assert.equal(answer.status, 200);
  assert.match(answer.note, /after 1 dropped connection \(ECONNABORTED\)/);
});

test("a call whose connection drops on every try stays unprobed after the last wait and names each drop", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => { sent++; throw dropped("ECONNRESET"); });
  const answer = await probe("https://api.test", { id: "org_1", key: "kb_live_x" }, "GET /v1/x", { method: "GET", path: "/v1/x", query: {} }, "docs example", 10_000, [0, 0]);
  assert.equal(sent, 3);
  assert.equal(answer.verdict, "unprobed");
  assert.match(answer.note, /ECONNRESET read ECONNRESET.*after 2 dropped connections \(ECONNRESET, ECONNRESET\)/);
});

test("an answer of any status and a fetch error that is not a drop go out once", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => { sent++; return new Response(JSON.stringify({ error: { code: "upstream_error" } }), { status: 502 }); });
  const answer = await probe("https://api.test", { id: "org_1", key: "kb_live_x" }, "GET /v1/x", { method: "GET", path: "/v1/x", query: {} }, "docs example", 10_000, [0, 0]);
  assert.equal(sent, 1);
  assert.equal(answer.status, 502);
  let tries = 0;
  await assert.rejects(retryDropped(async () => { tries++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.test"), { code: "ENOTFOUND" }) }); }, [0, 0]));
  assert.equal(tries, 1);
});
