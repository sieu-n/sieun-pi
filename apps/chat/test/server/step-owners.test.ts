/**
 * The app tells a chat what nobody owns on its board, by the rules d9 counts with (legacy/prime/user-history/src/apps-step-owners.ts), and
 * stops once a wake of the chat's own thread names the step. At 09:03Z on 11-03 d9 counted vent's p126, waiting on the release owner, and
 * chrome extension's p20, waiting on mac-management, each with no wake and no job, and nothing in :5184 had told either chat.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/step-owners.test.ts
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import type { AgentSummary, ChatBoard } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { StepOwners } from "../../server/step-owners.ts";
import type { DutyFile } from "../../server/boards.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let vent: AgentSummary;

before(async () => {
  s = await start({ wordMs: 0 });
  vent = (await s.send("POST", "/api/agents", { name: "owners vent" })).body;
  assert.ok(s.host instanceof FixtureHost);
  await until(async () => s.app.threads.thread(vent.thread)?.status, status => status !== "running");
});
after(async () => {
  await s.close();
});

/** The notices vent's thread holds, read from its entries, so one the host refused or one still in its queue is told apart from one it got. */
const mine = (): { text: string }[] => {
  assert.ok(s.host instanceof FixtureHost);
  return s.host.threadsById.get(vent.thread)!.entries.filter(entry => (entry.data as { via?: string } | undefined)?.via === "owners")
    .map(entry => ({ text: (entry.model?.[0]?.content as { text?: string }[])[0]?.text ?? "" }));
};
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

test("a chat whose turn runs is told when that turn ends, and the notice names only the steps nobody owns then", async () => {
  // Devops guy on 11-28: its thread worked through a queue from 11:56Z to 14:01Z. A notice built at 11:56:24Z waited there as a follow-up, and
  // so did a second one built at 13:12:46Z, after a release at 13:12:07Z emptied the app's list of chats with a notice not yet answered. It
  // closed p150 at 14:01:43Z, and both notices reached it at 14:03:44Z and 14:03:47Z and named p150. vent on 11-07: its run waited for a
  // pi-pool slot from 14:13Z to 18:00Z, and the 10 notices queued in that time reached it at once.
  const added = await s.send<{ board: ChatBoard }>("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [
    { op: "plan_add", text: "Remove the Convex and Cloudflare usage keys from the infra settings", status: "doing", waitFor: "Release owner's p147. A wake checks main every 30 min" },
    { op: "plan_add", text: "Move the billing mail reader onto Vent", status: "doing", waitFor: "Release owner's p147 deploys the obs tier" },
    { op: "plan_add", text: "The demo's store-country test passes again on the Mac branch", status: "doing", waitFor: "a passing linux (demo-unit) run on dev/sieun-mac" },
  ] });
  assert.equal(added.status, 200);
  const [keys, mail, demo] = added.body.board.plan.slice(-3).map(item => item.id);
  const before = mine().length;
  assert.ok(s.host instanceof FixtureHost);
  s.host.wordMs = 50;
  await s.host.submit(vent.thread, { text: "slow turn that works through its inbox" });
  await until(async () => s.app.boards.rootRunning(vent.thread), running => running);
  const now = Date.now() + 24 * 3600_000;
  for (const step of [0, 6, 13]) await s.app.boards.owners.tick(now + step * 60_000);
  // A release in the middle of the turn: the next server process knows only what the last one saved.
  await new StepOwners(s.app.boards).tick(now + 43 * 60_000);
  await s.app.boards.owners.tick(now + 73 * 60_000);
  await s.app.boards.addWake(vent.id, { on: { kind: "check", command: "false", every: 300_000, at: now + 86_400_000 }, note: `${keys}: post promote 24 vent checks` });
  await s.send("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [{ op: "plan_update", id: keys, waitFor: null }, { op: "plan_update", id: demo, status: "done", waitFor: null }] });
  s.host.wordMs = 0;
  await s.host.abort(vent.thread);
  await idle();
  await until(async () => { await s.app.boards.owners.tick(now + 74 * 60_000); return mine().length; }, count => count > before);
  await idle();
  await s.app.boards.owners.tick(now + 75 * 60_000);
  const got = mine().slice(before).map(notice => notice.text);
  assert.equal(got.length, 1, "the chat gets one notice for the whole turn, and the same gaps are not told again inside the window");
  assert.match(got[0]!, new RegExp(`${mail} "Move the billing mail reader onto Vent" waits for`));
  assert.doesNotMatch(got[0]!, new RegExp(`${demo}\\b`), "a step closed while the turn ran is not in the notice");
  assert.doesNotMatch(got[0]!, new RegExp(`${keys}\\b`), "a step its turn gave an owner is not in the notice");
});

