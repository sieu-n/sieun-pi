/**
 * A thread reply on a channel's sidebar row (#sw-factory-build p213): a reply in a thread the owner started or replied in, or one that names
 * him, makes the row bold (`hasNew`), a reply in a thread he is not in leaves it read, and his page's read past every top-level post clears
 * it, also when the thread's root is off his page (server/group-rooms.ts `summary`, app.ts `readShown`).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/thread-unread.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { RoomPost } from "../../server/agent-store.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import type { ConversationSummary, Sidebar } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

describe("a thread reply on a channel's row", () => {
  let s: Running;
  let n = 0;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  const row = async (id: string): Promise<ConversationSummary> => (await s.get<Sidebar>("/api/sidebar")).channels.find(c => c.id === id)!;
  const channel = async (): Promise<string> => (await s.send("POST", "/api/rooms", { kind: "channel", name: `threads-${crypto.randomUUID().slice(0, 8)}`, members: [] })).body.id as string;
  const own = async (room: string, text: string, threadRoot?: string): Promise<{ id: string; seq: number }> =>
    (await s.send("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID(), ...(threadRoot ? { threadRoot } : {}) })).body.item;
  const agent = (room: string, extra: Partial<RoomPost> = {}): RoomPost => {
    const made = s.app.agentStore.append({ room, author: agents.vent, text: `agent post ${++n}`, images: [], at: Date.now(), requestId: `thread-unread:${n}`, ...extra }).post;
    s.app.groups.emit(s.app.groups.row(room)!, [made]);
    return made;
  };
  const read = (room: string, seq: number) => s.send("POST", `/api/c/${room}/read`, { seq });

  test("a reply in a thread he started makes the row bold, and reading the room clears it", async () => {
    const room = await channel();
    const root = await own(room, "who owns the relay?");
    assert.equal((await row(room)).hasNew, false);
    const reply = agent(room, { threadRoot: root.id });
    const bold = await row(room);
    assert.equal(bold.hasNew, true, "a reply in his own thread is new");
    assert.equal(bold.unread, 0, "a channel counts only mentions");
    await read(room, reply.seq);
    assert.equal((await row(room)).hasNew, false);
  });

  test("a reply in a thread he replied in is new, one in a thread he is not in is not, and one that names him counts as a mention", async () => {
    const room = await channel();
    const theirs = agent(room);
    await read(room, theirs.seq);
    agent(room, { threadRoot: theirs.id });
    assert.equal((await row(room)).hasNew, false, "a thread he is not in leaves the row read");

    const mention = agent(room, { threadRoot: theirs.id, mentions: ["owner"] });
    const named = await row(room);
    assert.deepEqual([named.hasNew, named.unread], [true, 1], "a reply that names him counts");
    await read(room, mention.seq);

    await own(room, "on it", theirs.id);
    agent(room, { threadRoot: theirs.id });
    assert.equal((await row(room)).hasNew, true, "a reply after his own reply is new");
  });

  test("a read past every top-level post clears a reply whose root is off his page", async () => {
    const room = await channel();
    const root = await own(room, "old question");
    const top = agent(room);
    agent(room, { threadRoot: root.id });
    assert.equal((await row(room)).hasNew, true);
    await read(room, top.seq);
    assert.equal((await row(room)).hasNew, false, "the room shows no post after the read, so the reply reads too");

    const later = agent(room, { threadRoot: root.id });
    const newer = agent(room);
    await read(room, later.seq - 1);
    assert.equal((await row(room)).hasNew, true, "a top-level post past the read keeps the room new");
    await read(room, newer.seq);
    assert.equal((await row(room)).hasNew, false);
  });

  test("Undo of Mark all as read brings back a room new only from a thread reply", async () => {
    const room = await channel();
    const root = await own(room, "undo check");
    agent(room, { threadRoot: root.id });
    const all = await s.send<{ before: unknown[] }>("POST", "/api/read", { rooms: [room] });
    assert.equal((await row(room)).hasNew, false);
    await s.send("POST", "/api/read", { restore: all.body.before });
    assert.equal((await row(room)).hasNew, true);
  });
});
