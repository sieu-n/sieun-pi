// Guards d1's proven rate. On 2026-10-30 at 00:00Z prod_capacity_pages_day read 9,540 (106 healthy x 90): 12 canary accounts read up to 665
// pages on 10-29 with 0 Instagram verdicts, but provenRate() dropped every rate at or over the lowest verdict since the window start, and prod
// 163 went relogin_gone at 91 pages. Prod 10-12 to 10-29 showed no rise in verdicts with pages (DEATH_EXCESS_P), so a rate is unsafe only when
// its readers die more often than the rest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_WINDOW_MS, type DayPages, type Death, type EngageData, deathExcessP, provenRates, report } from "../scripts/duties/engage-reads.ts";

const at = (iso: string): number => Date.parse(iso);
const verdict = (accountId: number, iso: string, code: string, pages24h: number): Death =>
  ({ accountId, at: at(iso), status: "frozen", code, readBefore: true, pages24h, transition: true });
const fleet = (day: string, readers: [count: number, pages: number][]): DayPages[] => {
  let id = 0;
  return readers.flatMap(([count, pages]) => Array.from({ length: count }, () => ({ day, accountId: ++id, pages })));
};

test("deathExcessP is the one-sided Fisher exact test", () => {
  assert.ok(Math.abs(deathExcessP(26, 2, 290, 2) - 0.035297) < 1e-5);
  assert.ok(Math.abs(deathExcessP(25, 1, 290, 4) - 0.340467) < 1e-5);
  assert.ok(Math.abs(deathExcessP(201, 7, 1036, 9) - 0.008324) < 1e-5);
  assert.equal(deathExcessP(10, 0, 100, 3), 1);
});

test("verdicts at low page counts no longer cap the canary's rate (prod 10-28 and 10-29)", () => {
  const days = [
    ...fleet("2026-10-28", [[11, 678], [1, 638], [100, 150]]),
    ...fleet("2026-10-29", [[11, 665], [100, 200]]),
  ];
  const deaths = [
    verdict(163, "2026-10-28T09:53:55Z", "relogin_gone", 385), verdict(163, "2026-10-29T05:04:24Z", "relogin_gone", 91),
    verdict(148, "2026-10-29T20:22:34Z", "account_suspended", 251), verdict(219, "2026-10-29T20:24:21Z", "account_suspended", 142),
    verdict(179, "2026-10-29T20:24:22Z", "account_suspended", 157),
  ];
  const proof = provenRates(days, deaths, 11).newest;
  assert.equal(proof?.rate, 665);
  assert.deepEqual(proof?.days, ["2026-10-28", "2026-10-29"]);
  assert.deepEqual([proof?.hiDays, proof?.hiDeaths, proof?.loDays, proof?.loDeaths], [22, 0, 201, 4], "163 counts once, at its first verdict");
});

test("two verdicts among few high readers unprove their rate, and the rate under it stays proven", () => {
  const days = [...fleet("2026-10-28", [[13, 640], [145, 150]]), ...fleet("2026-10-29", [[13, 640], [145, 150]])];
  const deaths = [
    verdict(1, "2026-10-29T10:00:00Z", "account_suspended", 640), verdict(2, "2026-10-29T11:00:00Z", "account_suspended", 640),
    verdict(20, "2026-10-29T12:00:00Z", "account_suspended", 150), verdict(21, "2026-10-29T13:00:00Z", "account_suspended", 150),
  ];
  assert.equal(provenRates(days, deaths, 11).newest?.rate, 150);
  assert.equal(provenRates(days, deaths.slice(1), 11).newest?.rate, 640, "one verdict among 26 high account-days is within chance");
});

test("a verdict with no page in its last 24 h and a cause that is not Instagram's say nothing about a rate", () => {
  const days = [...fleet("2026-10-28", [[13, 640], [145, 150]]), ...fleet("2026-10-29", [[13, 640], [145, 150]])];
  const deaths = [
    verdict(1, "2026-10-29T10:00:00Z", "login_redirect", 0), verdict(2, "2026-10-29T11:00:00Z", "transport", 640),
    verdict(3, "2026-10-29T12:00:00Z", "bad_password", 640),
  ];
  assert.equal(provenRates(days, deaths, 11).newest?.rate, 640);
});

test("no rate is proven when fewer than a cohort read on a day", () => {
  const rates = provenRates([...fleet("2026-10-28", [[10, 640]]), ...fleet("2026-10-29", [[13, 640]])], [], 11);
  assert.deepEqual(rates, { newestDays: ["2026-10-28", "2026-10-29"], newest: null, best: null });
});

test("the headline is the newest window, and an older higher proof is only the best (launch VP, 10-30)", () => {
  const days = [
    ...fleet("2026-10-15", [[11, 1459], [100, 300]]), ...fleet("2026-10-16", [[11, 1500], [100, 300]]),
    ...fleet("2026-10-28", [[11, 678], [100, 150]]), ...fleet("2026-10-29", [[11, 638], [100, 200]]),
  ];
  const { newestDays, newest, best } = provenRates(days, [], 11);
  assert.deepEqual(newestDays, ["2026-10-28", "2026-10-29"]);
  assert.equal(newest?.rate, 638);
  assert.equal(best?.rate, 1459);
  assert.deepEqual(best?.days, ["2026-10-15", "2026-10-16"]);
});

test("the capacity headline reports its window: lastEventAt is the newest window day's end and windowMs two days (launch VP, 10-31)", () => {
  const days = [...fleet("2026-10-29", [[14, 600], [100, 150]]), ...fleet("2026-10-30", [[13, 1100], [1, 472], [100, 150]])];
  const accounts = Array.from({ length: 138 }, (_, i) => ({ id: i + 1, status: "active" }));
  const output = report({ now: at("2026-10-31T02:00:00Z"), errors: [], accounts, config: {}, deaths: [], days, healthy: 138,
    lapsed: { waiting: 0, blocked: 0, oldestAt: null } } satisfies EngageData, []);
  assert.equal(output.metrics.prod_capacity_pages_day, 138 * 472);
  assert.equal(output.lastEventAt?.prod_capacity_pages_day, at("2026-10-31T00:00:00Z"));
  assert.equal(output.windowMs?.prod_capacity_pages_day, CAPACITY_WINDOW_MS);
  const line = output.flagged?.find(flag => flag.kind === "capacity")?.excerpt ?? "";
  assert.match(line, /reads the window 2026-10-29 and 2026-10-30, .* the newest window day leaves at 11-02 00:00Z/);
});
