/**
 * Threads in a DM (server/rooms.ts): the owner replies in the thread of any DM post, the agent reads the reply with its thread, its answer
 * lands in that thread, and the DM's timeline shows only root posts with a reply count, as a channel's does.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/dm-threads.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, Sidebar, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const ROOM = "dm_vent";
const roots = async (s: Running): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${ROOM}/items?limit=200`)).items as Message[];
const thread = (s: Running, root: string) => s.get<{ root: Message; items: Message[] }>(`/api/c/${ROOM}/replies/${root}`);

describe("threads in a DM", () => {
  let s: Running;
  let host: FixtureHost;
  before(async () => {
    s = await start({ wordMs: 2 });
    host = s.host as FixtureHost;
  });
  after(async () => {
    await s.close();
  });

  test("a reply on an agent's DM post goes in its thread, reaches the agent with the thread, and the answer lands in the thread", async () => {
    const asked = `which relay errors ${Date.now()}`;
    await s.send("POST", `/api/c/${ROOM}/send`, { text: asked, requestId: "dmt-1" });
    const page = await until(() => roots(s), p => p.some(m => m.author.id === agents.vent && m.text.includes(asked)));
    const root = page.find(m => m.author.id === agents.vent && m.text.includes(asked))!;

    const text = `and the second one? ${Date.now()}`;
    const sent = await s.send("POST", `/api/c/${ROOM}/send`, { text, requestId: "dmt-2", threadRoot: root.id });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.item.threadRoot, root.id);

    const comm = s.app.agents.record(agents.vent)!.comm![ROOM]!;
    const input = await until(
      async () => host.threadsById.get(comm)!.entries.find(e => e.kind === "pi.user" && JSON.stringify(e.model?.[0]?.content).includes(text)),
      found => found !== undefined,
    );
    const content = input!.model![0]!.content;
    const said = typeof content === "string" ? content : (content as { type: string; text?: string }[]).map(b => b.text ?? "").join("\n");
    assert.match(said, new RegExp(`a reply in the thread of post ${root.seq} in your DM`));
    assert.match(said, /\(thread so far\)/);
    assert.ok(said.includes(root.text.slice(0, 20)), "the input carries the root post");

    const replies = await until(() => thread(s, root.id), t => t.items.some(m => m.author.id === agents.vent));
    assert.deepEqual(replies.items.map(m => m.author.id), ["owner", agents.vent, agents.vent], "his reply and the agent's answers, in the thread");
    assert.ok(replies.items.every(m => m.threadRoot === root.id));
    assert.equal(replies.items[1]!.answers, sent.body.item.id);

    const after = await roots(s);
    assert.equal(after.some(m => m.threadRoot), false, "the DM's timeline shows root posts only");
    const shown = after.find(m => m.id === root.id)!;
    assert.equal(shown.thread?.replies, 3);
    assert.equal(shown.thread?.lastSeq, replies.items.at(-1)!.seq);

    const around = await s.get<TimelinePage>(`/api/c/${ROOM}/items?around=${replies.items[1]!.id}`);
    assert.equal(around.focus, root.id, "a link to a reply opens its root");
  });

  test("a read up to the newest reply clears the DM's unread count", async () => {
    const page = await roots(s);
    const root = page.find(m => m.thread)!;
    const before = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id === ROOM)!;
    assert.ok(before.unread > 0, "the agent's thread answers count as unread");
    await s.send("POST", `/api/c/${ROOM}/read`, { seq: Math.max(page.at(-1)!.seq!, root.thread!.lastSeq!) });
    const row = (await s.get<Sidebar>("/api/sidebar")).dms.find(c => c.id === ROOM)!;
    assert.equal(row.unread, 0);
  });

  test("a thread starts only on a root post of the DM", async () => {
    const page = await roots(s);
    const root = page.find(m => m.thread)!;
    const reply = (await thread(s, root.id)).items[0]!;
    for (const threadRoot of [reply.id, "p99999"]) {
      const sent = await s.send("POST", `/api/c/${ROOM}/send`, { text: "x", requestId: `dmt-bad-${threadRoot}`, threadRoot });
      assert.equal(sent.status, 400, threadRoot);
    }
  });
});
