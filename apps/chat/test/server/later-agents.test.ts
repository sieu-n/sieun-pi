/**
 * Save for later and Remind me for agents (server/later-agents.ts) on the fixture server: a comm thread's save_message and remind_me calls
 * (`POST /api/threads/:thread/later`) keep the agent's own items, a reminder that waits is a time wake for that comm thread among the
 * board's wakes, its due text names the post and shows its thread, and the agent's room reads show its own save.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/later-agents.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { wakeText } from "../../../../legacy/prime/user-history/src/wakes.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { laterLine, reminderPost } from "../../server/later-agents.ts";
import { start, until, type Running } from "./helpers.ts";

describe("an agent's Saved list on the fixture server", () => {
  let s: Running;
  let comm: string;
  const set = (body: Record<string, unknown>, thread = comm) =>
    s.send<{ text: string; error?: string }>("POST", `/api/threads/${encodeURIComponent(thread)}/later`, body);
  const wakeIds = () => s.app.boards.db.wakes.list().map(({ id }) => id).filter(id => id.startsWith("later-"));
  before(async () => {
    s = await start({ wordMs: 1 });
    comm = s.app.agents.record(agents.crawler)!.comm!.ch_cutover!;
  });
  after(async () => {
    await s.close();
  });

  test("save_message saves a post once, as the agent, and the agent's room reads show its own save only", async () => {
    const saved = await set({ message: "p5", state: "open" });
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal(saved.body.text, "Saved ch_cutover/p5 in #pi-cutover. 1 open on your saved list.");
    assert.equal((await set({ message: "ch_cutover/p5", state: "open" })).body.text, "Already saved ch_cutover/p5 in #pi-cutover. 1 open on your saved list.");
    assert.equal(s.app.later.items(agents.crawler).length, 1);
    assert.equal(s.app.later.items("owner").length, 0, "the owner's list is his own");

    const row = s.app.groups.row("ch_cutover")!;
    const p5 = s.app.agentStore.postsOf("ch_cutover").find(p => p.id === "p5")!;
    const reply = { ...p5, id: "p99", seq: 99, threadRoot: "p5", text: "a later reply", reactions: [] };
    assert.match(s.app.groups.envelope(row, reply, [], agents.crawler), /^5 .*\[saved\]$/m);
    assert.doesNotMatch(s.app.groups.envelope(row, reply, [], agents.vent), /\[saved/);
    assert.doesNotMatch(s.app.groups.envelope(row, reply), /\[saved/);
  });

  test("save_message keeps the agent's memo, a save with no memo keeps it, and list_saved_messages shows it", async () => {
    const memoed = await set({ message: "p2", state: "open", memo: "  check the cutover numbers  " });
    assert.equal(memoed.body.text, "Saved ch_cutover/p2 in #pi-cutover with your memo. 2 open on your saved list.");
    assert.equal(s.app.later.find(agents.crawler, "ch_cutover", "p2")!.memo, "check the cutover numbers");
    assert.equal((await set({ message: "p2", state: "open" })).body.text, "Already saved ch_cutover/p2 in #pi-cutover. 2 open on your saved list.");
    assert.equal(s.app.later.find(agents.crawler, "ch_cutover", "p2")!.memo, "check the cutover numbers", "a save with no memo keeps it");
    assert.equal((await set({ message: "p2", state: "open", memo: "check the cutover numbers" })).body.text, "Already saved ch_cutover/p2 in #pi-cutover. 2 open on your saved list.");
    const list = await s.get<{ text: string }>(`/api/threads/${encodeURIComponent(comm)}/later?state=open`);
    assert.match(list.text, /\nch_cutover\/p2 in #pi-cutover, thread p1 · from .*\nYour memo: check the cutover numbers\n/);
    assert.equal((await set({ message: "p2", state: "open", memo: 7 })).status, 400);
    assert.equal((await set({ message: "p2", state: "removed" })).status, 200);
  });

  test("remind_me sets one time wake for the room's comm thread, and done, clear and removed take it away", async () => {
    const at = Date.now() + 120_000;
    const reminded = await set({ message: "p5", remindAt: at });
    assert.match(reminded.body.text, /^Reminder set on ch_cutover\/p5 for \d{4}-\d\d-\d\d \d\d:\d\dZ, in 2 min\. Then you get a \[reminder\] in your #pi-cutover thread/);
    assert.deepEqual(wakeIds(), [`later-${agents.crawler}-ch_cutover-p5`]);
    const wake = s.app.boards.db.wakes.get(wakeIds()[0]!)!;
    assert.equal(wake.session, `${comm}--1`);
    assert.deepEqual(wake.on, { kind: "time", at });
    await set({ message: "p5", remindAt: at + 60_000 });
    assert.equal(wakeIds().length, 1, "a new time replaces the wake");

    const row = s.app.groups.row("ch_cutover")!;
    const p5 = s.app.agentStore.postsOf("ch_cutover").find(p => p.id === "p5")!;
    assert.match(s.app.groups.envelope(row, { ...p5, id: "p99", seq: 99, threadRoot: "p5", reactions: [] }, [], agents.crawler), /\[saved · reminder \d{4}-\d\d-\d\d \d\d:\d\dZ\]$/m);

    assert.match((await set({ message: "p5", state: "done" })).body.text, /^Marked ch_cutover\/p5 done; its reminder will not go off\./);
    assert.deepEqual(wakeIds(), []);
    await set({ message: "p5", state: "open" });
    assert.equal(wakeIds().length, 1, "opening it again sets the reminder that never went off");
    assert.equal((await set({ message: "p5", remindAt: null })).body.text, "Cleared the reminder on ch_cutover/p5; it stays saved.");
    assert.deepEqual(wakeIds(), []);
    await set({ message: "p5", remindAt: at });
    assert.equal((await set({ message: "p5", state: "removed" })).body.text, "Took ch_cutover/p5 off your saved list, and its reminder with it.");
    assert.deepEqual(wakeIds(), []);
    assert.equal((await set({ message: "p5", state: "removed" })).body.text, "ch_cutover/p5 was not on your saved list.");
  });

  test("a due reminder reads as the post and its thread now, names its post for the feed, and stamps notifiedAt once it went out", async () => {
    await set({ message: "p5", remindAt: Date.now() + 60_000 });
    const id = wakeIds()[0]!;
    const wake = s.app.boards.db.wakes.get(id)!;
    const ticker = wakeText(wake, null, wake.on.kind === "time" ? wake.on.at : 0);
    const text = s.app.agentLater.expand(`[wake] another wake\n${ticker}`);
    const [first, head, ...thread] = text.split("\n");
    assert.equal(first, "[wake] another wake", "other wakes in the batch stay as they are");
    assert.match(head!, /^\[reminder\] It is .*, the time you set with remind_me on ch_cutover\/p5 in #pi-cutover\. The post now:$|^\[reminder\] .* Its thread now/);
    assert.ok(thread.some(line => /^5 /.test(line) && line.endsWith("[saved · reminder " + new Date(wake.on.kind === "time" ? wake.on.at : 0).toISOString().slice(0, 16).replace("T", " ") + "Z]")), text);
    assert.doesNotMatch(text, /board\.wake/, "the ticker's board.wake wording and poll hint go");
    assert.equal(reminderPost(text, "ch_cutover"), "p5");
    assert.equal(reminderPost(text, "dm_vent"), undefined);

    s.app.agentLater.delivered(ticker);
    const item = s.app.later.items(agents.crawler).find(i => i.post === "p5")!;
    assert.ok(item.notifiedAt !== undefined && item.notifiedAt >= item.remindAt!);
    assert.equal(s.app.boards.db.wakes.get(id), undefined, "a reminder that went off leaves no wake");
    const list = await s.get<{ text: string }>(`/api/threads/${encodeURIComponent(comm)}/later?state=open`);
    assert.match(list.text, /^1 open, 0 done\. Showing the 1 open\.\n\nch_cutover\/p5 in #pi-cutover · from .* · saved .* · reminder .*, went off\n/);
  });

  test("what the comm thread posts on a due reminder goes in the reminded post's thread", async () => {
    const before = s.app.agentStore.postsOf("ch_cutover").length;
    // The comm thread's last post came from p5, so a reply that followed the last turn would land in p5's thread.
    const text = s.app.agentLater.reminder(s.app.agents.record(agents.crawler)!, "ch_cutover", "p2");
    await s.host.submit(comm, { text, whenBusy: "followUp", requestId: "wake:reminder-test", entry: { kind: "agent.message", data: { from: "board", via: "wake" } } });
    const posted = await until(async () => s.app.agentStore.postsOf("ch_cutover").slice(before).find(p => p.author === agents.crawler), p => p !== undefined, 20_000);
    assert.equal(posted!.threadRoot, "p1", "p2 is a reply in p1's thread");
  });

  test("a bad call says what to pass", async () => {
    assert.equal((await set({ message: "p999", state: "open" })).status, 404);
    assert.equal((await set({ message: "dm_vent/p1", state: "open" })).status, 404);
    assert.equal((await set({ state: "open" })).status, 400);
    assert.equal((await set({ message: "p5", state: "later" })).status, 400);
    assert.equal((await set({ message: "p5", remindAt: "soon" })).status, 400);
    assert.equal((await set({ message: "p5" }, "no-such-thread")).status, 404);
    assert.equal((await s.send("GET", `/api/threads/${encodeURIComponent(comm)}/later?state=all`)).status, 400);
    assert.equal(laterLine(undefined), "");
  });
});
