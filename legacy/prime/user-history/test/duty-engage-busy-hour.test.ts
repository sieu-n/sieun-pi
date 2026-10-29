// Goal p229 closed on 10-28 at 0.074 (target at most 0.10) with no duty keeping it; c75 holds d1 at 4 metrics, so d1 keeps it as run detail and a handOff flag.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FEEDS, PACED_SQL, measure, pacedOf, report } from "../scripts/duties/engage-reads.ts";

const now = Date.parse("2026-10-30T00:00:00Z");
const row = (share: string | null) => [{ day: "2026-10-29", share, accts_200plus: "19", hours: "16" }];

test("the paced row parses into the day, share, accounts and hours", () => {
  assert.deepEqual(pacedOf(row("0.091")), { day: "2026-10-29", share: 0.091, accounts: 19, hours: 16 });
  assert.deepEqual(pacedOf(row(null)), { day: "2026-10-29", share: null, accounts: 19, hours: 16 });
  assert.throws(() => pacedOf([]), /paced hours/);
  assert.throws(() => pacedOf([{ day: "x", share: "0.1", accts_200plus: "1", hours: "1" }]), /paced hours/);
});

test("a share at the target is run detail with no flag", () => {
  const out = report({ now, errors: [], paced: pacedOf(row("0.1")) }, []);
  assert.equal(out.metrics.paced_busy_hour_share, 0.1);
  assert.equal(out.metrics.paced_accts_200plus, 19);
  assert.ok(!out.flagged!.some(slice => slice.kind === "busy_hour_share"));
});

test("a share over 0.10 raises a handOff busy_hour_share flag with the value and accts_200plus", () => {
  const out = report({ now, errors: [], paced: pacedOf(row("0.142")) }, []);
  const flag = out.flagged!.find(slice => slice.kind === "busy_hour_share");
  assert.ok(flag);
  assert.equal(flag.handOff, true);
  assert.match(flag.excerpt, /paced_busy_hour_share 0\.142 on 2026-10-29/);
  assert.match(flag.excerpt, /19 prod accounts with 200\+ sends/);
  assert.match(flag.excerpt, /d1\/paced_busy_hour_share/);
});

test("a failed paced read is a source error and leaves no share", async () => {
  assert.deepEqual(FEEDS["prod paced hours"], ["paced_busy_hour_share"]);
  const query = async () => { throw new Error("grafana 502"); };
  const data = await measure(query as never, null, now, async () => "");
  assert.ok(data.errors.some(error => error.source === "prod paced hours"));
  assert.equal(report(data, []).metrics.paced_busy_hour_share, undefined);
});

test("the paced read scores the last full UTC day", () => {
  assert.match(PACED_SQL, /date_trunc\('day', now\(\) at time zone 'UTC'\) - interval '1 day'/);
  assert.match(PACED_SQL, /day_sends >= 200/);
});
