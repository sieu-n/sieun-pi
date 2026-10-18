// Guards d1's canary read. On 2026-10-18 at 05:21Z the Engage reads scale safely precheck said no canary ran, because it read engage.rate_test_arms,
// which prod leaves empty on purpose, while 15 of 169 active prod accounts ran the hash cohort engage.canary_pct 10, engage.canary_offset 65
// (config_audit 13970 and 13994) at 2,000 pages a day. auto-sns-agent 4012d607b9 moves the canary to the id roster engage.canary_accounts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Account, type EngageData, canaryOf, report } from "../scripts/duties/engage-reads.ts";

/** Prod's 200 accounts on 10-18 05:40Z; the ones not listed in NOT_ACTIVE are active. */
const IDS = "11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,219,220,221,222,223,224,225,226,227,228,230,231,232,237,241,242,243,244,245,246,249,251,252,253,254,255,257,260,261,262,264,265,267,268,269,270,271,272,273,274,275,277".split(",").map(Number);
const NOT_ACTIVE: Record<string, string> = {"11": "challenged", "17": "challenged", "19": "challenged", "20": "frozen", "32": "challenged", "36": "challenged", "37": "challenged", "38": "disabled", "39": "challenged", "40": "frozen", "43": "challenged", "45": "disabled", "53": "challenged", "55": "disabled", "58": "challenged", "61": "challenged", "62": "challenged", "68": "challenged", "70": "disabled", "71": "disabled", "72": "disabled", "73": "parked", "74": "disabled", "75": "parked", "203": "disabled", "226": "disabled", "230": "disabled", "262": "challenged", "265": "disabled", "267": "challenged", "272": "disabled"};
const ACCOUNTS: Account[] = IDS.map(id => ({ id, status: NOT_ACTIVE[id] ?? "active" }));
/** Prod's own answer to (id * 2654435761 + 65) % 100 < 10 over those accounts, 10-18 05:40Z. */
const PROD_COHORT = [17, 22, 35, 40, 58, 63, 117, 122, 135, 140, 158, 163, 176, 181, 199, 204, 217, 222];
const NOW = Date.parse("2026-10-18T06:00:00Z");
const HASH_CONFIG = { "engage.canary_pct": "10", "engage.canary_offset": "65", "engage.canary_started_at": "2026-10-15T13:47:45+00:00", "engage.rate_test_arms": "", "engage.rate_test_stop_deaths": "3" };

const run = (config: Record<string, string>): ReturnType<typeof report> => report({
  now: NOW, accounts: ACCOUNTS, config, errors: [],
  days: [{ day: "2026-10-17", accountId: 22, pages: 1900 }, { day: "2026-10-17", accountId: 35, pages: 1500 }, { day: "2026-10-17", accountId: 100, pages: 800 }],
  deaths: [{ accountId: 22, at: NOW - 30 * 60_000, status: "challenged", code: "challenge_required", readBefore: true, pages24h: 1900 }],
} satisfies EngageData, []);
const canaryLine = (output: ReturnType<typeof report>): string => (output.flagged ?? []).find(flag => flag.kind === "canary" || flag.kind === "canary_short")!.excerpt;

test("the hash cohort picks the accounts prod picks, and d1 counts 15 of 169 with their pages and deaths", () => {
  assert.deepEqual([...canaryOf(HASH_CONFIG, ACCOUNTS).ids].sort((a, b) => a - b), PROD_COHORT);
  const output = run(HASH_CONFIG);
  const line = canaryLine(output);
  assert.match(line, /^canary from the hash cohort engage.canary_pct 10, engage.canary_offset 65, started 10-15 13:47Z: 15 of 169 active prod accounts/);
  assert.match(line, /they read 3,400 pages on 2026-10-17, the busiest 1,900/);
  assert.match(line, /Instagram killed 1 of them in 24 h and 1 since the start/);
  assert.equal(output.metrics.canary_accounts_short, 2);
  assert.equal(output.metrics.canary_ig_deaths_1h, 1);
  assert.equal(output.metrics.fleet_ig_killed_pct, 0);
});

test("the roster engage.canary_accounts wins over the hash keys once it is set", () => {
  const output = run({ ...HASH_CONFIG, "engage.canary_accounts": "22,35,40" });
  assert.match(canaryLine(output), /^canary from engage.canary_accounts, started 10-15 13:47Z: 2 of 169 active prod accounts \(3 in it with the dead\)/);
  assert.match(canaryLine(output), /add 15 active accounts through engage.canary_accounts$/);
  assert.equal(output.metrics.canary_accounts_short, 15);
  assert.equal(output.metrics.fleet_ig_killed_pct, 0);
});

test("no canary runs without engage.canary_started_at, and a death then counts against the fleet", () => {
  const output = run({ ...HASH_CONFIG, "engage.canary_started_at": "" });
  assert.match(canaryLine(output), /^no canary runs: the hash cohort .* engage.canary_started_at "" is empty/);
  assert.equal(output.metrics.canary_accounts_short, 17);
  assert.equal(output.metrics.fleet_ig_killed_pct, 0.6);
});
