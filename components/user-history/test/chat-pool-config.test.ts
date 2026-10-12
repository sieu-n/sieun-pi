import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** A fake pi-pool: `config` prints this Mac's settings, `ls` an empty pool, `who` no resolution. Set before chat-pool.ts loads, which reads PI_POOL_BIN once. */
const dir = mkdtempSync(join(tmpdir(), "pool-config-"));
const fake = join(dir, "pi-pool");
writeFileSync(fake, `#!/bin/sh
case "$1" in
  config) echo '{"admit_5h_max_pct": 70, "low_admit_5h_max_pct": 50, "seven_day_max_pct": 98, "max_moves_per_day": {"high": 6, "normal": 3, "low": 1}, "allow_active_account": true, "switch_models": ["fable"]}' ;;
  ls) printf '{"provider": "%s", "rows": []}\\n' "$4" ;;
  who) echo '{"providers": {}}' ;;
esac
`);
chmodSync(fake, 0o755);
process.env.PI_POOL_BIN = fake;
const { listAccounts, parsePoolConfig } = await import("../src/chat-pool.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("the accounts view carries the numeric settings of pi-pool config", async () => {
  const view = await listAccounts(null);
  assert.deepEqual(view.poolConfig, { admit_5h_max_pct: 70, low_admit_5h_max_pct: 50, seven_day_max_pct: 98 });
  assert.deepEqual(view.providers.map(provider => [provider.provider, provider.rows.length, provider.error]), [["anthropic", 0, undefined], ["openai-codex", 0, undefined]]);
});

test("pool config keeps finite numbers only and is null for anything but an object", () => {
  assert.deepEqual(parsePoolConfig({ a: 1, b: "x", c: Number.NaN, d: [1], e: 2.5 }), { a: 1, e: 2.5 });
  assert.equal(parsePoolConfig(null), null);
  assert.equal(parsePoolConfig([1, 2]), null);
});
