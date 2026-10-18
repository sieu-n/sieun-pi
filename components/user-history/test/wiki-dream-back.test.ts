// Guards the wiki dream mistakes_back miscount of 2026-10-18. slop_in_replies_and_pages recurred at 05:39Z and 06:55Z and got a new fix at
// 07:01:16Z, and owner_mac_and_machines recurred at 05:20Z and got a new fix at 06:39:51Z. The metric counted both for 7 days whatever the new
// fixes did, so only a recurrence after the current fix counts as back, and recurred_7d keeps the churn visible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classStates, type Ledger } from "../scripts/duties/wiki-dream.ts";

test("a class is back only when it recurred after its current fix, or has no fix date", () => {
  const ledger: Ledger = {
    classes: {
      slop_in_replies_and_pages: {
        status: "fixed", fixCommit: "sieun-pi 08cb72ba4", fixedAt: "2026-10-18T07:01:16Z",
        recurred: ["2026-10-18T03:19:26Z", "2026-10-18T05:39:20Z", "2026-10-18T06:55:04Z"],
      },
      owner_mac_and_machines: { status: "fixed", fixCommit: "sieun-pi 1880d471c", fixedAt: "2026-10-18T06:39:51Z", recurred: ["2026-10-18T05:20:25Z"] },
      fix_failed_again: { status: "fixed", fixedAt: "2026-10-18T06:00:00Z", recurred: ["2026-10-18T05:00:00Z", "2026-10-18T07:30:00Z"] },
      no_fix_date: { status: "fixed", recurred: ["2026-10-18T05:00:00Z"] },
      old_churn: { status: "fixed", recurred: ["2026-10-09T05:00:00Z"] },
    },
  };
  const states = classStates(ledger, Date.parse("2026-10-18T07:46:00Z"));
  assert.deepEqual(states.back.map(([slug]) => slug), ["fix_failed_again", "no_fix_date"]);
  assert.deepEqual(states.recurred.map(([slug]) => slug), ["slop_in_replies_and_pages", "owner_mac_and_machines", "fix_failed_again", "no_fix_date"]);
});
