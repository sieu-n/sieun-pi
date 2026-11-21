/**
 * A change to an agent through its DM (`PATCH /api/c/dm_<agent>`) and a new agent (`POST /api/agents`) answer without a thread list read. On
 * 11-21 both waited for one: the owner's model change on dm_agent-factory took 590 to 1830 ms in the handler, since the read lists 979 threads
 * and waits for the Mac's relay too, while a channel's PATCH took 4 to 11 ms (p187). Here the list read takes 800 ms, and each answer must
 * come in under 300 ms and show the change, also on reads right after it and after a read that started before the change.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/patch-speed.test.ts
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { AgentSummary, ConversationHeader } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

const READ_MS = 800;
let s: Running;
let agent: AgentSummary & { room: string };

before(async () => {
  s = await start();
  agent = (await s.send<AgentSummary & { room: string }>("POST", "/api/agents", { name: "Patch speed probe", thinkingLevel: "low", test: true })).body;
  const host = s.host as FixtureHost;
  const read = host.threads.bind(host);
  // The rows as they stood when the read began, answered READ_MS later, as pi-host's list read of 11-21.
  host.threads = async opts => {
    const rows = await read(opts);
    await sleep(READ_MS);
    return rows;
  };
});
after(async () => {
  await s.close();
});

const timed = async <T>(method: string, path: string, body: unknown): Promise<{ ms: number; status: number; body: T }> => {
  const started = performance.now();
  const answer = await s.send<T>(method, path, body);
  return { ms: performance.now() - started, ...answer };
};
const listed = (id: string): AgentSummary | undefined => s.app.threads.agent(id);

test("a thinking level change on an agent's DM answers in under 300 ms with the new level", async () => {
  const patched = await timed<ConversationHeader>("PATCH", `/api/c/${agent.room}`, { thinkingLevel: "high" });
  assert.equal(patched.status, 200);
  assert.ok(patched.ms < 300, `PATCH took ${patched.ms.toFixed(0)} ms`);
  assert.equal(patched.body.thinkingLevel, "high");
  assert.equal(listed(agent.id)?.thinkingLevel, "high", "the agent list shows it at once");
});

test("a change keeps over a list read that began before it", async () => {
  await sleep(5);
  const stale = s.app.threads.refresh();
  await sleep(50);
  const patched = await timed<ConversationHeader>("PATCH", `/api/c/${agent.room}`, { thinkingLevel: "xhigh" });
  assert.equal(patched.body.thinkingLevel, "xhigh");
  await stale;
  assert.equal(listed(agent.id)?.thinkingLevel, "xhigh", "the read from before the change leaves the new level");
});

test("a rename on an agent's DM answers in under 300 ms and names the DM at once", async () => {
  const patched = await timed<ConversationHeader>("PATCH", `/api/c/${agent.room}`, { name: "Patch speed renamed" });
  assert.equal(patched.status, 200);
  assert.ok(patched.ms < 300, `PATCH took ${patched.ms.toFixed(0)} ms`);
  assert.equal(patched.body.summary.name, "Patch speed renamed");
  assert.equal(listed(agent.id)?.name, "Patch speed renamed");
});

test("a new agent answers in under 300 ms and is listed at once", async () => {
  const made = await timed<AgentSummary>("POST", "/api/agents", { name: "Patch speed new", test: true });
  assert.equal(made.status, 200);
  assert.ok(made.ms < 300, `POST /api/agents took ${made.ms.toFixed(0)} ms`);
  assert.equal(listed(made.body.id)?.name, "Patch speed new");
});
