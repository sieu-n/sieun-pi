import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// chat-pool.ts reads PI_POOL_BIN at import, so the fake pool is in place first.
const root = mkdtempSync(join(tmpdir(), "chat-pool-wait-"));
const who = { session: "s1", priority: "low", providers: { anthropic: { account: "c7", email: "c7@x", label: "c7@x", reason: "stay", pinned: false, wait: { account: "c7", slot_at: 1791790000 } } } };
const row = { id: "c7", email: "c7@x", label: "c7@x", usage: "100%/40%", session_pct: 100, weekly_pct: 40, usable: false, reason: "depleted", current: true, pinned: false, live: false, seat: false, windows: [] };
const ls = (provider: string) => JSON.stringify({ provider, session: "s1", pin: null, priority: "low", wait: provider === "anthropic" ? { account: "c7", slot_at: 1791790000 } : null, rows: provider === "anthropic" ? [row] : [] });
writeFileSync(join(root, "pi-pool"), [
  "#!/bin/sh",
  `echo "$@" >> ${JSON.stringify(join(root, "args"))}`,
  `case "$1" in`,
  `  who) echo '${JSON.stringify(who)}' ;;`,
  `  config) echo '{}' ;;`,
  `  ls) case "$*" in *openai-codex*) echo '${ls("openai-codex")}' ;; *) echo '${ls("anthropic")}' ;; esac ;;`,
  `  *) echo '{}' ;;`,
  "esac",
].join("\n") + "\n", { mode: 0o755 });
process.env.PI_POOL_BIN = join(root, "pi-pool");
const { listAccounts, runAccountAction, setPoolPriority } = await import("../src/chat-pool.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("the accounts view carries the thread's pool priority and its wait, from rows that have no force field", async () => {
  const view = await listAccounts("s1");
  const claude = view.providers.find(provider => provider.provider === "anthropic")!;
  assert.equal(view.priority, "low");
  assert.deepEqual(claude.wait, { account: "c7", slotAt: 1791790000000 });
  assert.equal(claude.rows[0]!.id, "c7");
  assert.equal(view.providers.find(provider => provider.provider === "openai-codex")!.wait, null);
});

test("use sends no --force, and a priority set names the session", async () => {
  await runAccountAction({ action: "use", provider: "anthropic", account: "c7", id: "s1" });
  await setPoolPriority("s1", "high");
  const args = readFileSync(join(root, "args"), "utf8").trim().split("\n");
  assert.ok(args.includes("use c7 --provider anthropic --session s1"), args.join(" | "));
  assert.ok(args.includes("priority high --session s1"));
  assert.ok(!args.some(line => line.includes("--force")));
});
