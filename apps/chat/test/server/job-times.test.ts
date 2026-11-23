/**
 * A thread's change sends only the jobs that changed with it. On 11-23 every job carried its thread's time, so each change of agent
 * factory's work thread sent its 390 jobs again as 780 job and conversation events within 1 s, and a page that took them held a ⌘K answer
 * up to 950 ms after its network ended (~/work/p224-search-page).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/job-times.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FixtureHost } from "../../server/host/fixture.ts";
import type { LiveEvent } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
  await s.app.threads.refresh();
});
after(async () => {
  await s.close();
});

const IDLE = 30;
const ofThread = (events: readonly LiveEvent[], thread: string): string[] => events.flatMap(event =>
  event.type === "conversation" && event.conversation.id.startsWith(`${thread}:`) ? [event.conversation.id]
    : event.type === "job" && event.job.thread === thread ? [event.job.id] : []);

test("a thread's new activity sends its running job again and none of its idle jobs, and a job that ends takes the time it ended", async () => {
  const host = s.host as FixtureHost;
  const start = Date.now() - 60_000;
  const thread = host.addThread({ name: "Job times", createdAt: start });
  const idle = Array.from({ length: IDLE }, (_, i) => host.addChild(thread, 1, `idle job ${i}`, start));
  const running = host.addChild(thread, 1, "running job", start, "running");
  thread.row.status = "running";
  thread.row.updatedAt = start + 1_000;
  await s.app.threads.refresh();
  const live = await s.live();

  thread.row.updatedAt = start + 2_000;
  await s.app.threads.refresh();
  const id = (node: { id: number }) => `${thread.row.id}:${node.id}`;
  // The running job is the thread's last, so its event comes after every other one the read sends.
  await live.waitFor(event => event.type === "conversation" && event.conversation.id === id(running));
  assert.deepEqual([...new Set(ofThread(live.events, thread.row.id))], [id(running)], "only the running job goes out again");
  const times = new Map(s.app.threads.allSummaries().map(job => [job.id, job.updatedAt]));
  assert.equal(times.get(id(running)), start + 2_000, "a running job keeps its thread's time");
  for (const node of idle) assert.equal(times.get(id(node)), start + 1_000, "an idle job keeps the time it was first seen");

  running.status = "idle";
  thread.row.status = "idle";
  thread.row.updatedAt = start + 3_000;
  await s.app.threads.refresh();
  thread.row.updatedAt = start + 4_000;
  await s.app.threads.refresh();
  const ended = new Map(s.app.threads.allSummaries().map(job => [job.id, job.updatedAt]));
  assert.equal(ended.get(id(running)), start + 3_000, "a job that ended keeps the time it ended");
  assert.equal(ended.get(id(idle[0]!)), start + 1_000);
});
