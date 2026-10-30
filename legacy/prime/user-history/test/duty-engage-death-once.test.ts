// Guards d1's fleet_ig_killed_pct against counting one Instagram death twice. Prod 163 went relogin_gone on 10-28 09:53Z (a re-login verdict, no
// transition) and was disabled with that code on 10-29 05:04Z after its logged-out profile read "does not exist"; the 10-30 00:00Z run counted it
// again as one of 4 deaths in 24 h (3.8% of 106) though Instagram had killed it the day before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deathsOf } from "../scripts/duties/engage-reads.ts";

const row = (account_id: number, at: string, outcome: string, error_code: string | null, transition: boolean) =>
  ({ account_id, at: Date.parse(at), outcome, error_code, transition, read_before: true, pages_24h: 91 });

test("a dead-status row after an Instagram verdict on the same account is the same death", () => {
  const deaths = deathsOf([
    row(163, "2026-10-28T09:53:55Z", "challenged", "relogin_gone", false),
    row(163, "2026-10-29T05:04:10Z", "disabled", "relogin_gone", true),
    row(148, "2026-10-29T20:22:34Z", "frozen", "account_suspended", true),
  ]);
  assert.deepEqual(deaths.map(death => [death.accountId, new Date(death.at).toISOString()]),
    [[163, "2026-10-28T09:53:55.000Z"], [148, "2026-10-29T20:22:34.000Z"]]);
});

test("an account that went active again dies anew, and a death of ours does not hide a later Instagram one", () => {
  const deaths = deathsOf([
    row(50, "2026-10-20T01:00:00Z", "frozen", "account_suspended", true),
    row(50, "2026-10-21T01:00:00Z", "active", null, true),
    row(50, "2026-10-25T01:00:00Z", "frozen", "account_suspended", true),
    row(60, "2026-10-20T01:00:00Z", "frozen", "transport", true),
    row(60, "2026-10-22T01:00:00Z", "frozen", "account_suspended", true),
  ]);
  assert.deepEqual(deaths.map(death => [death.accountId, death.code]),
    [[50, "account_suspended"], [50, "account_suspended"], [60, "transport"], [60, "account_suspended"]]);
  assert.equal(deaths.some(death => death.status === "active"), false);
});
