/**
 * Reactions on room posts (server/reactions.ts): the wip mark follows the agent's run state, through a turn, a hand-over to the work thread
 * and a restart, on fakes; on the fixture server the owner puts his own emoji on and off and a running DM turn shows and clears the mark.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/reactions.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, RunStatus, TimelinePage } from "../../web/src/lib/api/types.ts";
import { WIP_EMOJI } from "../../web/src/lib/api/shared/reactions.ts";
import { AgentStore, type AgentRecord, type RoomPost } from "../../server/agent-store.ts";
import type { Agents } from "../../server/agents.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import type { EntryRecord, Host } from "../../server/host/types.ts";
import { WipReactions } from "../../server/reactions.ts";
import type { Threads } from "../../server/threads.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

/** One agent with a DM and a channel, the run state of each thread, and the work thread's entries, behind a WipReactions. */
function rig(dir: string) {
  const store = new AgentStore(dir);
  const record: AgentRecord = {
    id: "ag_x", slug: "x", name: "X", room: "dm_x", workThread: "W", host: "test-box", home: dir, createdAt: 0, archived: false, comm: { dm_x: "C", ch_t: "CC" },
  };
  const status = new Map<string, RunStatus>();
  const work: EntryRecord[] = [{ id: 1, conversationId: 1, kind: "pi.assistant" }];
  const state = { agent: "idle" as RunStatus, updatedAt: 1 };
  const emitted: string[] = [];
  const deps = {
    store, host: {
      entries: async (_thread: string, opts: { after?: number; limit?: number }) =>
        ({ entries: opts.after === undefined ? work.slice(-1) : work.filter(e => e.id > opts.after!), more: false }),
    } as unknown as Host,
    agents: { list: () => [record], roomThread: (r: AgentRecord) => r.comm?.[r.room] ?? r.workThread } as unknown as Agents,
    threads: {
      statusOfConversation: (thread: string) => status.get(thread) ?? "idle",
      agent: () => ({ status: state.agent }),
      thread: () => ({ updatedAt: state.updatedAt }),
    } as unknown as Threads,
    groupRooms: () => ["ch_t"], emit: (room: string, posts: RoomPost[]) => void emitted.push(...posts.map(p => `${room}/${p.id}`)), log: () => {},
  };
  let seq = 0;
  /** An owner post delivered to `thread` now, in the DM unless `room` names the channel. */
  const post = (thread: string, room = "dm_x", extra: Partial<RoomPost> = {}): RoomPost => {
    const d = { target: record.id, state: "delivered" as const, attempts: 1, at: Date.now(), requestId: `d:${++seq}`, thread };
    return store.append({ room, author: "owner", text: `post ${seq}`, images: [], at: Date.now(), requestId: `r:${seq}`, ...(room === "dm_x" ? { delivery: d } : { deliveries: [d] }), ...extra }).post;
  };
  const wip = (p: RoomPost) => p.reactions?.find(r => r.emoji === WIP_EMOJI && r.by === record.id);
  return { store, record, status, work, state, emitted, deps, post, wip, make: () => new WipReactions(deps) };
}

