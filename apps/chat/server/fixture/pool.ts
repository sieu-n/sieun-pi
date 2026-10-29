/**
 * The fake pi-pool behind --fixture (fake-pi-pool.mjs). `useFakePool` points the old chat's chat-pool.ts at it for this process, so no fixture
 * run reaches the real pool or its hookd socket, and seeds a pool record for each fixture thread.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_IDS } from "./seed.ts";

const FAKE = join(import.meta.dirname, "fake-pi-pool.mjs");
const STATE = "fake-pi-pool.json";

/** A seeded tree: its class, a Manual pick per provider, and an admission wait. */
interface FakeTree { priority?: "high" | "normal" | "low"; pins?: Record<string, string>; wait?: { provider: string; account: string; inSec: number } }

/**
 * A record per thread, as pi-host's first request makes one. The harness VP keeps a Manual pick and a high class, the Crawler VP waits 40 min
 * for claude-limited at low class, and the solo chat has sent no request, so it has no record.
 */
function fakeTrees(threads: readonly string[]): Record<string, FakeTree> {
  const roles: Record<string, FakeTree> = {
    [FIXTURE_IDS.harness]: { priority: "high", pins: { anthropic: "claude-stale" } },
    [FIXTURE_IDS.crawler]: { priority: "low", wait: { provider: "anthropic", account: "claude-limited", inSec: 40 * 60 } },
  };
  return Object.fromEntries(threads.filter(id => id !== FIXTURE_IDS.solo).map(id => [`pi-durable:${id}`, roles[id] ?? {}]));
}

/** Points PI_POOL_BIN and PI_POOL_DIR at the fake for this process and writes its seed state under `dataDir`. */
export function useFakePool(dataDir: string, threads: readonly string[]): void {
  process.env.PI_POOL_BIN = FAKE;
  process.env.PI_POOL_DIR = join(dataDir, "pi-pool");
  process.env.FAKE_PI_POOL_TREES = JSON.stringify(fakeTrees(threads));
  reseedFakePool();
}

export function reseedFakePool(): void {
  execFileSync(FAKE, ["fake-seed"], { env: process.env });
}

export function fakePoolState(): unknown {
  return JSON.parse(readFileSync(join(process.env.PI_POOL_DIR ?? "", STATE), "utf8"));
}
