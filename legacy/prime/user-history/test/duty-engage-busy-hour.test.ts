// Goal p229 closed on 10-28 at 0.074 (target at most 0.10) with no duty keeping it; c75 holds d1 at 4 metrics, so d1 keeps it as run detail and a handOff flag.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AccountHour, FEEDS, PACED_HOURS_FLOOR, measure, pacedOf, report } from "../scripts/duties/engage-reads.ts";

const now = Date.parse("2026-10-30T00:00:00Z");
const day = "2026-10-29";
const cell = (accountId: number, hour: number, sends: number, extra: Partial<AccountHour> = {}): AccountHour => ({ day, hour, accountId, sends, busy: 1, pages: sends, transport: 0, ...extra });
/** `accounts` accounts read `perHour` sends with a pace refusal in each of `hours`, and `top` in the first one. */
const day0 = (accounts: number, hours: readonly number[], perHour: number, top = perHour): AccountHour[] =>
  Array.from({ length: accounts }, (_, i) => i + 1).flatMap(id => hours.map((hr, k) => cell(id, hr, k === 0 ? top : perHour)));
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, k) => from + k);

test("the paced rows score the median account's busiest hour over its day's sends", () => {
  // 24 hours at 20 a sends, the busiest at 60: 60 / 520.
  assert.deepEqual(pacedOf(day0(3, range(0, 24), 20, 60), day, new Set()), { day, share: 0.115, accounts: 3, hours: 24 });
  assert.equal(pacedOf(day0(3, range(0, 24), 5), day, new Set()).share, null, "no account sent 200");
  assert.equal(pacedOf(day0(3, range(0, 24), 20, 60).map(row => ({ ...row, day: "2026-10-28" })), day, new Set()).accounts, 0, "only the scored day counts");
});

test("a share at the target is run detail with no flag", () => {
  const out = report({ now, errors: [], paced: pacedOf(day0(19, range(0, 20), 20, 40), day, new Set()) }, []);
  assert.equal(out.metrics.paced_busy_hour_share, 0.095);
  assert.equal(out.metrics.paced_accts_200plus, 19);
  assert.equal(out.metrics.paced_serveable_hours, 20);
  assert.ok(!out.flagged!.some(slice => slice.kind === "busy_hour_share"));
});

test("a share over 0.10 raises a handOff busy_hour_share flag with the value and accts_200plus", () => {
  const out = report({ now, errors: [], paced: pacedOf(day0(19, range(0, 24), 20, 90), day, new Set()) }, []);
  const flag = out.flagged!.find(slice => slice.kind === "busy_hour_share");
  assert.ok(flag);
  assert.equal(flag.handOff, true);
  assert.match(flag.excerpt, /paced_busy_hour_share 0\.164 on 2026-10-29/);
  assert.match(flag.excerpt, /19 prod accounts with 200\+ sends/);
  assert.match(flag.excerpt, /d1\/paced_busy_hour_share/);
});

test("a supply-hold day is not scored: held and transport-dead hours serve nothing (GeoNode hold, 11-09)", () => {
  // Even reads 00Z to 07Z, every read failed on transport at 08Z, and the hold covered 08Z to 23Z: 0.135 before, 8 serveable hours now.
  const rows = [...day0(19, range(0, 8), 43, 54), ...Array.from({ length: 19 }, (_, i) => cell(i + 1, 8, 260, { busy: 50, pages: 0, transport: 260 }))];
  const paced = pacedOf(rows, day, new Set(range(8, 24).map(hr => `${day} ${hr}`)));
  assert.deepEqual(paced, { day, share: null, accounts: 19, hours: 8 });
  assert.ok(8 < PACED_HOURS_FLOOR);
  const out = report({ now, errors: [], paced }, []);
  assert.equal(out.metrics.paced_busy_hour_share, undefined);
  assert.ok(!out.flagged!.some(slice => slice.kind === "busy_hour_share"));
});

test("a burst in a held hour leaves the day's score", () => {
  const rows = [...day0(19, range(0, 20), 20), ...Array.from({ length: 19 }, (_, i) => cell(i + 1, 21, 200))];
  assert.equal(pacedOf(rows, day, new Set()).share, 0.333);
  assert.equal(pacedOf(rows, day, new Set([`${day} 21`])).share, 0.05);
});

test("a failed read log or supply hold read is a source error and leaves no share", async () => {
  assert.ok(FEEDS["prod read log"].includes("paced_busy_hour_share") && FEEDS["prod supply holds"].includes("paced_busy_hour_share"));
  const query = async () => { throw new Error("grafana 502"); };
  const data = await measure(query as never, null, now, async () => "");
  assert.ok(data.errors.some(error => error.source === "prod read log"));
  assert.ok(data.errors.some(error => error.source === "prod supply holds"));
  assert.equal(report(data, []).metrics.paced_busy_hour_share, undefined);
});

