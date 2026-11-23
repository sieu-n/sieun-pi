/**
 * Sends the chat server makes to pi-host on its own, which pi-host refused while it restarted for an install, go again until pi-host takes
 * them, under one request id: an @mention in a DM post, the owner's `[board]` line (after a restart of the chat server too), an edit notice
 * to the agent that read the post, and a check-in job's brief, which goes on the thread the failed try made.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/send-retry.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSummary, CheckInView } from "../../web/src/lib/api/types.ts";
import { BOARD_PREFIX } from "../../web/src/lib/api/shared/chat-board.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

/** pi-host refuses the next `n` submits whose request id `match`es, as it does while it shuts down for an install. */
function refuse(host: FixtureHost, match: (requestId: string) => boolean, n = 1): { left: () => number } {
  let left = n;
  host.beforeSubmit = (_thread, input) => {
    if (left > 0 && input.requestId && match(input.requestId)) {
      left -= 1;
      throw new Error("pi-host is shutting down");
    }
  };
  return { left: () => left };
}

/** The inputs of a thread's root conversation whose text holds `words`. */
const inputs = async (s: Running, thread: string, words: string) =>
  (await s.host.entries(thread, { conversation: 1, limit: 400 })).entries.filter(e => (e.kind === "pi.user" || e.kind === "agent.message") && JSON.stringify(e.model).includes(words));

test("a DM post's @mention that pi-host refused reaches the mentioned agent once", async () => {
  const s = await start({ wordMs: 0 });
  try {
    const host = s.host as FixtureHost;
    const target = s.app.threads.registered(agents.frontend)!;
    const refused = refuse(host, id => id === `retry-mention-1:${agents.frontend}`);
    const sent = await s.send("POST", "/api/c/dm_vent/send", { text: "retry walk @frontend bro check the relay", mentions: [agents.frontend], requestId: "retry-mention-1" });
    assert.equal(sent.status, 200, sent.body.error);
    await until(async () => refused.left(), left => left === 0);
    const got = await until(() => inputs(s, target.workThread, "retry walk @frontend bro"), found => found.length > 0, 10_000);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await inputs(s, target.workThread, "retry walk @frontend bro")).length, 1);
    assert.equal(got[0]!.kind, "agent.message");
  } finally {
    await s.close();
  }
});

test("the owner's [board] line that pi-host refused reaches the agent once, after a restart of the chat server too", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "send-retry-board-"));
  let s = await start({ dataDir, wordMs: 0 });
  try {
    const host = s.host as FixtureHost;
    const agent = (await s.send<AgentSummary>("POST", "/api/agents", { name: "board retry agent" })).body;
    // pi-host is away for the whole life of this server process: every try of the board line fails.
    const refused = refuse(host, id => id.startsWith(`board:${agent.id}:`), 1000);
    await s.app.boards.apply(agent.id, [{ op: "plan_add", text: "Retry the board line" }], "owner");
    await until(async () => refused.left(), left => left < 1000);
    await s.close();
    host.beforeSubmit = undefined;
    s = await start({ dataDir, host, wordMs: 0 });
    const line = await until(() => inputs(s, agent.thread, "Retry the board line"), found => found.length > 0, 10_000);
    assert.ok(JSON.stringify(line[0]!.model).includes(BOARD_PREFIX.trim()));
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await inputs(s, agent.thread, "Retry the board line")).length, 1);
  } finally {
    await s.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an edit notice that pi-host refused reaches the agent that read the post once", async () => {
  const s = await start({ wordMs: 1 });
  try {
    const host = s.host as FixtureHost;
    await s.send("POST", "/api/c/dm_vent/send", { text: "retry edit walk: ship to staging", requestId: "retry-edit-1" });
    const stored = () => s.app.agentStore.postsOf("dm_vent").find(p => p.requestId === "retry-edit-1");
    await until(async () => stored(), p => p?.delivery?.state === "delivered", 20_000);
    const post = stored()!;
    const refused = refuse(host, id => /^e\d+:dm_vent:/.test(id));
    const edited = await s.send("PATCH", `/api/c/dm_vent/posts/${post.id}`, { text: "retry edit walk: ship to prod" });
    assert.equal(edited.status, 200);
    await until(async () => refused.left(), left => left === 0);
    const thread = post.delivery!.thread!;
    await until(() => inputs(s, thread, "The owner edited post"), found => found.length > 0, 10_000);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await inputs(s, thread, "The owner edited post")).length, 1);
  } finally {
    await s.close();
  }
});

test("a check-in job whose brief pi-host refused starts on the next try with one thread and one brief", async () => {
  const s = await start({ wordMs: 0 });
  try {
    const host = s.host as FixtureHost;
    const agent = (await s.send<AgentSummary>("POST", "/api/agents", { name: "check-in retry agent" })).body;
    await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
    await s.app.boards.apply(agent.id, [{ op: "plan_add", text: "Ship the relay" }], "agent");
    type CheckIn = { lastAt: number; start?: { at: number; name: string; job?: { id: string } }; job?: { id: string; name: string } };
    const checkIn = () => s.app.boards.dutyFile(agent.id).checkIn as CheckIn | undefined;
    const refused = refuse(host, id => id.startsWith(`checkin:${agent.id}:`));
    const first = (await s.get<CheckInView>(`/api/agents/${agent.id}/check-in`)).nextAt!;
    await s.app.boards.tick(first);
    await until(async () => refused.left(), left => left === 0);
    const kept = (await until(async () => checkIn(), c => !!c && c.lastAt !== first))!.start;
    const retryAt = (await s.get<CheckInView>(`/api/agents/${agent.id}/check-in`)).nextAt!;
    assert.ok(retryAt > first, "the next try waits for its retry time");
    await s.app.boards.tick(retryAt);
    const job = (await until(async () => checkIn(), c => !!c?.job))!.job!;
    const jobs = s.app.boards.chatAgents(agent.id).filter(a => a.name.startsWith("check-in "));
    assert.deepEqual(jobs.map(a => a.name), [job.name], "one check-in thread");
    assert.equal(job.id, kept?.job?.id, "the retry submits to the thread the failed try made");
    assert.equal(job.name, kept?.name);
    assert.equal(checkIn()!.start, undefined);
    const briefs = (await host.entries(job.id, { conversation: 1, limit: 50 })).entries.filter(entry => entry.kind === "agent.message");
    assert.equal(briefs.length, 1);
  } finally {
    await s.close();
  }
});
