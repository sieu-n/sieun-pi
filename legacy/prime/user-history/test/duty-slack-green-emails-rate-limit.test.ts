// Slack green emails' d3 run on 2026-10-22 07:49Z failed with Resend's HTTP 429 "You can only make 10 requests per second", because readSends
// read its send log pages back to back. This checks a 429 page waits the seconds Resend's header names and is read again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSends } from "../scripts/duties/slack-green-emails.ts";

const page = { has_more: false, data: [{ id: "e1", to: ["a@x.com"], from: "Slack Green <hi@slack.green>", created_at: "2026-10-22 07:00:00.000+00",
  subject: "Welcome", last_event: "delivered" }] };

function fakeFetch(responses: Response[]) {
  const urls: string[] = [];
  const fetch = (async (url: string) => { urls.push(url); return responses.shift()!; }) as typeof globalThis.fetch;
  return { urls, deps: { exec: async () => "", fetch, now: () => 0, env: {} } };
}
const tooMany = (headers: Record<string, string>) =>
  new Response('{"name":"rate_limit_exceeded","message":"Too many requests. You can only make 10 requests per second."}', { status: 429, headers });

test("a 429 page waits Resend's retry-after and is read again", async () => {
  const { urls, deps } = fakeFetch([tooMany({ "retry-after": "0" }), new Response(JSON.stringify(page))]);
  const sends = await readSends(deps, "re_test");
  assert.deepEqual(urls, ["https://api.resend.com/emails?limit=100", "https://api.resend.com/emails?limit=100"]);
  assert.deepEqual(sends.map((send) => [send.id, send.to]), [["e1", "a@x.com"]]);
});

test("a 429 with only ratelimit-reset waits that, and a 429 with no wait header fails the read", async () => {
  const reset = fakeFetch([tooMany({ "ratelimit-reset": "0" }), new Response(JSON.stringify(page))]);
  assert.equal((await readSends(reset.deps, "re_test")).length, 1);
  const bare = fakeFetch([tooMany({})]);
  await assert.rejects(readSends(bare.deps, "re_test"), /HTTP 429/);
});
