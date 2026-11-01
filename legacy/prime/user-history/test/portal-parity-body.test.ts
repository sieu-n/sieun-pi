// 11-01 after 05:20Z: prod crawler 0b7addc2cb answered the old /api/live paths in their successors' flat shape, so prod's portal (main 416fae9ac8)
// answered GET /v1/tiktok/live/profile 200 with no data (req_20a6dc07f84b09204e9ab4510ff863f1) and d2, which judged the status alone, read 82.2.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyGap, type Operation } from "../scripts/duties/portal-parity.ts";

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
