import assert from "node:assert/strict";
import { test } from "node:test";
import { measureReviews, type ReviewThread } from "../scripts/duties/slack-green-review-trials.ts";

const NOW = Date.parse("2026-10-27T15:00:00Z");
const post: ReviewThread = { id: "aaaa0001", created_at: "2026-10-20T00:00:00Z", user_id: null, trial_extension_days: 14, rating: 5, content: "ok", image_url: null };

/** A fetch error as undici throws it: "fetch failed" with the lookup error in `cause`. */
function dnsError(): Error {
  const cause = Object.assign(new Error("getaddrinfo EAI_AGAIN pcpcicvhrcazmlpjrqho.supabase.co"), { code: "EAI_AGAIN" });
  return new TypeError("fetch failed", { cause });
}

function fakeFetch(failures: number): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    if (calls <= failures) throw dnsError();
    return new Response(JSON.stringify([post]), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

test("one EAI_AGAIN lookup failure is retried and the read counts no source error (10-27 14:36Z)", async () => {
  const fake = fakeFetch(1);
  const { output } = await measureReviews({ fetch: fake.fetch, now: () => NOW, url: "https://example.supabase.co", key: "k" });
  assert.equal(fake.calls(), 2);
  assert.equal(output.metrics.source_errors, 0);
  assert.match(output.flagged?.at(-1)?.excerpt ?? "", /^1 review posts in prod, 0 with no trial decision/);
});

test("two network failures in a row count a source error that names the cause code", async () => {
  const fake = fakeFetch(2);
  const { output } = await measureReviews({ fetch: fake.fetch, now: () => NOW, url: "https://example.supabase.co", key: "k" });
  assert.equal(fake.calls(), 2);
  assert.equal(output.metrics.source_errors, 1);
  assert.match(output.flagged?.[0]?.excerpt ?? "", /threads read failed: GET threads failed twice: fetch failed \(EAI_AGAIN: getaddrinfo EAI_AGAIN/);
});

test("an HTTP error status is an answer and is not retried", async () => {
  let calls = 0;
  const fetch = (async () => { calls += 1; return new Response("bad key", { status: 401 }); }) as unknown as typeof globalThis.fetch;
  const { output } = await measureReviews({ fetch, now: () => NOW, url: "https://example.supabase.co", key: "k" });
  assert.equal(calls, 1);
  assert.equal(output.metrics.source_errors, 1);
  assert.match(output.flagged?.[0]?.excerpt ?? "", /HTTP 401: bad key/);
});
