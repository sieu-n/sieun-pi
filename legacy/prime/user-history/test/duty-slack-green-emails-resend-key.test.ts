// The Slack Green worker left Railway for Komodo Stack slack-green on 11-25, so d3 reads the Resend key the box worker sends with, from
// auto-sns-agent's apps/infra/.env, instead of `railway variable list`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { measureEmails, type EmailDeps } from "../scripts/duties/slack-green-emails.ts";

function fake(dotenvx: string) {
  const keys: string[] = [];
  const calls: string[][] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://api.resend.com/")) {
      keys.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response(JSON.stringify({ has_more: false, data: [] }));
    }
    return new Response("[]");
  }) as typeof globalThis.fetch;
  const deps: EmailDeps = { fetch, now: () => 0, env: { SUPABASE_ACCESS_TOKEN: "sbp_test" },
    exec: async (file, args) => { calls.push([file, ...args]); return dotenvx; } };
  return { keys, calls, deps };
}

test("the Resend key comes from SLACK_GREEN_RESEND_API_KEY in auto-sns-agent apps/infra/.env", async () => {
  const { keys, calls, deps } = fake("re_box\n");
  const { output } = await measureEmails(deps, undefined);
  assert.deepEqual(keys, ["Bearer re_box"]);
  assert.match(calls[0]!.join(" "), /dotenvx get SLACK_GREEN_RESEND_API_KEY -f \S+\/auto-sns-agent\/apps\/infra\/\.env$/);
  assert.equal(output.metrics.source_errors, 0);
});

test("a key that does not decrypt is a source error that counts in the headline", async () => {
  const { keys, deps } = fake("encrypted:BAD\n");
  const { output } = await measureEmails(deps, undefined);
  assert.deepEqual(keys, []);
  assert.equal(output.metrics.source_errors, 1);
  assert.ok(output.metrics.bad_sends_24h! >= 1);
});
