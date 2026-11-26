/**
 * A step a job thread adds to its agent's board with no owner names that job: on 11-26 and 11-27 gpt guy's Area review duty jobs added goals
 * p11 and p17 with no job, and d9 counted them stuck while their child jobs worked. The work thread's own steps, and a step that names its
 * owner, keep what the op says.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-job-owner.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, BoardView } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let agent: AgentSummary;
let job: { id: string; name: string };

before(async () => {
  s = await start({ wordMs: 0 });
  agent = (await s.send("POST", "/api/agents", { name: "board job owner" })).body;
  await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
  const row = (s.host as FixtureHost).addThread({ name: "d2 Area review 11-27", createdAt: Date.now() }).row;
  await s.app.threads.refresh();
  s.app.agents.alias(row.id, agent.id);
  job = { id: row.id, name: row.name };
});
after(() => s.close());

const add = (thread: string, op: Record<string, unknown>) =>
  s.send<BoardView>("POST", `/api/threads/${thread}/board`, { actor: "agent", ops: [{ op: "plan_add", ...op }] });

test("a job's plan_add with no owner comes back owned by that job", async () => {
  const answer = await add(job.id, { text: "Resolve findings from today's area review" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const goal = answer.body.board!.plan.at(-1)!;
  assert.equal(goal.sessionId, job.id);
  assert.equal(goal.job, job.name);
});

test("the work thread's step and a step that names its owner keep what the op says", async () => {
  const own = (await add(agent.thread, { text: "The work thread's own step" })).body.board!.plan.at(-1)!;
  assert.equal(own.job, undefined);
  assert.equal(own.sessionId, undefined);
  const named = (await add(job.id, { text: "A step for a subagent", job: "area-review-docs" })).body.board!.plan.at(-1)!;
  assert.equal(named.job, "area-review-docs");
  assert.equal(named.sessionId, undefined);
});
