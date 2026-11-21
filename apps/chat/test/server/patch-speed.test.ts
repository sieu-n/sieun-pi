/**
 * A change to an agent through its DM (`PATCH /api/c/dm_<agent>`) and a new agent (`POST /api/agents`) answer without a thread list read. On
 * 11-21 both waited for one: the owner's model change on dm_agent-factory took 590 to 1830 ms in the handler, since the read lists 979 threads
 * and waits for the Mac's relay too, while a channel's PATCH took 4 to 11 ms (p187). Here the list read and the host's durable_set each take
 * 1.5 s, and each answer must come before either ends and show the change, also on reads right after it and after a read that started before
 * the change. A change the host refuses goes back to the host's row.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/patch-speed.test.ts
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { AgentSummary, ConversationHeader } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

const READ_MS = 1500;
let s: Running;
let agent: AgentSummary & { room: string; thread: string };

before(async () => {
  s = await start();
  agent = (await s.send<AgentSummary & { room: string; thread: string }>("POST", "/api/agents", { name: "Patch speed probe", thinkingLevel: "low", test: true })).body;
  const host = s.host as FixtureHost;
  const read = host.threads.bind(host);
  // The rows as they stood when the read began, answered READ_MS later, as pi-host's list read of 11-21.
  host.threads = async opts => {
    const rows = await read(opts);
    await sleep(READ_MS);
    return rows;
  };
  const set = host.set.bind(host);
  host.set = async (id, patch) => {
    await sleep(READ_MS);
    if (patch.name === "refused") throw new Error("pi-host refused the change");
    return set(id, patch);
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

test("a thinking level change on an agent's DM answers without waiting for the host, with the new level", async () => {
  const patched = await timed<ConversationHeader>("PATCH", `/api/c/${agent.room}`, { thinkingLevel: "high" });
  assert.equal(patched.status, 200);
  assert.ok(patched.ms < READ_MS, `PATCH took ${patched.ms.toFixed(0)} ms`);
  assert.equal(patched.body.thinkingLevel, "high");
  assert.equal(listed(agent.id)?.thinkingLevel, "high", "the agent list shows it at once");
});

test("the host gets each change in order", async () => {
  await s.send("PATCH", `/api/c/${agent.room}`, { thinkingLevel: "low" });
  await s.send("PATCH", `/api/c/${agent.room}`, { thinkingLevel: "medium" });
  const host = s.host as FixtureHost;
  const seen: (string | null)[] = [];
  const end = Date.now() + 5000;
  while (Date.now() < end && host.threadsById.get(agent.thread)!.row.thinkingLevel !== "medium") {
    seen.push(listed(agent.id)!.thinkingLevel);
    await sleep(50);
  }
  await sleep(READ_MS + 200);
  assert.equal(host.threadsById.get(agent.thread)!.row.thinkingLevel, "medium");
  assert.equal(listed(agent.id)?.thinkingLevel, "medium");
  assert.ok(seen.every(level => level === "medium"), `the list showed only the last change while the host caught up: ${[...new Set(seen)].join(", ")}`);
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

test("a rename on an agent's DM answers without waiting for the host and names the DM at once", async () => {
  const patched = await timed<ConversationHeader>("PATCH", `/api/c/${agent.room}`, { name: "Patch speed renamed" });
  assert.equal(patched.status, 200);
  assert.ok(patched.ms < READ_MS, `PATCH took ${patched.ms.toFixed(0)} ms`);
  assert.equal(patched.body.summary.name, "Patch speed renamed");
  assert.equal(listed(agent.id)?.name, "Patch speed renamed");
});

test("a rename the host refuses goes back to the host's name", async () => {
  const before = listed(agent.id)!.name;
  const patched = await timed<ConversationHeader>("PATCH", `/api/c/${agent.room}`, { name: "refused" });
  assert.equal(patched.body.summary.name, "refused");
  const end = Date.now() + 10_000;
  while (Date.now() < end && listed(agent.id)?.name !== before) await sleep(50);
  assert.equal(listed(agent.id)?.name, before);
});

test("a new agent answers without a thread list read and is listed at once", async () => {
  const made = await timed<AgentSummary>("POST", "/api/agents", { name: "Patch speed new", test: true });
  assert.equal(made.status, 200);
  assert.ok(made.ms < READ_MS, `POST /api/agents took ${made.ms.toFixed(0)} ms`);
  assert.equal(listed(made.body.id)?.name, "Patch speed new");
});
