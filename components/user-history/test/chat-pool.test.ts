import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePoolRows, refreshNotice, runAccountAction } from "../src/chat-pool.ts";

const base = { id: "a", email: "a@x", usage: "7%/61%", session_pct: 7, weekly_pct: 61, gated_pct: 100, usable: false, reason: "depleted",
  current: false, pinned: false, force: false, live: false, seat: true, score: null };

test("pool rows carry every window with its reset in epoch ms", () => {
  const [row] = parsePoolRows({ provider: "anthropic", rows: [{ ...base, tier: "max 20x", usage_at: 1790120343, cooldown_until: null, cooldown_reason: null, windows: [
    { kind: "session", label: "5h", name: null, pct: 7, window_sec: 18000, resets_at: 1790133600, sampled_at: 1790120343 },
    { kind: "weekly", label: "week", name: null, pct: 61, window_sec: 604800, resets_at: null, sampled_at: 1790120343 },
    { kind: "model", label: "Fable", name: "Fable", pct: 100, window_sec: 604800, resets_at: 1790125200, sampled_at: 1790120343 },
    { kind: "bogus", label: "x", pct: 1 },
  ] }] }, "anthropic");
  assert.deepEqual(row!.windows, [
    { kind: "session", label: "5h", pct: 7, resetsAt: 1790133600000 },
    { kind: "weekly", label: "week", pct: 61, resetsAt: null },
    { kind: "model", label: "Fable", pct: 100, resetsAt: 1790125200000 },
  ]);
  assert.equal(row!.tier, "max 20x");
  assert.equal(row!.usageAt, 1790120343000);
});

test("a refused row keeps its cooldown end and reason", () => {
  const [row] = parsePoolRows({ provider: "anthropic", rows: [{ ...base, reason: "cooldown 18h20m", cooldown_until: 1790186635, cooldown_reason: "oauth not allowed for organization", windows: [] }] }, "anthropic");
  assert.equal(row!.cooldownUntil, 1790186635000);
  assert.equal(row!.cooldownReason, "oauth not allowed for organization");
});

test("the refresh notice names only the accounts that could not be read", () => {
  assert.equal(refreshNotice({ providers: { anthropic: [{ email: "a@x", ok: true }], "openai-codex": [{ email: "c@x", ok: true }] } }), "Usage updated for 2 accounts.");
  assert.equal(refreshNotice({ providers: { anthropic: [{ email: "a@x", ok: true }, { email: "b@x", ok: false, reason: "usage read failed (see log)" }] } }),
    "Usage updated for 1 of 2 accounts. b@x: usage read failed (see log).");
  assert.throws(() => refreshNotice({ error: "x" }));
});

test("refresh runs pi-pool against an isolated pool and tokenmaxxing", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-pool-"));
  const saved = { pool: process.env.PI_POOL_DIR, tm: process.env.TOKENMAXXING_HOME };
  try {
    mkdirSync(join(root, "tm", "bin"), { recursive: true });
    mkdirSync(join(root, "pool"));
    const report = { ok: true, claude: { accounts: [{ id: "a", email: "a@x", sample: { ok: false, reason: "usage read failed (see log)" } }] }, codex: { accounts: [] } };
    writeFileSync(join(root, "tm", "bin", "tokenmaxxing"), `#!/bin/sh\necho '${JSON.stringify(report)}'\n`, { mode: 0o755 });
    process.env.PI_POOL_DIR = join(root, "pool");
    process.env.TOKENMAXXING_HOME = join(root, "tm");
    assert.equal(await runAccountAction({ action: "refresh", provider: "anthropic" }), "Usage updated for 0 of 1 accounts. a@x: usage read failed (see log).");
  } finally {
    for (const [name, value] of [["PI_POOL_DIR", saved.pool], ["TOKENMAXXING_HOME", saved.tm]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
