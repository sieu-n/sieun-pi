// Guards d1's engage_accounts_stuck against accounts the re-login worker already gave a terminal verdict. On 2026-10-29 at 02:25Z d1 read 2 stuck:
// prod 24 (relogin_bad_password, 10-28 12:10Z) and 163 (relogin_gone, 09:53Z), parked with stopped jars the worker never takes again, which the same
// run also listed as deaths. The prod read of STUCK_SQL at 02:45Z returned 24 and 163 without the verdict clause and no row with it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Account, type EngageData, RELOGIN_VERDICT_SQL, STUCK_SQL, report } from "../scripts/duties/engage-reads.ts";

const NOW = Date.parse("2026-10-29T02:25:00Z");

test("a parked account with a dead jar is stuck only while no re-login verdict follows its last status change", () => {
  const parked = STUCK_SQL.split("union all").find(branch => branch.includes("'parked_dead_jar'"));
  assert.ok(parked);
  assert.match(parked, /not exists \(select 1 from ig_engage_account_events v where v\.account_id = a\.id and v\.id > e\.id and /);
  assert.ok(parked.includes(RELOGIN_VERDICT_SQL));
  assert.match(RELOGIN_VERDICT_SQL, /v\.outcome = 'challenged'/);
  assert.match(STUCK_SQL, /select distinct on \(e\.account_id\) e\.account_id, e\.id, /);
});

test("a re-login verdict is a death with its cause, and the death gauge check leaves it out since the gauge counts only transitions", () => {
  const accounts: Account[] = [{ id: 24, status: "parked" }, { id: 163, status: "parked" }, { id: 12, status: "active" }];
  const output = report({
    now: NOW, accounts, errors: [], config: {}, deathGauge: { instagram: 0, bad_password: 0 }, stuck: [],
    deaths: [
      { accountId: 163, at: Date.parse("2026-10-28T09:53:55Z"), status: "challenged", code: "relogin_gone", readBefore: true, pages24h: 385, transition: false },
      { accountId: 24, at: Date.parse("2026-10-28T12:10:16Z"), status: "challenged", code: "relogin_bad_password", readBefore: true, pages24h: 90, transition: false },
    ],
  } satisfies EngageData, []);
  const deaths = (output.flagged ?? []).filter(flag => flag.kind === "death").map(flag => flag.excerpt);
  assert.match(deaths.find(line => line.startsWith("account 163 "))!, /code relogin_gone, cause instagram/);
  assert.match(deaths.find(line => line.startsWith("account 24 "))!, /code relogin_bad_password, cause bad_password/);
  assert.equal((output.flagged ?? []).some(flag => flag.kind === "death_gauge"), false);
  assert.equal(output.metrics.engage_accounts_stuck, 0);
  assert.equal(output.metrics.fleet_ig_killed_pct, 100);
});
