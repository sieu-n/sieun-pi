/**
 * Reactions on room posts (server/reactions.ts): one model for the owner and agents, the post an agent's message id names, and the one line
 * every agent-facing surface shows. On the fixture server the owner and an agent's set_emoji call (`POST /api/threads/:thread/reactions`)
 * put emoji on and off, and the envelope's context lines and search hits carry the reactions.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/reactions.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, Principal, SearchResult, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { AgentRecord, RoomPost } from "../../server/agent-store.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { agentPost, react, ReactionError, reactionInput, reactionsLine, reactionText } from "../../server/reactions.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

const people: Record<string, Principal> = {
  owner: { id: "owner", kind: "owner", name: "You", avatar: { initials: "Me", hue: 210 } },
  ag_vent: { id: "ag_vent", kind: "chat", name: "vent", avatar: { initials: "V", hue: 1 } },
  "ag_agent-factory": { id: "ag_agent-factory", kind: "chat", name: "agent factory", avatar: { initials: "AF", hue: 2 } },
};
const principal = (id: string): Principal => people[id]!;
const record = { id: "ag_vent", room: "dm_vent", workThread: "W", comm: { dm_vent: "C" } } as unknown as AgentRecord;

/** A DM post written at `at` and delivered to `thread` at `delivered`, or not delivered with no `delivered`. */
function post(seq: number, at: number, delivered?: number, thread = "C"): RoomPost {
  return {
    id: `p${seq}`, seq, room: "dm_vent", author: "owner", text: `post ${seq}`, images: [], at, requestId: `r:${seq}`,
    ...(delivered === undefined ? {} : { delivery: { target: "ag_vent", state: "delivered" as const, attempts: 1, at: delivered, requestId: `d:${seq}`, thread } }),
  };
}

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ReactionError ? error.status : -1;
  }
  return undefined;
};

describe("the reaction model", () => {
  test("an emoji is a Slack name, a :name: or the emoji itself, and on is true unless given", () => {
    assert.deepEqual(reactionInput({ emoji: "eyes" }), { emoji: "👀", on: true });
    assert.deepEqual(reactionInput({ emoji: ":+1:", on: false }), { emoji: "👍", on: false });
    assert.deepEqual(reactionInput({ emoji: "⏳" }), { emoji: "⏳", on: true }, "no emoji is the server's own");
    assert.equal(status(() => reactionInput({ emoji: "notanemoji" })), 400);
    assert.equal(status(() => reactionInput({ emoji: "eyes", on: "yes" })), 400);
  });

  test("each principal puts an emoji on once and takes only its own off", () => {
    const p = post(1, 0);
    p.reactions = react(p, "ag_vent", "👀", true);
    assert.equal(react(p, "ag_vent", "👀", true), undefined, "a second put changes nothing");
    p.reactions = react(p, "owner", "👀", true);
    p.reactions = react(p, "ag_vent", "👀", false);
    assert.deepEqual(p.reactions?.map(r => [r.emoji, r.by]), [["👀", "owner"]]);
    assert.equal(react(p, "ag_vent", "👀", false), undefined, "taking off one that is not there changes nothing");
  });

  test("an agent reads reactions in one line, one emoji per group in the order each first came", () => {
    const p = post(1, 0);
    assert.equal(reactionsLine(principal, p), "");
    p.reactions = [{ emoji: "👀", by: "ag_vent", at: 1 }, { emoji: "👍", by: "owner", at: 2 }, { emoji: "👀", by: "ag_agent-factory", at: 3 }];
    assert.equal(reactionsLine(principal, p), "[reactions: 👀 vent, agent factory · 👍 Sieun (owner)]");
    assert.equal(reactionText(principal, p, "👀", true, false), "👀 is on p1 in dm_vent. Reactions now: 👀 vent, agent factory · 👍 Sieun (owner).");
    assert.equal(reactionText(principal, post(2, 0), "👀", false, true), "👀 is off dm_vent/p2. Reactions now: none.");
  });

  test("a message id names a post by pN, N or post N, or by the time pi-host stamped on its input", () => {
    const t0 = Date.UTC(2026, 10, 3);
    const posts = [post(1, t0 + 1000, t0 + 1500), post(2, t0 + 2000, t0 + 2600), post(3, t0 + 3000), post(4, t0 + 4000, t0 + 4500, "W")];
    for (const id of ["p2", "2", "post 2", "P2"]) assert.equal(agentPost(posts, record, "C", "dm_vent", id).id, "p2");
    const id = (t: number) => (t0 + t).toString(36);
    assert.equal(agentPost(posts, record, "C", "dm_vent", id(2300)).id, "p2", "post.at <= T <= delivery.at");
    assert.equal(agentPost(posts, record, "C", "dm_vent", id(1800)).id, "p1", "else the latest delivered post written before T");
    assert.equal(agentPost(posts, record, "C", "dm_vent", id(3200)).id, "p2", "a post not delivered, or delivered to another thread, is passed over");
    assert.equal(status(() => agentPost(posts, record, "C", "dm_vent", "p9")), 404);
    assert.equal(status(() => agentPost(posts, record, "C", "dm_vent", id(500))), 404);
    assert.equal(status(() => agentPost(posts, record, "C", "dm_vent", "the last one")), 400);
  });
});

