/**
 * A feed poll's read marks outlast a hand-over (rooms.ts `keepSeen`, `readSeen`), so a new server reads only the feeds whose thread
 * changed, and a feed whose read was still going at the stop reads again.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/feed-seen.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { drained } from "../../server/disk.ts";
import { keepSeen, readSeen } from "../../server/rooms.ts";
import { Store } from "../../server/store.ts";

test("read marks come back after a stop, without the feeds still reading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-seen-"));
  try {
    const store = new Store(dir);
    assert.equal(readSeen<string>(store, "feed-seen-dm").size, 0);
    const seen = new Map([["ag_a", "t1@100"], ["ag_b", "t2@200"], ["ag_c", "t3@300"]]);
    keepSeen(store, "feed-seen-dm", seen, new Map([["ag_b", Promise.resolve()]]), new Set(["ag_c"]));
    await drained();
    // The next server reads them back.
    assert.deepEqual([...readSeen<string>(new Store(dir), "feed-seen-dm")], [["ag_a", "t1@100"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
