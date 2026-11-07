/**
 * The app tells a chat what nobody owns on its board, by the rules d9 counts with (legacy/prime/user-history/src/apps-step-owners.ts), and
 * stops once a wake of the chat's own thread names the step. At 09:03Z on 11-03 d9 counted vent's p126, waiting on the release owner, and
 * chrome extension's p20, waiting on mac-management, each with no wake and no job, and nothing in :5184 had told either chat.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/step-owners.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, ChatBoard } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { StepOwners } from "../../server/step-owners.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let vent: AgentSummary;
const told: { thread: string; text: string }[] = [];

before(async () => {
  s = await start({ wordMs: 0 });
  vent = (await s.send("POST", "/api/agents", { name: "owners vent" })).body;
  assert.ok(s.host instanceof FixtureHost);
  s.host.beforeSubmit = (thread, input) => {
    if (input.requestId?.startsWith("owners:")) told.push({ thread, text: input.text ?? "" });
  };
  await until(async () => s.app.threads.thread(vent.thread)?.status, status => status !== "running");
});
after(async () => {
  await s.close();
});

const mine = () => told.filter(entry => entry.thread === vent.thread);
const idle = () => until(async () => s.app.threads.thread(vent.thread)?.status, status => status !== "running");

test("a step that waits with no job and no wake is told to its chat once a window, and a wake whose note names it ends that", async () => {
  const added = await s.send<{ board: ChatBoard }>("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [{ op: "plan_add", text: "Remove the admin secret sign-in",
    status: "doing", note: "Done when prod refuses a cookie signed with the old secret.", waitFor: "release owner ships 1159418d29 in the next promote" }] });
  assert.equal(added.status, 200);
  const step = added.body.board.plan.at(-1)!.id;
  const now = Date.now();
  await s.app.boards.tick(now);
  await until(async () => mine().length, count => count === 1);
  assert.match(mine()[0]!.text, new RegExp(`^\\[board\\] Nobody owns these.*${step} "Remove the admin secret sign-in" waits for "release owner ships`));
  assert.match(mine()[0]!.text, /board\.wake/);
  await idle();
  await s.app.boards.owners.tick(now + 60_000);
  assert.equal(mine().length, 1, "the same gap is not told again inside the live window");
  await new StepOwners(s.app.boards).tick(now + 2 * 60_000);
  assert.equal(mine().length, 1, "a restart keeps what the chat was told");
  await s.app.boards.owners.tick(now + 31 * 60_000);
  assert.equal(mine().length, 2, "the same gap is told again after the live window");
  await idle();
  await s.app.boards.addWake(vent.id, { on: { kind: "check", command: "false", every: 300_000, at: now + 86_400_000 }, note: `${step}: release owner ships 1159418d29` });
  await s.app.boards.owners.tick(now + 62 * 60_000);
  assert.equal(mine().length, 2, "a wake of the chat's thread that names the step owns it");
});

test("a chat whose turn runs or waits for a slot gets no notice; the first idle tick reads the live board and sends one", async () => {
  // vent on 11-07: its run waited for a pi-pool slot from 14:13Z to 18:00Z, and the app queued a notice each window for p143, p144 and p152.
  // Its first turn at 18:00Z gave them a job and cleared their waitFor, and then all 10 queued notices reached it, each quoting the old waits.
  const added = await s.send<{ board: ChatBoard }>("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [
    { op: "plan_add", text: "Remove the Convex and Cloudflare usage keys from the infra settings", status: "doing", waitFor: "Release owner's p147. A wake checks main every 30 min" },
    { op: "plan_add", text: "Move the billing mail reader onto Vent", status: "doing", waitFor: "Release owner's p147 deploys the obs tier" },
  ] });
  assert.equal(added.status, 200);
  const [keys, mail] = added.body.board.plan.slice(-2).map(item => item.id);
  const before = mine().length;
  assert.ok(s.host instanceof FixtureHost);
  s.host.wordMs = 50;
  await s.host.submit(vent.thread, { text: "slow turn that waits for a slot" });
  await until(async () => s.app.boards.rootRunning(vent.thread), running => running);
  const now = Date.now() + 24 * 3600_000;
  for (const step of [0, 6, 13, 43, 73]) await s.app.boards.owners.tick(now + step * 60_000);
  assert.equal(mine().length, before, "no notice is queued behind a running or waiting turn");
  await s.app.boards.addWake(vent.id, { on: { kind: "check", command: "false", every: 300_000, at: now + 86_400_000 }, note: `${keys}: post promote 24 vent checks` });
  await s.send("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [{ op: "plan_update", id: keys, waitFor: null }] });
  await s.host.abort(vent.thread);
  await until(async () => s.app.boards.rootRunning(vent.thread), running => !running);
  s.host.wordMs = 0;
  await s.app.boards.owners.tick(now + 74 * 60_000);
  await until(async () => mine().length, count => count === before + 1);
  const notice = mine().at(-1)!.text;
  assert.match(notice, new RegExp(`${mail} "Move the billing mail reader onto Vent" waits for`));
  assert.doesNotMatch(notice, new RegExp(`${keys}\\b`), "a step its turn gave an owner is not in the notice");
  await idle();
  await s.app.boards.owners.tick(now + 75 * 60_000);
  assert.equal(mine().length, before + 1, "the merged notice is the only one");
});
