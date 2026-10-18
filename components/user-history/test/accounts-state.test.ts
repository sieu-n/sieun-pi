import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolAccount } from "../src/shared/types.ts";

// accounts.ts loads the browser API client, which reads the page's chat token at import.
Object.assign(globalThis, { document: { body: { dataset: {} } } });
const { accountState, clockText, NEEDS_TERMS, resolutionSentence, STATE_LABEL, threadsText } = await import("../src/client/accounts.ts");

const row = (extra: Partial<PoolAccount>): PoolAccount => ({
  id: "a", email: "a@x", label: "a@x", usage: "", session_pct: 0, weekly_pct: 0, usable: false, reason: null, current: false, pinned: false, seat: false,
  score: null, tier: null, windows: [], usageAt: null, cooldownUntil: null, cooldownReason: null, limitedUntil: null, disabled: false, sessions: 0, ...extra });

test("accounts: an account whose Consumer Terms are pending shows Needs terms, not Refused", () => {
  const cooling = { reason: "cooldown 23h", cooldownUntil: Date.now() + 3_600_000 };
  assert.equal(accountState(row({ ...cooling, cooldownReason: NEEDS_TERMS })), "needs-terms");
  assert.equal(STATE_LABEL["needs-terms"].label, "Needs terms");
  assert.equal(accountState(row({ ...cooling, cooldownReason: "oauth not allowed for organization" })), "refused");
  assert.equal(accountState(row(cooling)), "cooldown");
});

test("accounts: a row names how many threads used it within the pool's active window, and nothing when none did", () => {
  assert.equal(threadsText(row({ sessions: 0 }), null), null);
  assert.deepEqual(threadsText(row({ sessions: 1 }), null), { label: "1 thread", hint: "1 thread (with its jobs) sent a request through this account in the last 60 min." });
  assert.deepEqual(threadsText(row({ sessions: 12 }), { active_session_sec: 600 }),
    { label: "12 threads", hint: "12 threads (with their jobs) sent a request through this account in the last 10 min." });
});

test("accounts: a thread the pool holds says which account it waits for and when, not that the pin cannot serve", () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  const slotAt = new Date(2026, 9, 12, 15, 42).getTime();
  const provider = { provider: "anthropic" as const, rows: [row({ id: "c7", label: "claude7@x" })], resolution: { account: null, email: null, reason: null, pinned: true },
    wait: { account: "c7", slotAt } };
  assert.equal(resolutionSentence(provider, now), `Waiting for claude7@x, back at ${clockText(slotAt, now)}.`);
  assert.match(clockText(slotAt, now), /^15:42$/);
  assert.equal(resolutionSentence({ ...provider, wait: { account: "gone", slotAt: now - 1000 } }, now), "Waiting for gone, due back now.");
  assert.equal(resolutionSentence({ ...provider, wait: null }, now), "No Claude account can serve this thread right now.");
  assert.equal(resolutionSentence({ ...provider, wait: null, resolution: { account: "c7", email: "claude7@x", reason: "session_pin", pinned: true } }, now),
    "This thread uses claude7@x (pinned for this thread).");
});

test("accounts: a wait slot on another day names the day", () => {
  const now = new Date(2026, 9, 12, 23, 50).getTime();
  assert.doesNotMatch(clockText(new Date(2026, 9, 13, 0, 10).getTime(), now), /^00:10$/);
});
