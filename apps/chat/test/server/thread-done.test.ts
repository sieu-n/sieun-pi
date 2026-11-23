/**
 * A thread's done flag (server/thread-done.ts): the owner marks the thread of any of its posts done on its root, the page and agents read
 * it, an owner reply in the thread reopens it, an agent's reply leaves it done, and an agent's own mark is refused with 403 (c236).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/thread-done.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ForMeList, Item, Principal, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { RoomPost } from "../../server/agent-store.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { reactionsLine } from "../../server/reactions.ts";
import { AGENT_DONE_REFUSED, doneInput, doneLine, markDone, reopens } from "../../server/thread-done.ts";
import { start, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

const people: Record<string, Principal> = {
  owner: { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
  ag_vent: { id: "ag_vent", kind: "chat", name: "vent", avatar: { initials: "V", hue: 1 } },
};
const principal = (id: string): Principal => people[id]!;

function post(seq: number, extra: Partial<RoomPost> = {}): RoomPost {
  return { id: `p${seq}`, seq, room: "ch_x", author: "owner", text: `post ${seq}`, images: [], at: seq, requestId: `r:${seq}`, ...extra };
}

describe("the done model", () => {
  test("done is a boolean, a second mark the same way changes nothing, and reopening keeps who did it", () => {
    assert.equal(doneInput({ done: true }), true);
    assert.throws(() => doneInput({ done: "yes" }), /true to mark it done or false to reopen it/);
    const root = post(1);
    assert.equal(markDone(root, "owner", false), undefined, "an open thread is already open");
    root.done = markDone(root, "ag_vent", true, 5);
    assert.deepEqual(root.done, { done: true, by: "ag_vent", at: 5 });
    assert.equal(markDone(root, "owner", true), undefined);
    assert.deepEqual(markDone(root, "owner", false, 6), { done: false, by: "owner", at: 6 });
  });

  test("agents read the flag after the reactions, and only while the thread is done", () => {
    const root = post(1, { reactions: [{ emoji: "👍", by: "owner", at: 1 }] });
    assert.equal(reactionsLine(principal, root), "[reactions: 👍 Sieun (owner)]");
    root.done = { done: true, by: "ag_vent", at: 2 };
    assert.equal(reactionsLine(principal, root), "[reactions: 👍 Sieun (owner)] [thread done by vent]");
    root.done = { done: true, by: "owner", at: 3 };
    assert.equal(doneLine(principal, root), "[thread done by Sieun (owner)]");
    root.done = { done: false, by: "owner", at: 4 };
    assert.equal(doneLine(principal, root), "");
  });

  test("only the owner's reply in the done thread reopens it", () => {
    const root = post(1, { done: { done: true, by: "ag_vent", at: 2 } });
    assert.equal(reopens(root, post(2, { threadRoot: "p1" })), true);
    assert.equal(reopens(root, post(3, { threadRoot: "p1", author: "ag_vent" })), false, "an agent's reply leaves it done");
    assert.equal(reopens(root, post(4)), false, "a new top-level post is no reply in the thread");
  });
});

describe("thread done on the fixture server", () => {
  let s: Running;
  const CH = "ch_cutover";
  const items = async (room: string): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  const ownerDone = (room: string, postId: string, done: unknown) => s.send<{ item: Message; error?: string }>("POST", `/api/c/${room}/posts/${postId}/done`, { done });
  const agentDone = (thread: string, body: Record<string, unknown>) =>
    s.send<{ error?: string }>("POST", `/api/threads/${encodeURIComponent(thread)}/done`, body);
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("the owner marks a channel thread done from any of its posts, the watchers see the root, and he reopens it", async () => {
    const root = s.app.agentStore.postsOf(CH).find(p => !p.threadRoot && s.app.agentStore.postsOf(CH).some(r => r.threadRoot === p.id))!;
    const reply = s.app.agentStore.postsOf(CH).find(p => p.threadRoot === root.id)!;
    const live = await s.live();
    live.watch(CH);
    await live.waitFor(e => e.type === "status" && e.conversation === CH);
    const on = await ownerDone(CH, reply.id, true);
    assert.equal(on.status, 200, on.body.error);
    assert.equal(on.body.item.id, root.id, "the flag goes on the thread's root");
    assert.equal(on.body.item.done?.by.id, "owner");
    await live.waitFor(e => e.type === "items" && e.conversation === CH && e.items.some(i => i.id === root.id && i.kind === "message" && !!i.done));
    assert.ok((await items(CH)).find(i => i.id === root.id)?.done, "the timeline reads it done");
    const off = await ownerDone(CH, root.id, false);
    assert.equal(off.body.item.done, undefined);
    assert.deepEqual({ ...s.app.agentStore.postsOf(CH).find(p => p.id === root.id)!.done, at: 0 }, { done: false, by: "owner", at: 0 });
    assert.equal((await ownerDone(CH, root.id, "yes")).status, 400);
    assert.equal((await ownerDone(CH, "p999999", true)).status, 404);
    live.close();
  });

  test("an agent's done mark is refused with 403 (c236); his mark stays, an agent's reply leaves it done and his reply reopens it", async () => {
    const crawler = s.app.agents.record(agents.crawler)!;
    const comm = crawler.comm![CH]!;
    const sent = await s.send<{ item: Message }>("POST", `/api/c/${CH}/send`, { text: "thread done walk", requestId: "done-1", mentions: [agents.crawler] });
    const root = sent.body.item.id;
    const stored = () => s.app.agentStore.postsOf(CH).find(p => p.id === root)!;
    for (const done of [true, false]) {
      const refused = await agentDone(comm, { message: root, done });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, AGENT_DONE_REFUSED);
    }
    assert.equal(stored().done, undefined, "the refused mark left the thread open");
    assert.equal((await ownerDone(CH, root, true)).status, 200);
    assert.equal((await agentDone(comm, { message: root, done: false })).status, 403, "an agent cannot reopen his done thread either");
    assert.equal(stored().done?.by, "owner");

    const row = s.app.groups.row(CH)!;
    const agentReply = s.app.agentStore.append({ room: CH, author: agents.crawler, text: "a later note", images: [], at: Date.now(), requestId: "m:done-note", threadRoot: root });
    assert.ok(agentReply.created);
    assert.equal(stored().done?.done, true, "an agent's reply leaves it done");
    assert.match(s.app.groups.envelope(row, { ...agentReply.post, id: "p99999", seq: 99999 }), new RegExp(`^${stored().seq} .*\\[thread done by Sieun \\(owner\\)\\]$`, "m"));

    const forMe = await s.get<ForMeList>(`/api/agents/${agents.crawler}/for-me`);
    assert.equal(forMe.items.find(i => i.post === root)?.done?.by.id, "owner", "the For list carries the flag");

    await s.send("POST", `/api/c/${CH}/send`, { text: "one more thing", requestId: "done-2", threadRoot: root });
    assert.equal(stored().done?.done, false, "his reply in the thread reopens it");
    assert.equal(stored().done?.by, "owner");
    assert.equal((await items(CH)).find(i => i.id === root)?.done, undefined);
  });

  test("a DM post is its own thread root", async () => {
    const target = (await items("dm_vent")).at(-1)!;
    const on = await ownerDone("dm_vent", target.id, true);
    assert.equal(on.status, 200, on.body.error);
    assert.equal(on.body.item.done?.by.id, "owner");
    await ownerDone("dm_vent", target.id, false);
  });
});
