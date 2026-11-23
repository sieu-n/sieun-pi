/**
 * A duty card names its newest job and says whether it works (duty-card.ts `jobLive`), so a job that starts or stops working changes the
 * chat's duty rows, and the server sends them as a `duties` event. Before, only a duties file write or a run's start and end sent one, and
 * the page's kept rows stayed as they were: in the p155 sweep on 11-23 the next room open's refresh of agent factory's duties changed the
 * card and waited 1,214 ms (~/work/p155-sweep/fix-duties/notes.md).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duties-job-event.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { DutyFile } from "../../server/boards.ts";
import type { DutyRow, LiveEvent } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import type { TreeNode } from "../../server/host/types.ts";
import { start, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const now = Date.now();
let s: Running;
let job: TreeNode;

type DutiesEvent = Extract<LiveEvent, { type: "duties" }>;
const isVentDuties = (event: LiveEvent): event is DutiesEvent => event.type === "duties" && event.chatId === agents.vent;
const rows = async (): Promise<DutyRow[]> => (await s.get<{ duties: DutyRow[] }>(`/api/agents/${agents.vent}/duties`)).duties;

before(async () => {
  s = await start();
  const host = s.host as FixtureHost;
  const thread = host.threadsById.get(ids.vent)!;
  job = host.addChild(thread, 1, "uptime fix", now, "idle");
  thread.row.updatedAt = now + 1;
  await s.app.threads.refresh();
  const metric = { key: "up", label: "Up", op: ">=" as const, target: 99, headline: true };
  const duty = { id: "d1", name: "Uptime", ownerWords: "keep it up", goal: "it stays up", metrics: [metric], schedule: { kind: "daily", at: "07:04" },
    onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now - HOUR, runCount: 1 };
  const run = { duty: "d1", at: now - HOUR, slot: now - HOUR, trigger: "schedule", ms: 900, verdict: "missed", summary: "up 90",
    metrics: { up: { value: 90, target: 99, op: ">=", met: false } }, job: { id: "uptime-fix", name: "uptime fix" } };
  await s.app.boards.saveDuties(agents.vent, { duties: [duty], runs: { d1: [run] } } as unknown as DutyFile);
});
after(async () => {
  await s.close();
});

test("a job that starts or stops working sends its agent's duty rows, and a job's other changes send none", async () => {
  assert.equal((await rows())[0]!.card.job?.live, false);
  const live = await s.live();
  const thread = (s.host as FixtureHost).threadsById.get(ids.vent)!;

  job.status = "running";
  thread.row.updatedAt += 1;
  await s.app.threads.refresh();
  const working = await live.waitFor(isVentDuties, 5_000);
  assert.equal(working.duties[0]!.card.job?.live, true);
  assert.deepEqual(working.duties, await rows());

  // A thread list read that changes nothing a duty row shows sends no duties event.
  const sent = live.events.filter(isVentDuties).length;
  thread.row.updatedAt += 1;
  await s.app.threads.refresh();
  assert.equal(live.events.filter(isVentDuties).length, sent);

  job.status = "idle";
  thread.row.updatedAt += 1;
  await s.app.threads.refresh();
  const idle = await live.waitFor((event): event is DutiesEvent => isVentDuties(event) && event.duties[0]!.card.job?.live === false, 5_000);
  assert.deepEqual(idle.duties, await rows());
});
