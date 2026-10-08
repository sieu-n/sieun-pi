import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolAccount } from "../src/shared/types.ts";

// accounts.ts loads the browser API client, which reads the page's chat token at import.
Object.assign(globalThis, { document: { body: { dataset: {} } } });
const { accountState, NEEDS_TERMS, STATE_LABEL } = await import("../src/client/accounts.ts");

const row = (extra: Partial<PoolAccount>): PoolAccount => ({
  id: "a", email: "a@x", usage: "", session_pct: 0, weekly_pct: 0, usable: false, reason: null, current: false, pinned: false, force: false, live: false, seat: false,
  score: null, tier: null, windows: [], usageAt: null, cooldownUntil: null, cooldownReason: null, limitedUntil: null, disabled: false, ...extra });

test("accounts: an account whose Consumer Terms are pending shows Needs terms, not Refused", () => {
  const cooling = { reason: "cooldown 23h", cooldownUntil: Date.now() + 3_600_000 };
  assert.equal(accountState(row({ ...cooling, cooldownReason: NEEDS_TERMS })), "needs-terms");
  assert.equal(STATE_LABEL["needs-terms"].label, "Needs terms");
  assert.equal(accountState(row({ ...cooling, cooldownReason: "oauth not allowed for organization" })), "refused");
  assert.equal(accountState(row(cooling)), "cooldown");
});
