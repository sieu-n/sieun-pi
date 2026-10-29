#!/usr/bin/env node
// A stand-in for pi-pool-token in tests and rigs. FAKE_POOL_DIR holds state.json, which the test writes, and calls.jsonl,
// one line per run with its argv and the session key, so a test can see which tree each call spoke for.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_POOL_DIR;
const statePath = join(dir, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ at: Date.now(), argv, key: process.env.PI_POOL_SESSION_KEY ?? null, protocol: process.env.PRIME_CREDENTIAL_COMMAND_PROTOCOL ?? null, agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR ?? null }) + "\n");
const save = () => writeFileSync(statePath, JSON.stringify(state));
const now = Date.now() / 1000;
const auto = { mode: "auto" };

if (argv[0] !== "--cli") {
  const provider = argv[1] ?? "anthropic";
  // waitSec starts the slot wait at the first vend, so a slow worker start cannot use it up before the request.
  if (state.waitSec !== undefined && state.waitUntil === undefined) {
    state.waitUntil = now + state.waitSec;
    save();
  }
  if ((state.waitUntil ?? 0) > now) {
    process.stdout.write(JSON.stringify({ retryAt: state.waitUntil, message: "waiting for an account slot" }));
    process.exit(75);
  }
  if ((state.failTimes ?? 0) > 0) {
    state.failTimes--;
    save();
    process.stderr.write("pi-pool-token: no token (no_account)\n");
    process.exit(1);
  }
  const account = state.accounts[state.current];
  process.stdout.write(provider === "openai-codex" ? `codex-token-${account}` : `sk-ant-oat01-${account}`);
  process.exit(0);
}

const verb = argv[1];
const say = value => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};
if (verb === "limited") {
  const until = Number(argv[argv.indexOf("--until") + 1]);
  const account = state.accounts[state.current];
  if (state.current + 1 < state.accounts.length) {
    state.current++;
    save();
    say({ selection: auto, account, until, next: state.accounts[state.current] });
  }
  state.waitUntil = now + (state.slotAfterSec ?? 5);
  save();
  say({ selection: auto, account, until, next: null, retry_at: state.waitUntil });
}
if (verb === "refused") say({ selection: auto, account: state.accounts[state.current], reason: null });
if (verb === "admit") {
  if ((state.queuedTimes ?? 0) > 0) {
    state.queuedTimes--;
    save();
    say({ state: "queued", kind: null, position: 2, total: 3 });
  }
  say({ state: "admitted", kind: "run", position: null, total: null });
}
if (verb === "release") say({ state: "released", kind: null, position: null, total: null });
if (verb === "who") say({ providers: { anthropic: { selection: auto, current: { id: "a", email: "a@x", label: state.accounts[state.current], session_pct: 10, weekly_pct: 20, gated_pct: 0, next: false } } } });
if (verb === "adopt-logins" || verb === "probe" || verb === "model") process.exit(0);
say({ error: `fake pool has no ${verb}` });
