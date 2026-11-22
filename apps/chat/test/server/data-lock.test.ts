/**
 * The data dir's lock (server/handoff.ts DataLock): one server per data dir, and a first start makes the data dir it names.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/data-lock.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DataLock } from "../../server/handoff.ts";

test("the lock makes a data dir that does not exist yet, and a second holder is refused until the first lets go", () => {
  const root = mkdtempSync(join(tmpdir(), "apps-chat-data-lock-"));
  try {
    const file = join(root, "new", "data", "server.lock");
    const first = new DataLock(file);
    assert.equal(first.take(), null);
    assert.ok(existsSync(file));
    const second = new DataLock(file);
    assert.match(second.take() ?? "", /holds/);
    first.release();
    assert.equal(second.take(), null);
    second.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