describe("the wip mark", () => {
  let dir: string;
  before(() => void (dir = mkdtempSync(join(tmpdir(), "apps-chat-wip-"))));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("goes on the post a turn answers and comes off when the turn ends with no hand-over", async () => {
    const r = rig(join(dir, "a"));
    const wip = r.make();
    wip.poll();
    const p = r.post("C");
    r.status.set("C", "working");
    wip.poll();
    await flush();
    assert.equal(r.wip(p)?.mark, 1, "the mark notes the work thread's newest entry");
    assert.deepEqual(r.emitted.filter(x => x === "dm_x/p1").length >= 1, true);
    r.status.set("C", "idle");
    wip.poll();
    await flush();
    assert.equal(r.wip(p), undefined);
    assert.deepEqual(p.reactions, []);
  });

  test("stays through work the turn handed to the work thread, until that thread answered it and the agent rests", async () => {
    const r = rig(join(dir, "b"));
    const wip = r.make();
    wip.poll();
    const p = r.post("C");
    r.status.set("C", "working");
    wip.poll();
    await flush();
    r.work.push({ id: 2, conversationId: 1, kind: "agent.message", data: { from: "C", via: "comm" } });
    r.state.agent = "working";
    r.status.set("C", "idle");
    wip.poll();
    await flush();
    assert.equal(r.wip(p)?.work, 2, "the hand-over's entry is kept");
    r.state.agent = "idle";
    wip.poll();
    await flush();
    assert.ok(r.wip(p), "no answer to the hand-over yet, so it stays");
    r.work.push({ id: 3, conversationId: 1, kind: "pi.assistant" });
    r.state.updatedAt = 2;
    r.status.set("C", "sleeping");
    wip.poll();
    await flush();
    assert.ok(r.wip(p), "the comm thread waits for a slot to answer the report, so it stays");
    r.status.set("C", "idle");
    wip.poll();
    await flush();
    assert.equal(r.wip(p), undefined);
  });

  test("after a restart a running turn marks only the newest delivered post it has not answered, and a mark kept on disk settles", async () => {
    const r = rig(join(dir, "c"));
    const older = r.post("C");
    const newest = r.post("C");
    r.status.set("C", "working");
    r.make().poll();
    await flush();
    assert.equal(r.wip(older), undefined);
    assert.ok(r.wip(newest));
    r.store.append({ room: "dm_x", author: r.record.id, text: "On it.", images: [], at: Date.now(), requestId: "m:1" });
    const fresh = new WipReactions(r.deps);
    fresh.poll();
    await flush();
    assert.ok(r.wip(newest), "a restart keeps the mark of the running turn");
    r.status.set("C", "idle");
    new WipReactions(r.deps).poll();
    await flush();
    assert.equal(r.wip(newest), undefined, "the mark read back from the log comes off when its turn has ended");
    r.status.set("C", "working");
    new WipReactions(r.deps).poll();
    assert.equal(r.wip(newest), undefined, "an answered post gets no mark from a later turn after a restart");
  });

  test("a turn of the channel's comm thread marks each post delivered to it since it was idle, and a notice turn marks none", async () => {
    const r = rig(join(dir, "d"));
    const wip = r.make();
    wip.poll();
    const first = r.post("CC", "ch_t");
    const second = r.post("CC", "ch_t", { threadRoot: first.id });
    r.status.set("CC", "working");
    wip.poll();
    await flush();
    assert.ok(r.wip(first) && r.wip(second));
    r.status.set("CC", "idle");
    wip.poll();
    await flush();
    assert.equal(r.wip(first), undefined);
    r.status.set("CC", "working");
    wip.poll();
    assert.equal(r.wip(second), undefined, "a turn with no new post, such as a work-done notice, puts no mark on");
  });
});

describe("reactions on the fixture server", () => {
  let s: Running;
  const ROOM = "dm_vent";
  const posts = async (room = ROOM): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("the owner puts an emoji on a post and takes it off, the room's watchers see each, and the wip mark and bad input are refused", async () => {
    const live = await s.live();
    live.watch(ROOM);
    const target = (await posts()).at(-1)!;
    const on = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "👍" });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.item.reactions?.map(r => [r.emoji, r.by.map(b => b.id)]), [["👍", ["owner"]]]);
    await live.waitFor(e => e.type === "items" && e.conversation === ROOM && e.items.some(i => i.id === target.id && i.kind === "message" && !!i.reactions?.length));
    const again = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "👍" });
    assert.equal(again.body.item.reactions?.[0]?.by.length, 1, "a second put of the same emoji changes nothing");
    const off = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "👍", on: false });
    assert.equal(off.body.item.reactions, undefined);
    assert.equal((await s.send("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: WIP_EMOJI })).status, 400);
    assert.equal((await s.send("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "ok" })).status, 400);
    assert.equal((await s.send("POST", `/api/c/${ROOM}/posts/p999999/reactions`, { emoji: "👍" })).status, 404);
    const channel = (await posts("ch_cutover")).at(-1)!;
    const inChannel = await s.send<{ item: Message }>("POST", `/api/c/ch_cutover/posts/${channel.id}/reactions`, { emoji: "🎉" });
    assert.equal(inChannel.body.item.reactions?.[0]?.emoji, "🎉");
    live.close();
  });

  test("a running DM turn puts the agent's wip mark on the owner's post, and Stop takes it off", async () => {
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "slow wip walk", requestId: "wip-1" });
    const mark = (page: Message[]) => page.find(p => p.text === "slow wip walk")?.reactions?.find(r => r.emoji === WIP_EMOJI);
    const marked = await until(() => posts(), page => !!mark(page), 20_000);
    assert.deepEqual(mark(marked)!.by.map(b => b.id), [agents.vent]);
    await s.send("POST", `/api/c/${ROOM}/abort`);
    await until(() => posts(), page => !mark(page), 20_000);
  });
});
