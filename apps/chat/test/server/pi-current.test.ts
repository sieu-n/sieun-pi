/**
 * The pi-current duty precheck (scripts/duties/pi-current.ts): each pinned @earendil-works/* package counts the stable releases after its pin
 * up to npm latest, the headline is the package furthest behind, and vendored Prime is flagged when its check fails.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/pi-current.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { newer, piCurrent, pins } from "../../scripts/duties/pi-current.ts";

/** npm's versions of @earendil-works/pi-ai from 1.3.0 on, as of 11-26, with a prerelease added. */
const VERSIONS = ["1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.6.0-rc.1", "1.6.0", "1.6.1"];
const pkg = (name: string, pinned: string, latest = "1.6.1") => ({ name, pinned, latest, versions: VERSIONS });

test("the pins are the @earendil-works dependencies of package.json, without a range sign", () => {
  const json = JSON.stringify({ dependencies: { "@earendil-works/pi-ai": "1.4.0", "@earendil-works/chord": "^1.4.0", tsx: "^4.0.0" }, devDependencies: { "@earendil-works/pi-durable": "~1.4.0" } });
  assert.deepEqual(pins(json), { "@earendil-works/pi-durable": "1.4.0", "@earendil-works/pi-ai": "1.4.0", "@earendil-works/chord": "1.4.0" });
});

test("a pin is behind by the stable releases after it up to latest, and a pin at latest by none", () => {
  assert.deepEqual(newer(pkg("@earendil-works/pi-ai", "1.4.0")), ["1.5.0", "1.5.1", "1.5.2", "1.6.0", "1.6.1"]);
  assert.deepEqual(newer(pkg("@earendil-works/pi-ai", "1.6.1")), []);
  assert.deepEqual(newer(pkg("@earendil-works/pi-ai", "1.5.2", "1.6.0")), ["1.6.0"]);
});

test("the headline is the package furthest behind, with a flag per package behind and one for vendored Prime", () => {
  const out = piCurrent([pkg("@earendil-works/pi-ai", "1.4.0"), pkg("@earendil-works/chord", "1.6.0"), pkg("@earendil-works/pi-durable", "1.6.1")],
    { behind: true, line: "vendor/prime-harness.ts differs from d5d28f65cf82b5d71a41eea1e583a5dc495871be (test.52); run node scripts/vendor-prime-harness.mjs" });
  assert.deepEqual(out.metrics, { pi_releases_behind: 5, packages_behind: 2, prime_vendor_behind: 1, packages_checked: 3 });
  assert.deepEqual(out.flagged.map(f => f.sig), ["@earendil-works/pi-ai@1.6.1", "@earendil-works/chord@1.6.1", "prime@d5d28f65cf82b5d71a41eea1e583a5dc495871be"]);
  assert.equal(out.flagged[1]!.excerpt, "@earendil-works/chord is pinned at 1.6.0 in packages/pi-host/package.json, 1 release behind npm latest 1.6.1 (1.6.1)");
});

test("everything at latest with vendored Prime matching reads 0 behind and no flag", () => {
  const out = piCurrent([pkg("@earendil-works/pi-ai", "1.6.1")], { behind: false, line: "match" });
  assert.deepEqual(out, { metrics: { pi_releases_behind: 0, packages_behind: 0, prime_vendor_behind: 0, packages_checked: 1 }, flagged: [] });
});
