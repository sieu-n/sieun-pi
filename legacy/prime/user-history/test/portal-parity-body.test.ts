// 11-01 after 05:20Z: prod crawler 0b7addc2cb answered the old /api/live paths in their successors' flat shape, so prod's portal (main 416fae9ac8)
// answered GET /v1/tiktok/live/profile 200 with no data (req_20a6dc07f84b09204e9ab4510ff863f1) and d2, which judged the status alone, read 82.2.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyGap, nextPage, pageTwoRequest, probe, type Operation } from "../scripts/duties/portal-parity.ts";

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
  await probe("https://api.test", {}, { id: "org_1", key: "kb_live_x" }, "creators.profile_search",
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