describe("reactions on the fixture server", () => {
  let s: Running;
  const ROOM = "dm_vent";
  const posts = async (room = ROOM): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  const agentReact = (thread: string, body: Record<string, unknown>) =>
    s.send<{ room: string; post: string; text: string; error?: string }>("POST", `/api/threads/${encodeURIComponent(thread)}/reactions`, body);
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("the owner puts any emoji on a post and takes it off, the room's watchers see each, and bad input is refused", async () => {
    const live = await s.live();
    live.watch(ROOM);
    const target = (await posts()).at(-1)!;
    const on = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "+1" });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.item.reactions?.map(r => [r.emoji, r.by.map(b => b.id)]), [["👍", ["owner"]]]);
    await live.waitFor(e => e.type === "items" && e.conversation === ROOM && e.items.some(i => i.id === target.id && i.kind === "message" && !!i.reactions?.length));
    const again = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "👍" });
    assert.equal(again.body.item.reactions?.[0]?.by.length, 1, "a second put of the same emoji changes nothing");
    const off = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "👍", on: false });
    assert.equal(off.body.item.reactions, undefined);
    const hourglass = await s.send<{ item: Message }>("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "⏳" });
    assert.equal(hourglass.status, 200, "the owner may put any emoji on, also ⏳");
    await s.send("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "⏳", on: false });
    assert.equal((await s.send("POST", `/api/c/${ROOM}/posts/${target.id}/reactions`, { emoji: "notanemoji" })).status, 400);
    assert.equal((await s.send("POST", `/api/c/${ROOM}/posts/p999999/reactions`, { emoji: "👍" })).status, 404);
    const channel = (await posts("ch_cutover")).at(-1)!;
    const inChannel = await s.send<{ item: Message }>("POST", `/api/c/ch_cutover/posts/${channel.id}/reactions`, { emoji: "🎉" });
    assert.equal(inChannel.body.item.reactions?.[0]?.emoji, "🎉");
    await s.send("POST", `/api/c/ch_cutover/posts/${channel.id}/reactions`, { emoji: "🎉", on: false });
    live.close();
  });

  test("an agent's set_emoji names the owner's DM post by its [message id], whose time falls between the post and its delivery", async () => {
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "reaction walk", requestId: "react-1" });
    const stored = () => s.app.agentStore.postsOf(ROOM).find(p => p.text === "reaction walk");
    await until(async () => stored(), p => p?.delivery?.state === "delivered", 20_000);
    const p = stored()!;
    const thread = p.delivery!.thread ?? s.app.agents.record(agents.vent)!.workThread;
    const input = (await s.host.entries(thread, { conversation: 1, limit: 200 })).entries.find(e => e.kind === "pi.user" && JSON.stringify(e.model).includes("reaction walk"))!;
    const stamped = (input.model![0] as { timestamp: number }).timestamp;
    assert.ok(p.at <= stamped && stamped <= p.delivery!.at, `post.at ${p.at} <= T ${stamped} <= delivery.at ${p.delivery!.at}`);

    const live = await s.live();
    live.watch(ROOM);
    const on = await agentReact(thread, { message: stamped.toString(36), emoji: "eyes", on: true });
    assert.equal(on.status, 200, on.body.error);
    assert.equal(on.body.post, p.id);
    assert.equal(on.body.text, `👀 is on ${p.id} in ${ROOM}. Reactions now: 👀 Vent.`);
    await live.waitFor(e => e.type === "items" && e.items.some(i => i.id === p.id && i.kind === "message" && !!i.reactions?.some(r => r.by.some(b => b.id === agents.vent))));
    live.close();
    await s.send("POST", `/api/c/${ROOM}/posts/${p.id}/reactions`, { emoji: "👍" });
    const off = await agentReact(thread, { message: `${ROOM}/${p.id}`, emoji: "👀", on: false });
    assert.equal(off.body.text, `👀 is off ${ROOM}/${p.id}. Reactions now: 👍 Sieun (owner).`);
    const again = await agentReact(thread, { message: p.id, emoji: "👀", on: false });
    assert.equal(again.status, 200, "taking off a reaction that is not there is no error");
  });

  test("a comm thread reacts in its own room and by a room-qualified id, only in rooms its agent is in, and says what to pass on a bad call", async () => {
    const crawler = s.app.agents.record(agents.crawler)!;
    const comm = crawler.comm!.ch_cutover!;
    const target = s.app.agentStore.postsOf("ch_cutover").find(p => p.id === "p5")!;
    assert.equal((await agentReact(comm, { message: "post 5", emoji: "eyes", on: true })).body.post, "p5");
    assert.equal((await agentReact(comm, { message: "ch_cutover/p5", emoji: "white_check_mark", on: true })).body.text, "✅ is on ch_cutover/p5. Reactions now: 👀 Crawler VP · ✅ Crawler VP.");
    const notMember = await agentReact(comm, { message: "dm_vent/p1", emoji: "eyes", on: true });
    assert.equal(notMember.status, 404);
    assert.match(notMember.body.error ?? "", /is not in room dm_vent/);
    assert.equal((await agentReact("no-such-thread", { message: "p1", emoji: "eyes", on: true })).status, 404);
    assert.equal((await agentReact(comm, { message: "p5", emoji: "notanemoji", on: true })).status, 400);
    assert.equal((await agentReact(comm, { message: "p999", emoji: "eyes", on: true })).status, 404);
    assert.equal((await agentReact(comm, { emoji: "eyes", on: true })).status, 400);

    // The envelope's context lines carry the reactions, as a later post's thread so far shows p5.
    const row = s.app.groups.row("ch_cutover")!;
    const later = { ...target, id: "p99", seq: 99, threadRoot: "p5", text: "a later reply", reactions: [] };
    assert.match(s.app.groups.envelope(row, later), /^5 .*\[reactions: 👀 Crawler VP · ✅ Crawler VP\]$/m);
    // A search hit on the post carries the same line.
    const word = target.text.split(/\s+/).find(w => /^[a-z]{5,}$/i.test(w))!;
    const found = await s.get<SearchResult>(`/api/search?q=${encodeURIComponent(word)}&in=ch_cutover`);
    assert.equal(found.hits.find(h => h.messageId === "p5")?.reactionsLine, "[reactions: 👀 Crawler VP · ✅ Crawler VP]");
  });
});
