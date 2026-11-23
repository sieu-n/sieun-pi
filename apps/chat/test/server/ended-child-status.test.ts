/**
 * A job whose run ended while its thread's root was idle reads idle in GET /api/jobs. pi-host leaves a thread row's updatedAt alone when
 * a child run ends with no root entry, as a removed job's does, so "thread open walk" (28350de8, conversation 73) read working 89 h after
 * its last entry on 11-24.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/ended-child-status.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

test("a job whose run ended with no change to its thread's row reads idle at the next list read", async () => {
  const host = s.host as FixtureHost;
  const thread = host.threadsById.get(ids.vent)!;
  const child = host.addChild(thread, 1, "ended walk", Date.now(), "running");
  thread.row.status = "running";
  thread.row.updatedAt = Date.now() + 1;
  await s.app.threads.refresh();
  const id = `${ids.vent}:${child.id}`;
  const statusIn = async () => ((await s.get<AgentSummary[]>("/api/jobs")).find(j => j.id === id))?.status;
  assert.equal(await statusIn(), "working");

  // The run ends: pi-host clears the thread's wake, and nothing moves the row's updatedAt.
  child.status = "idle";
  thread.row.status = "idle";
  await s.app.threads.refresh();
  assert.equal(await statusIn(), "idle");
  assert.equal(s.app.threads.statusOfConversation(ids.vent, child.id), "idle");
});
