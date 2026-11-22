/**
 * The next server starts on the thread list this one saved (threads.ts `start`), so that list holds every thread this server knew when it
 * stopped, one made since its last list read too. On 11-22 a hand-over came 3 s after the Agent memory duty made 12 test agents, the new
 * server served a saved list without them, and the duty's 12 sends got 404 "No thread".
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/threads-cache.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { drained } from "../../server/disk.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { Store } from "../../server/store.ts";
import { Threads, type ThreadEvents } from "../../server/threads.ts";

test("a thread made after the last list read is in the list the next server starts on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threads-cache-"));
  const events = new Proxy({}, { get: () => () => {} }) as ThreadEvents;
  try {
    const host = new FixtureHost();
    const before = new Threads(host, new Store(dir), events, "test-box");
    await before.start(60_000);
    // No list read of this server ends before it stops, as when the stop comes within the 2 s between two reads.
    host.threads = () => new Promise(() => {});
    const made = await before.create({ name: "made just before the stop" });
    before.put(made);
    await before.stop();
    await drained();
    // The next server's host has not listed the thread yet, as a pi-host read that has not ended.
    const after = new Threads(new FixtureHost(), new Store(dir), events, "test-box");
    assert.equal(after.thread(made.id)?.id, made.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
