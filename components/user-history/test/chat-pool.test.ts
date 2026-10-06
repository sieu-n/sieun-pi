import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePoolRows, parseRefreshEvent, parseResets, resetsNotice, UsageRefreshes } from "../src/chat-pool.ts";
import type { UsageRefresh } from "../src/shared/types.ts";

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

test("refresh stream lines become events with epoch ms", () => {
  assert.deepEqual(parseRefreshEvent('{"event":"accounts","accounts":[{"id":"a","email":"a@x"},{"bad":1}],"provider":"anthropic"}'),
    { event: "accounts", accounts: [{ id: "a", email: "a@x" }] });
  assert.deepEqual(parseRefreshEvent('{"event":"read","id":"a","ok":false,"reason":"rate limited","retry_at":1790000600,"usage_at":null}'),
    { event: "read", id: "a", ok: false, reason: "rate limited", usageAt: null, retryAt: 1790000600000 });
  assert.equal(parseRefreshEvent("not json"), null);
  assert.equal(parseRefreshEvent('{"event":"reading"}'), null);
});

/** A fake pi-pool that prints the given refresh lines, then exits with `code`. */
function fakePool(root: string, lines: string[], code = 0): string {
  const path = join(root, "pi-pool");
  writeFileSync(path, "#!/bin/sh\necho \"$@\" > " + JSON.stringify(join(root, "args")) + "\n" + lines.map(line => `echo '${line}'`).join("\n") + `\nexit ${code}\n`, { mode: 0o755 });
  return path;
}

async function settle(refreshes: UsageRefreshes, provider: string): Promise<UsageRefresh> {
  return new Promise(resolve => { const stop = refreshes.subscribe(run => { if (run.provider === provider && run.status !== "running") { queueMicrotask(() => stop()); resolve(run); } }); });
}

test("a refresh reports every account's read as it lands, and the failures with their reasons", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-refresh-"));
  try {
    const refreshes = new UsageRefreshes({ executable: fakePool(root, [
      '{"event":"accounts","accounts":[{"id":"a","email":"a@x"},{"id":"b","email":"b@x"}]}',
      '{"event":"reading","id":"a"}', '{"event":"read","id":"a","ok":true,"usage_at":1790000000}',
      '{"event":"reading","id":"b"}', '{"event":"read","id":"b","ok":false,"reason":"rate limited","retry_at":1790000600}', '{"event":"end"}']) });
    const seen: string[] = [];
    refreshes.subscribe(run => seen.push(run.accounts.map(entry => entry.state).join(",")));
    const started = refreshes.start("anthropic", null);
    assert.equal(started.status, "running");
    assert.throws(() => refreshes.start("anthropic", null), /still running/);
    const run = await settle(refreshes, "anthropic");
    assert.equal(run.status, "done");
    assert.deepEqual(run.accounts, [
      { id: "a", email: "a@x", state: "read", reason: null, usageAt: 1790000000000, retryAt: null },
      { id: "b", email: "b@x", state: "failed", reason: "rate limited", usageAt: null, retryAt: 1790000600000 }]);
    assert.ok(seen.includes("reading,queued") && seen.includes("read,reading"), seen.join(" | "));
    assert.equal(readFileSync(join(root, "args"), "utf8").trim(), "refresh --provider anthropic --stream");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one account is refreshed by id, and a read the run never finished is a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-refresh-"));
  try {
    const refreshes = new UsageRefreshes({ executable: fakePool(root, ['{"event":"accounts","accounts":[{"id":"a","email":"a@x"}]}', '{"event":"reading","id":"a"}'], 1) });
    refreshes.start("openai-codex", "a");
    const run = await settle(refreshes, "openai-codex");
    assert.equal(readFileSync(join(root, "args"), "utf8").trim(), "refresh a --provider openai-codex --stream");
    assert.equal(run.account, "a");
    assert.deepEqual(run.accounts.map(entry => [entry.state, entry.reason]), [["failed", "The refresh stopped before this account was read."]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a refresh that cannot start fails with pi-pool's own message", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-refresh-"));
  try {
    const refreshes = new UsageRefreshes({ executable: fakePool(root, ['{"event":"error","message":"tokenmaxxing is not installed"}'], 1) });
    refreshes.start("anthropic", null);
    const run = await settle(refreshes, "anthropic");
    assert.equal(run.status, "failed");
    assert.equal(run.message, "tokenmaxxing is not installed");
    assert.throws(() => refreshes.start("grok", null), /pooled provider/);
    assert.throws(() => refreshes.start("anthropic", "--all"), /Choose an account/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Claude row's resets parse with times in epoch ms, and a claim with no answer is pending", () => {
  const resets = parseResets({ checked_at: 1791282989, pending: { grant_id: "g1", created_at: 1791283000 }, status: { eligible: true, ineligible_reason: null, at_limit: false,
    next_grant_id: "g1", cooldown_until: null, grants: [{ id: "g1", label: "Launch reset", resets_total: 1, resets_left: 1, starts_at: "2026-09-22T16:00:00+00:00",
      ends_at: "2026-10-22T16:00:00+00:00", clears: ["five_hour", 3], paused: false, usable_now: true, use_requires_limit: false }, { bad: true }] } });
  assert.deepEqual(resets, { checkedAt: 1791282989000, eligible: true, ineligibleReason: null, atLimit: false, cooldownUntil: null, nextGrantId: "g1", error: null, errorAt: null,
    pending: { grantId: "g1", createdAt: 1791283000000 },
    grants: [{ id: "g1", label: "Launch reset", resetsTotal: 1, resetsLeft: 1, startsAt: Date.parse("2026-09-22T16:00:00+00:00"), endsAt: Date.parse("2026-10-22T16:00:00+00:00"),
      clears: ["five_hour"], paused: false, usableNow: true, useRequiresLimit: false }] });
  const failed = parseResets({ error: "rate limited", error_at: 1791282989 });
  assert.equal(failed?.eligible, null);
  assert.equal(failed?.errorAt, 1791282989000);
  assert.equal(parseResets(null), null);
});

test("the resets notice counts the reads and names the failures", () => {
  assert.equal(resetsNotice({ accounts: [{ email: "a@x", status: {} }, { email: "b@x", error: "rate limited" }] }), "Resets read for 1 of 2 accounts. b@x: rate limited.");
  assert.equal(resetsNotice({ accounts: [{ email: "a@x", status: {} }] }), "Resets read for a@x.");
  assert.equal(resetsNotice({ error: "only Claude accounts have resets" }), "only Claude accounts have resets");
});
