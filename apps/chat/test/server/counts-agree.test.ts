/**
 * Every count of one thing reads one source. An agent's Jobs tab and profile card (its config's `swarm.jobs`) count the jobs GET /api/jobs and
 * the Agents card list for it, jobs inside its root job threads included. Each board's row on All boards and the Board sidebar, a board's own
 * For you heading and the For you badge leave out an ask Remind me hides, and count it again when its time comes.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/counts-agree.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentConfig, AgentSummary, BoardRow } from "../../web/src/lib/api/types.ts";
import { waitingAsks } from "../../web/src/lib/api/shared/snooze.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
  // The fixture's root job "pi cutover prep" hands work on: a finished job, a live one under it, and a finished one the owner archives below.
  const host = s.host as FixtureHost;
  const cutover = host.threadsById.get(ids.cutover)!;
  const now = Date.now();
  const relay = host.addChild(cutover, 1, "relay move list", now);
  host.addChild(cutover, relay.id, "relay port check", now, "running");
  host.addChild(cutover, 1, "old pool notes", now);
  // pi-host bumps a thread's updatedAt when its tree changes, and the chat server reads the tree again only then.
  cutover.row.updatedAt = now + 1;
  await s.app.threads.refresh();
  const old = (await s.get<AgentSummary[]>("/api/jobs")).find(j => j.name === "old pool notes")!;
  assert.equal((await s.send("PATCH", `/api/c/${encodeURIComponent(old.id)}`, { archived: true })).status, 200);
});
after(async () => {
  await s.close();
});

test("an agent's Jobs tab, profile card and Agents card count the jobs /api/jobs lists for it", async () => {
  const live = await s.get<AgentSummary[]>("/api/jobs");
  const all = await s.get<AgentSummary[]>("/api/jobs?archived=1");
  for (const agent of await s.get<AgentSummary[]>("/api/agents")) {
    const config = await s.get<AgentConfig>(`/api/agents/${encodeURIComponent(agent.id)}/config`);
    // The Jobs tab's Active and Finished and the profile card hold its unarchived jobs (agents-model.ts `jobFilterCounts`), and the Agents
    // card counts the unarchived jobs of the live list, the hello's GET /api/jobs (`jobCounts`).
    const tab = config.swarm.jobs.filter(j => !j.archived).length;
    const mine = (list: AgentSummary[]) => list.filter(j => j.agent?.id === agent.id);
    assert.deepEqual(config.swarm.jobs.map(j => j.id).sort(), mine(all).map(j => j.id).sort(), `${agent.name}: the tab lists the jobs /api/jobs?archived=1 lists`);
    assert.equal(tab, mine(live).length, `${agent.name}: Active and Finished hold the jobs /api/jobs and the Agents card count`);
    assert.equal(config.swarm.jobs.length - tab, mine(all).filter(j => j.archived).length, `${agent.name}: Archived holds the archived ones`);
  }
  const harness = await s.get<AgentConfig>(`/api/agents/${encodeURIComponent(agents.harness)}/config`);
  const job = (name: string) => harness.swarm.jobs.find(j => j.name === name);
  assert.deepEqual([job("relay move list")?.parent, job("relay move list")?.depth, job("relay move list")?.kind], [ids.cutover, 2, "job"], "a job inside a root job sits under it");
  assert.deepEqual([job("relay port check")?.depth, job("relay port check")?.status], [3, "working"]);
  assert.equal(job("old pool notes")?.archived, true);
  assert.equal(job("pi cutover prep")?.kind, "root job");
});

test("a snoozed ask leaves every ask count until its time, and comes back to all of them", async () => {
  const rows = () => s.get<BoardRow[]>("/api/boards");
  const total = async () => (await rows()).reduce((sum, row) => sum + row.openAsks, 0);
  const item = (await s.app.boards.forYou()).find(i => !i.todo.done)!;
  const before = await s.app.boards.forYouCount();
  const row = (list: BoardRow[]) => list.find(r => r.chatId === item.chatId)!;
  const rowBefore = row(await rows()).openAsks;
  assert.equal(await total(), before, "All boards' total matches the For you badge");

  const sent: BoardRow[] = [];
  const events = s.app.boards.events as { row(chat: string, row: BoardRow): void };
  const real = events.row.bind(events);
  events.row = (chat, next) => { if (chat === item.chatId) sent.push(next); real(chat, next); };
  try {
    // A minute away, so the counts below read it hidden however slow a busy box runs them (they took up to 1.1 s at load 500 on 11-23).
    await s.app.boards.apply(item.chatId, [{ op: "todo_update", id: item.todo.id, remindAt: new Date(Date.now() + 60_000).toISOString() }]);
    assert.equal(await s.app.boards.forYouCount(), before - 1);
    assert.equal(row(await rows()).openAsks, rowBefore - 1, "the board's row leaves it out too");
    assert.equal(await total(), before - 1);
    const board = (await s.app.boards.board(item.chatId))!;
    assert.equal(waitingAsks(board.todos, Date.now()), rowBefore - 1, "the board's own For you heading counts the same");
    const config = await s.get<AgentConfig>(`/api/agents/${encodeURIComponent(item.chatId)}/config`);
    if (config.board) assert.equal(config.board.openTodos.length, rowBefore - 1, "the agent page's asks for you count the same");

    // The owner moves the reminder to 500 ms from now; when it comes due the server sends the row again on its own, with no read of the page.
    await s.app.boards.apply(item.chatId, [{ op: "todo_update", id: item.todo.id, remindAt: new Date(Date.now() + 500).toISOString() }]);
    await until(async () => sent.at(-1)?.openAsks, count => count === rowBefore, 5_000).catch(() => undefined);
    assert.ok(sent.some(next => next.openAsks === rowBefore), `the row went out again when the ask came back: ${sent.map(r => r.openAsks).join(", ")}`);
    assert.equal(row(await rows()).openAsks, rowBefore);
    assert.equal(await s.app.boards.forYouCount(), before);
  } finally {
    events.row = real;
    await s.app.boards.apply(item.chatId, [{ op: "todo_update", id: item.todo.id, remindAt: null }]);
  }
});
