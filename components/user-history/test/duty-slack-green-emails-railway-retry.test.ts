// Slack green emails' d3 runs of 2026-10-22 06:59Z and 2026-10-24 01:00Z lost the Resend key when the Railway CLI hit its rate limit and then a
// DNS lookup failure, and each counted as a bad send. This checks such a failure is tried again and any other failure is not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRailway, type EmailDeps } from "../scripts/duties/slack-green-emails.ts";

const dns = "railway link: Command failed: railway link\nCaused by:\n    2: dns error\n    3: failed to lookup address information: Try again";

function fakeRailway(failures: Record<string, string[]>) {
  const calls: string[] = [];
  const waits: number[] = [];
  const deps: EmailDeps = { fetch, now: () => 0, env: {}, sleep: async (ms) => { waits.push(ms); },
    exec: async (_file, args) => {
      calls.push(args[0]!);
      const next = failures[args[0]!]?.shift();
      if (next) throw new Error(next);
      if (args[0] === "variable") return "RESEND_API_KEY=re_test\n";
      if (args[0] === "deployment") return JSON.stringify([{ status: "SUCCESS", createdAt: "2026-10-24T00:00:00Z", meta: { commitHash: "abc1234" } }]);
      return "";
    } };
  return { calls, waits, deps };
}

test("a DNS or rate-limit failure of the Railway CLI is tried again and the key still reads", async () => {
  const { calls, waits, deps } = fakeRailway({ link: [dns, "You are being ratelimited. Please try again later"] });
  const result = await readRailway(deps);
  assert.equal(result.key, "re_test");
  assert.deepEqual(calls.filter((call) => call === "link").length, 3);
  assert.deepEqual(waits, [20_000, 20_000]);
});

test("a Railway failure that persists past the retries, or is not transient, still fails the read", async () => {
  await assert.rejects(readRailway(fakeRailway({ link: [dns, dns, dns] }).deps), /dns error/);
  const other = fakeRailway({ link: ["Unauthorized. Please login with `railway login`"] });
  await assert.rejects(readRailway(other.deps), /Unauthorized/);
  assert.deepEqual(other.waits, []);
});
