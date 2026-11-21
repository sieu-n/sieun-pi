/**
 * Archiving a job inside a thread: `PATCH /api/c/<thread>:<n> {archived}` sets the chat server's own flag, the agent's config, the job list
 * and the jobs under it read it, and `archived: false` brings it back.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/job-archive.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentConfig, AgentSummary } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start({ wordMs: 0 });
});
after(async () => {
  await s.close();
});

const config = () => s.get<AgentConfig>(`/api/agents/${encodeURIComponent(agents.harness)}/config`);
const jobList = (archived = false) => s.get<AgentSummary[]>(`/api/jobs${archived ? "?archived=1" : ""}`);

test("a job inside a thread archives and comes back, with the jobs under it", async () => {
  const before = await config();
  const job = before.swarm.jobs.find(j => j.kind === "job" && j.id.startsWith(`${ids.harness}:`));
  assert.ok(job, "the fixture's harness thread has a job inside it");
  assert.equal(job.archived, false);
  const under = before.swarm.jobs.filter(j => j.parent === job.id).map(j => j.id);

  const res = await s.send("PATCH", `/api/c/${encodeURIComponent(job.id)}`, { archived: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const after = await config();
  assert.equal(after.swarm.jobs.find(j => j.id === job.id)?.archived, true);
  for (const id of under) assert.equal(after.swarm.jobs.find(j => j.id === id)?.archived, true, `${id} goes with the job it runs under`);
  assert.ok(!(await jobList()).some(j => j.id === job.id), "the live job list drops it");
  assert.equal((await jobList(true)).find(j => j.id === job.id)?.archived, true);
  assert.equal(s.app.threads.thread(ids.harness)?.archived, false, "the agent's own thread stays");

  const back = await s.send("PATCH", `/api/c/${encodeURIComponent(job.id)}`, { archived: false });
  assert.equal(back.status, 200);
  assert.equal((await config()).swarm.jobs.find(j => j.id === job.id)?.archived, false);
  assert.ok((await jobList()).some(j => j.id === job.id));
});

test("a job inside a thread still has no name of its own", async () => {
  const job = (await config()).swarm.jobs.find(j => j.kind === "job" && j.id.startsWith(`${ids.harness}:`))!;
  const res = await s.send("PATCH", `/api/c/${encodeURIComponent(job.id)}`, { name: "renamed" });
  assert.notEqual(res.status, 200);
});
