/**
 * A model or thinking level change on an agent (`PATCH /api/c/dm_<agent>`, the Brief tab's model picker) moves its work thread and every comm
 * thread. Until 11-23 a comm thread kept the model its work thread had when the comm thread was made (`threadModel`), so an agent moved to
 * Fable 5.2 still answered in its DM and channels on Opus 5.5.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/comm-model.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let agent: AgentSummary & { room: string; thread: string };

before(async () => {
  s = await start();
  agent = (await s.send<AgentSummary & { room: string; thread: string }>("POST", "/api/agents", { name: "Comm model probe", test: true })).body;
  await s.send("POST", "/api/rooms", { kind: "channel", name: `comm-model-${crypto.randomUUID().slice(0, 8)}`, members: [agent.id], test: true });
});
after(async () => {
  await s.close();
});

const comms = (): string[] => Object.values(s.app.agents.record(agent.id)!.comm ?? {});
const row = (thread: string) => (s.host as FixtureHost).threadsById.get(thread)!.row;

test("a model and thinking level change on the agent's DM moves its work thread and each comm thread", async () => {
  await until(async () => comms(), threads => threads.length === 2);
  const patched = await s.send<{ model: { id: string } }>("PATCH", `/api/c/${agent.room}`, { model: "anthropic/claude-fable-5-2", thinkingLevel: "xhigh" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.model.id, "claude-fable-5-2");
  for (const thread of [agent.thread, ...comms()]) {
    const moved = await until(async () => row(thread), r => r.modelId === "claude-fable-5-2" && r.thinkingLevel === "xhigh");
    assert.equal(`${moved.provider}/${moved.modelId}`, "anthropic/claude-fable-5-2");
  }
});
