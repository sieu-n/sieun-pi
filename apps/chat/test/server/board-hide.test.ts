/**
 * All boards and the Board sidebar leave out a walk's test agent, and the owner can hide a board and show it again. The check-in takes a pause
 * until the owner's own date and time.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-hide.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, BoardRow, CheckInView } from "../../web/src/lib/api/types.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let real: AgentSummary;
let throwaway: AgentSummary;

before(async () => {
  s = await start({ wordMs: 0 });
  real = (await s.send("POST", "/api/agents", { name: "board hide real" })).body;
  throwaway = (await s.send("POST", "/api/agents", { name: "board hide throwaway", test: true })).body;
  for (const agent of [real, throwaway]) {
    await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
    const added = await s.send("POST", `/api/agents/${agent.id}/board`, { ops: [{ op: "plan_add", text: "A step" }] });
    assert.equal(added.status, 200);
  }
});
after(async () => {
  await s.close();
});

const rows = () => s.get<BoardRow[]>("/api/boards");
const row = async (id: string) => (await rows()).find(each => each.chatId === id);

test("All boards leaves out a walk's test agent", async () => {
  assert.ok(await row(real.id));
  assert.equal(await row(throwaway.id), undefined);
});

test("a hidden board comes back marked hidden, and showing it again clears the mark", async () => {
  assert.equal((await row(real.id))?.hidden, undefined);
  assert.deepEqual((await s.send("POST", `/api/agents/${real.id}/board/hidden`, { hidden: true })).body, { hidden: true });
  assert.equal((await row(real.id))?.hidden, true);
  assert.deepEqual((await s.send("POST", `/api/agents/${real.id}/board/hidden`, { hidden: false })).body, { hidden: false });
  assert.equal((await row(real.id))?.hidden, undefined);
});

test("a hide body that is not a boolean, or an unknown board, is refused", async () => {
  assert.equal((await s.send("POST", `/api/agents/${real.id}/board/hidden`, { hidden: "yes" })).status, 400);
  assert.equal((await s.send("POST", "/api/agents/ag_nobody-here/board/hidden", { hidden: true })).status, 404);
});

test("the check-in pauses until a picked time ahead of now, and a past time is refused", async () => {
  const until = Date.now() + 3 * 86_400_000;
  const paused = await s.send("POST", `/api/agents/${real.id}/check-in`, { pause: { until } });
  assert.equal(paused.status, 200);
  assert.equal((paused.body as CheckInView).pausedUntil, until);
  assert.equal((paused.body as CheckInView).paused, true);
  assert.equal((await s.send("POST", `/api/agents/${real.id}/check-in`, { pause: { until: Date.now() - 1000 } })).status, 400);
  assert.equal((await s.send("POST", `/api/agents/${real.id}/check-in`, { pause: "next week" })).status, 400);
  assert.equal((await s.send("POST", `/api/agents/${real.id}/check-in`, { everyMs: 86_400_000, pause: null })).status, 200);
  const view = await s.get<CheckInView>(`/api/agents/${real.id}/check-in`);
  assert.equal(view.everyMs, 86_400_000);
  assert.equal(view.paused, false);
});
