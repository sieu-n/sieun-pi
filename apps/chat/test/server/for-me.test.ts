/**
 * Each agent's For list (server/for-me.ts, /home/sieun/work/for-agent/contract.md) on the fixture server: every reason, the agent's own posts
 * left out, the seeded backlog read as completed, marks and their replay, a new reaction that opens a completed item, a thread id that names
 * its agent, the 400 and 404 answers, and the for_me event that reaches only a page watching `for:<agent>`.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/for-me.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ForMeItem, ForMeList, LiveEvent } from "../../web/src/lib/api/types.ts";
import type { RoomPost } from "../../server/agent-store.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

const VENT = agents.vent;
const GENERAL = ids.generalChannel;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
type ForMeEvent = Extract<LiveEvent, { type: "for_me" }>;
const isForMe = (agent: string) => (event: LiveEvent): event is ForMeEvent => event.type === "for_me" && event.agent === agent;

describe("an agent's For list", () => {
  let s: Running;
  let seq = 0;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  const list = (agent = VENT, status = "all") => s.get<ForMeList>(`/api/agents/${agent}/for-me?status=${status}`);
  const find = async (id: string, agent = VENT) => (await list(agent)).items.find(i => i.id === id);
  /** A post in a group room as the chat server stores it, sent to the room's watchers as a new post is. */
  const post = (room: string, author: string, extra: Partial<RoomPost> = {}): RoomPost => {
    const made = s.app.agentStore.append({ room, author, text: `post ${++seq}`, images: [], at: Date.now(), requestId: `for-me:${seq}`, ...extra }).post;
    s.app.groups.emit(s.app.groups.row(room)!, [made]);
    return made;
  };
  const mark = (messageId: unknown, completed: unknown, agent = VENT) =>
    s.send<{ item: ForMeItem; pending: number; error?: string }>("POST", `/api/agents/${agent}/for-me`, { messageId, completed });

  test("the seeded backlog from before the list existed reads as completed, with no completedAt", async () => {
    const all = await list();
    assert.ok(all.items.length > 0, "the fixture's seeded posts put items on Vent's list");
    assert.equal(all.pending, 0);
    assert.equal(all.completed, all.items.length);
    assert.ok(all.items.every(i => i.status === "completed" && i.completedAt === undefined));
    assert.ok(all.items.some(i => i.reasons.includes("member") && i.room === ids.soloRoom), "the Solo room posts delivered to Vent are on it");
    assert.deepEqual((await list(VENT, "pending")).items, []);
    const file = JSON.parse(readFileSync(join(s.app.config.dataDir, "for-me.json"), "utf8")) as { v: number; since: number; marks: object };
    assert.equal(file.v, 1);
    assert.deepEqual(file.marks, {});
  });

  test("each reason puts a post on the list, and a post with none stays off", async () => {
    const mention = post(GENERAL, "owner", { mentions: [VENT] });
    const member = post(GENERAL, "owner", { deliveries: [{ target: VENT, state: "delivered", attempts: 1, at: Date.now(), requestId: `d:m:${seq}` }] });
    const thread = post(GENERAL, agents.frontend, { threadRoot: "p1" });
    const otherThread = post(GENERAL, "owner");
    const reply = post(GENERAL, agents.frontend, { threadRoot: otherThread.id });
    const unrelated = post(GENERAL, "owner", { mentions: [agents.frontend] });
    const sent = await s.send("POST", "/api/c/dm_vent/send", { text: "quiet: a DM post for the For list", requestId: "for-me-dm" });
    assert.equal(sent.status, 200);
    const dm = s.app.agentStore.byRequestId("dm_vent", "for-me-dm")!;

    const pending = await list(VENT, "pending");
    const reasons = Object.fromEntries(pending.items.map(i => [i.id, i.reasons]));
    assert.deepEqual(reasons[`${GENERAL}/${mention.id}`], ["mention"]);
    assert.deepEqual(reasons[`${GENERAL}/${member.id}`], ["member"]);
    assert.deepEqual(reasons[`${GENERAL}/${thread.id}`], ["thread"], "Vent wrote p2 in thread p1, so a later reply there is on its list");
    assert.deepEqual(reasons[`dm_vent/${dm.id}`], ["dm"]);
    for (const off of [otherThread, reply, unrelated]) assert.equal(reasons[`${GENERAL}/${off.id}`], undefined, `${off.id} names nothing of Vent's`);

    const item = pending.items.find(i => i.id === `${GENERAL}/${thread.id}`)!;
    assert.equal(item.roomKind, "channel");
    assert.equal(item.roomName, "#general");
    assert.equal(item.threadRoot, "p1");
    assert.equal(item.author.id, agents.frontend);
    assert.equal(item.activityAt, thread.at);
    assert.equal(pending.items.find(i => i.room === "dm_vent")!.roomName, "DM");
    const times = pending.items.map(i => i.activityAt);
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest activity first");
    assert.equal(pending.pending, pending.items.length);
  });

  test("the agent's own posts stay off until someone else reacts, and then the newest such reaction is the activity", async () => {
    const own = post(GENERAL, VENT, { mentions: [VENT] });
    assert.equal(await find(`${GENERAL}/${own.id}`), undefined);
    s.app.agentStore.set(own, { reactions: [{ emoji: "👀", by: VENT, at: Date.now() }] });
    assert.equal(await find(`${GENERAL}/${own.id}`), undefined, "its own reaction does not count");
    await tick();
    const reacted = await s.send("POST", `/api/c/${GENERAL}/posts/${own.id}/reactions`, { emoji: "+1" });
    assert.equal(reacted.status, 200);
    const item = (await find(`${GENERAL}/${own.id}`))!;
    assert.deepEqual(item.reasons, ["reaction"]);
    assert.equal(item.status, "pending");
    assert.equal(item.activityAt, own.reactions!.find(r => r.by === "owner")!.at);
    assert.ok(item.activityAt > own.at);
    assert.deepEqual(item.reactions?.map(r => r.emoji), ["👀", "👍"]);
  });

  test("a mark completes an item and a replay writes nothing; unmarking makes it pending again", async () => {
    const target = post(GENERAL, "owner", { mentions: [VENT] });
    const id = `${GENERAL}/${target.id}`;
    const before = (await list()).pending;
    const done = await mark(id, true);
    assert.equal(done.status, 200);
    assert.equal(done.body.item.status, "completed");
    assert.ok(done.body.item.completedAt! >= target.at);
    assert.equal(done.body.pending, before - 1);
    const path = join(s.app.config.dataDir, "for-me.json");
    const file = readFileSync(path, "utf8");
    const again = await mark(id, true);
    assert.deepEqual(again.body, done.body);
    assert.equal(readFileSync(path, "utf8"), file, "the replay leaves for-me.json as it was");
    assert.equal((await list(VENT, "completed")).items.some(i => i.id === id), true);
    const undone = await mark(id, false);
    assert.equal(undone.body.item.status, "pending");
    assert.equal(undone.body.item.completedAt, undefined);
    assert.equal(undone.body.pending, before);
    assert.equal((await list()).pending, before);
  });

  test("an old item with no mark can be opened again, and a new reaction reopens a completed item", async () => {
    const old = (await list(VENT, "completed")).items.find(i => i.completedAt === undefined)!;
    assert.equal((await mark(old.id, false)).body.item.status, "pending");

    const own = post(GENERAL, VENT);
    await s.send("POST", `/api/c/${GENERAL}/posts/${own.id}/reactions`, { emoji: "eyes" });
    const id = `${GENERAL}/${own.id}`;
    assert.equal((await mark(id, true)).body.item.status, "completed");
    await tick();
    s.app.agentStore.set(own, { reactions: [...own.reactions!, { emoji: "🎉", by: agents.frontend, at: Date.now() }] });
    const reopened = (await find(id))!;
    assert.equal(reopened.status, "pending");
    assert.equal(reopened.completedAt, undefined);
  });

  test("a work thread or comm thread id names its agent's list", async () => {
    const byAgent = await list();
    assert.deepEqual(await list(ids.vent), byAgent);
    const crawlerComm = s.app.agents.record(agents.crawler)!.comm![ids.cutoverChannel]!;
    const crawler = await list(crawlerComm);
    assert.equal(crawler.agent, agents.crawler, "the fixture's one comm thread, Crawler VP's in #pi-cutover, names Crawler VP");
    assert.deepEqual(crawler, await list(agents.crawler));
    assert.ok(crawler.items.some(i => i.id === `${ids.cutoverChannel}/p5` && i.reasons.join() === "mention,member"));
    const target = post(GENERAL, "owner", { mentions: [VENT] });
    const done = await mark(`${GENERAL}/${target.id}`, true, ids.vent);
    assert.equal(done.status, 200);
    assert.equal((await find(`${GENERAL}/${target.id}`))!.status, "completed");
  });

  test("from the agent's own thread, mark_message takes the ids set_emoji takes: a bare post id in the thread's room and a room-qualified one", async () => {
    const sent = await s.send("POST", "/api/c/dm_vent/send", { text: "quiet: a DM post marked by its bare id", requestId: "for-me-bare" });
    assert.equal(sent.status, 200);
    const dm = s.app.agentStore.byRequestId("dm_vent", "for-me-bare")!;
    const bare = await mark(dm.id, true, ids.vent);
    assert.equal(bare.status, 200, JSON.stringify(bare.body));
    assert.equal(bare.body.item.id, `dm_vent/${dm.id}`, "the work thread's bare id names a post in the agent's DM");
    assert.equal(bare.body.item.status, "completed");
    const crawlerComm = s.app.agents.record(agents.crawler)!.comm![ids.cutoverChannel]!;
    const inChannel = await mark("p5", true, crawlerComm);
    assert.equal(inChannel.status, 200, JSON.stringify(inChannel.body));
    assert.equal(inChannel.body.item.id, `${ids.cutoverChannel}/p5`, "a comm thread's bare id names a post in its channel");
    const missing = await mark("p9999", true, ids.vent);
    assert.equal(missing.status, 404);
    assert.match((missing.body as { error: string }).error, /^No post p9999 in dm_vent/);
  });

  test("Mark all completed marks several items in one write, answers only the changed ids, and its Undo makes them pending again", async () => {
    const a = post(GENERAL, "owner", { mentions: [VENT] });
    const b = post(GENERAL, "owner", { mentions: [VENT] });
    const ids: [string, string] = [`${GENERAL}/${a.id}`, `${GENERAL}/${b.id}`];
    assert.equal((await mark(ids[0], true)).status, 200);
    const before = (await list()).pending;
    const many = (messageIds: unknown, completed: unknown) => s.send<{ changed: string[]; pending: number; error?: string }>("POST", `/api/agents/${VENT}/for-me`, { messageIds, completed });
    const done = await many([...ids, ids[1]], true);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body.changed, [ids[1]], "the item that was completed already is not changed, and a repeated id counts once");
    assert.equal(done.body.pending, before - 1);
    const undone = await many(done.body.changed, false);
    assert.deepEqual(undone.body.changed, [ids[1]]);
    assert.equal((await find(ids[1]))!.status, "pending");
    assert.equal((await find(ids[0]))!.status, "completed");
    for (const [answer, status] of [[await many([], true), 400], [await many(["p1"], true), 400], [await many(ids, "yes"), 400], [await many([`${GENERAL}/p9999`], true), 404]] as const) {
      assert.equal(answer.status, status, JSON.stringify(answer.body));
      assert.match((answer.body as { error: string }).error, /^[^\n]+\.$/);
    }
  });

  test("a bad request answers 400 and an unknown agent or an item off the list 404, each with one sentence", async () => {
    const answers = [
      [await s.send("GET", "/api/agents/ag_nobody/for-me"), 404],
      [await s.send("GET", `/api/agents/${VENT}/for-me?status=done`), 400],
      [await mark(`${GENERAL}/p1`, true, "ag_nobody"), 404],
      [await mark("p12", true), 400],
      [await mark(undefined, true), 400],
      [await mark(`${GENERAL}/p1`, "yes"), 400],
      [await mark(`${GENERAL}/p1`, true), 404],
      [await mark("ch_nowhere/p1", true), 404],
    ] as const;
    for (const [answer, status] of answers) {
      assert.equal(answer.status, status, JSON.stringify(answer.body));
      assert.match((answer.body as { error: string }).error, /^[^\n]+\.$/);
    }
  });

  test("the for_me event reaches only the page that watches for:<agent>, on a new post and on a mark", async () => {
    const watcher = await s.live();
    const other = await s.live();
    const idle = await s.live();
    watcher.watch(`for:${VENT}`);
    other.watch(`for:${agents.frontend}`);
    const first = await watcher.waitFor(isForMe(VENT));
    assert.equal(first.pending, (await list()).pending);
    await other.waitFor(isForMe(agents.frontend));

    const count = () => watcher.events.filter(isForMe(VENT)).length;
    const seen = count();
    const target = post(GENERAL, "owner", { mentions: [VENT] });
    const onPost = await until(async () => watcher.events.filter(isForMe(VENT)), events => events.length > seen);
    assert.equal(onPost.at(-1)!.pending, first.pending + 1);
    const afterPost = count();
    await mark(`${GENERAL}/${target.id}`, true);
    const onMark = await until(async () => watcher.events.filter(isForMe(VENT)), events => events.length > afterPost);
    assert.equal(onMark.at(-1)!.pending, first.pending);

    assert.equal(other.events.some(isForMe(VENT)), false, "a page on another agent's list hears nothing of Vent's");
    assert.equal(idle.events.some(e => e.type === "for_me"), false, "a page that watches no list gets no for_me");
    watcher.close();
    other.close();
    idle.close();
  });

  test("a watch of an unknown agent's list answers an error event", async () => {
    const page = await s.live();
    page.watch("for:ag_nobody");
    const error = await page.waitFor(e => e.type === "error");
    assert.match((error as Extract<LiveEvent, { type: "error" }>).message, /No agent ag_nobody/);
    page.close();
  });
});