test("a chat whose run waits for its slot gets no notice into its queue", async () => {
  assert.ok(s.host instanceof FixtureHost);
  const refused: string[] = [];
  s.host.beforeSubmit = (thread, input) => { if (thread === vent.thread && input.requestId?.startsWith("owners:")) refused.push(input.requestId); };
  const added = await s.send<{ board: ChatBoard }>("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [
    { op: "plan_add", text: "Rotate the staging deploy key", status: "doing", waitFor: "Release owner's p147 lands" }] });
  const step = added.body.board.plan.at(-1)!.id;
  const before = mine().length;
  s.host.wordMs = 50;
  await s.host.submit(vent.thread, { text: "queue long behind six other runs" });
  await until(async () => s.app.threads.thread(vent.thread)?.status, status => status === "sleeping");
  const now = Date.now() + 36 * 3600_000;
  await s.app.boards.owners.tick(now);
  assert.equal(mine().length, before, "nothing is queued behind the waiting run");
  assert.deepEqual(refused, [], "and the host is not asked while the app reads the run as waiting");
  s.host.beforeSubmit = undefined;
  s.host.wordMs = 0;
  await s.host.abort(vent.thread);
  await idle();
  await until(async () => { await s.app.boards.owners.tick(now + 60_000); return mine().length; }, count => count === before + 1);
  assert.match(mine().at(-1)!.text, new RegExp(`${step} "Rotate the staging deploy key"`));
  await idle();
});

test("a chat is told while a duty run of it works", async () => {
  // Devops guy on 11-25: d10's precheck ran 53 min from 21:06Z and again from 21:59Z, and the skip for a running duty kept its notices back.
  const script = `setTimeout(() => require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 100 }, flagged: [] })), 3000)`;
  const at = Date.now();
  await s.app.boards.saveDuties(vent.id, { duties: [{ id: "d1", name: "Vent gateway", ownerWords: "keep it up", goal: "it stays up",
    metrics: [{ key: "up", label: "Up", op: ">=", target: 99, headline: true }], schedule: { kind: "daily", at: "07:04" },
    precheck: { command: ["node", "-e", script], cwd: tmpdir(), timeoutMs: 30_000 }, onMiss: "fix it", status: "active", createdAt: at, updatedAt: at, lastRunAt: at, runCount: 0 }], runs: {} } as unknown as DutyFile);
  const open = (await s.get<{ board: ChatBoard }>(`/api/agents/${vent.id}/board`)).board.plan.filter(item => item.status !== "done");
  const added = await s.send<{ board: ChatBoard }>("POST", `/api/agents/${vent.id}/board`, { actor: "agent", ops: [
    ...open.map(item => ({ op: "plan_update", id: item.id, status: "done" })),
    { op: "plan_add", text: "Tag every box's OTel with its box name", status: "doing", waitUntil: "2026-11-25T14:30:00Z" }] });
  const step = added.body.board.plan.at(-1)!.id;
  await idle();
  const before = mine().length;
  assert.equal((await s.send("POST", `/api/agents/${vent.id}/duties`, { duty: "d1", action: "run" })).status, 200);
  await until(async () => s.app.boards.duties(vent.id).some(row => row.running), running => running);
  await s.app.boards.owners.tick(Date.now() + 48 * 3600_000);
  await until(async () => mine().length, count => count === before + 1);
  assert.match(mine().at(-1)!.text, new RegExp(`${step} "Tag every box's OTel`));
  assert.ok(s.app.boards.duties(vent.id).some(row => row.running), "the duty still ran when the chat was told");
  await until(async () => s.app.boards.duties(vent.id).some(row => row.running), running => !running);
});
