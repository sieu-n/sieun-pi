/**
 * Save for later (server/later.ts) on the fixture server: the owner saves a DM post and a channel post, checks one off and opens it again,
 * sets and clears a reminder, and unsaves. Each post carries its `later` mark for him, and each write sends a live `later` event.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/later.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Item, LaterItem, LaterList, TimelinePage } from "../../web/src/lib/api/types.ts";
import { drained } from "../../server/disk.ts";
import { start, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

describe("save for later on the fixture server", () => {
  let s: Running;
  const posts = async (room: string): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  const save = (body: Record<string, unknown>) => s.send<{ item: LaterItem; error?: string }>("POST", "/api/later", body);
  const patch = (id: string, body: Record<string, unknown>) => s.send<{ item: LaterItem; error?: string }>("PATCH", `/api/later/${encodeURIComponent(id)}`, body);
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("a save is one item per post, rows show the post, and a post carries its mark", async () => {
    const live = await s.live();
    const dm = (await posts("dm_vent")).at(-1)!;
    const first = await save({ room: "dm_vent", post: dm.id });
    assert.equal(first.status, 200, first.body.error);
    assert.equal(first.body.item.id, `dm_vent:${dm.id}`);
    assert.equal(first.body.item.state, "open");
    await live.waitFor(e => e.type === "later" && e.by === "owner" && e.open === 1);
    const again = await save({ room: "dm_vent", post: dm.id });
    assert.equal(again.body.item.savedAt, first.body.item.savedAt, "a second save keeps the one item");

    const channel = (await posts("ch_cutover")).at(-1)!;
    await save({ room: "ch_cutover", post: channel.id });
    const list = await s.get<LaterList>("/api/later?state=open");
    assert.equal(list.open, 2);
    assert.deepEqual(list.items.map(i => i.room), ["ch_cutover", "dm_vent"], "newest save first");
    const row = list.items[0]!;
    assert.equal(row.roomName, "#pi-cutover");
    assert.equal(row.author?.id, channel.author.id);
    assert.equal(row.text, channel.text);
    assert.equal(list.items[1]!.roomName, "Vent", "a DM row names its agent");

    const marked = (await posts("ch_cutover")).find(p => p.id === channel.id)!;
    assert.deepEqual(marked.later, { saved: true });
    live.close();
  });

  test("checking off moves an item to done, saving it opens it again, and a reminder is set and cleared", async () => {
    const id = (await s.get<LaterList>("/api/later?state=open")).items[0]!.id;
    const done = await patch(id, { state: "done" });
    assert.equal(done.body.item.state, "done");
    assert.ok(done.body.item.doneAt);
    const lists = await s.get<LaterList>("/api/later?state=done");
    assert.deepEqual([lists.open, lists.done, lists.items.length], [1, 1, 1]);
    const [room, post] = id.split(":");
    assert.equal((await posts(room!)).find(p => p.id === post)!.later, undefined, "a done item marks no post");

    const reopened = await save({ room, post, remindAt: Date.now() + 60_000 });
    assert.equal(reopened.body.item.state, "open");
    assert.equal(reopened.body.item.doneAt, undefined);
    assert.ok(reopened.body.item.remindAt);
    s.app.later.update("owner", id, { notifiedAt: Date.now() });
    const snoozed = await patch(id, { remindAt: Date.now() + 120_000 });
    assert.equal(snoozed.body.item.notifiedAt, undefined, "a new reminder time fires again");
    const cleared = await patch(id, { remindAt: null });
    assert.equal(cleared.body.item.remindAt, undefined);
    assert.equal((await patch(id, { state: "later" })).status, 400);
    assert.equal((await patch(id, { color: "red" })).status, 400);
    assert.equal((await patch("dm_vent:p999999", { state: "done" })).status, 404);
  });

  test("unsave deletes the item once, bad saves are refused, and the list is on disk", async () => {
    assert.equal((await save({ room: "dm_vent", post: "p999999" })).status, 404);
    assert.equal((await save({ room: "dm_vent" })).status, 400);
    assert.equal((await save({ room: "dm_vent", post: "p1", remindAt: "soon" })).status, 400);
    const { items } = await s.get<LaterList>("/api/later");
    const gone = await s.send<{ item: LaterItem | null }>("DELETE", `/api/later/${encodeURIComponent(items[0]!.id)}`);
    assert.equal(gone.body.item?.id, items[0]!.id);
    const twice = await s.send<{ item: LaterItem | null }>("DELETE", `/api/later/${encodeURIComponent(items[0]!.id)}`);
    assert.deepEqual([twice.status, twice.body.item], [200, null], "a second unsave changes nothing");
    // With the kind in chat.sqlite, the list's JSON export follows the DB for the week after the move, so a rollback reads it.
    await s.app.moves.get("later")?.flushExports();
    await drained();
    const file = JSON.parse(readFileSync(join(s.app.config.dataDir, "later", "owner.json"), "utf8")) as { items: LaterItem[] };
    assert.deepEqual(file.items.map(i => i.id), items.slice(1).map(i => i.id));
    assert.throws(() => s.app.later.list("../etc"), /names nobody/);
  });

  test("Undo of an unsave puts the item back as it was, reminder and Keep unread included", async () => {
    const post = (await posts("ch_cutover")).at(-2)!;
    const id = `ch_cutover:${post.id}`;
    const remindAt = Date.now() + 3_600_000;
    await save({ room: "ch_cutover", post: post.id, remindAt });
    const kept = s.app.later.keepUnread("owner", "ch_cutover", post.id, remindAt + 60_000);
    const removed = (await s.send<{ item: LaterItem }>("DELETE", `/api/later/${encodeURIComponent(id)}`)).body.item;
    const back = await s.send<{ item: LaterItem; error?: string }>("PUT", `/api/later/${encodeURIComponent(id)}`, removed);
    assert.equal(back.status, 200, back.body.error);
    assert.deepEqual(back.body.item, kept, "the item comes back with its save time, reminder and unread mark");
    assert.equal((await posts("ch_cutover")).find(p => p.id === post.id)?.later?.remindAt, remindAt);
    assert.equal((await s.send("PUT", `/api/later/${encodeURIComponent("ch_cutover:p999999")}`, removed)).status, 404);
    assert.equal((await s.send("PUT", `/api/later/${encodeURIComponent(id)}`, { ...removed, state: "gone" })).status, 400);
  });

  test("/remind writes a reminder of his own text with no post, its row reads it, it falls due, and Undo of a remove puts it back", async () => {
    const live = await s.live();
    assert.equal((await save({ note: "  ", remindAt: Date.now() + 60_000 })).status, 400);
    const todo = await save({ note: "read [Plan](wiki:projects/plan.html)" });
    assert.deepEqual([todo.status, todo.body.item.remindAt], [200, undefined], "a note with no time is a to-do");
    await s.send("DELETE", `/api/later/${encodeURIComponent(todo.body.item.id)}`);
    const set = await save({ note: "call the bank", remindAt: Date.now() + 60_000 });
    assert.equal(set.status, 200, set.body.error);
    const item = set.body.item;
    assert.match(item.id, /^note:/);
    assert.equal(item.note, "call the bank");
    assert.equal(item.room, undefined);
    const row = (await s.get<LaterList>("/api/later?state=open")).items.find(r => r.id === item.id)!;
    assert.deepEqual([row.text, row.author?.id, row.images], ["call the bank", "owner", 0]);
    await patch(item.id, { remindAt: Date.now() - 1 });
    const due = await live.waitFor(e => e.type === "later_due" && e.row.id === item.id);
    assert.equal(due.type === "later_due" && due.row.text, "call the bank");
    const removed = (await s.send<{ item: LaterItem }>("DELETE", `/api/later/${encodeURIComponent(item.id)}`)).body.item;
    const back = await s.send<{ item: LaterItem; error?: string }>("PUT", `/api/later/${encodeURIComponent(item.id)}`, removed);
    assert.equal(back.status, 200, back.body.error);
    assert.equal(back.body.item.note, "call the bank");
    await s.send("DELETE", `/api/later/${encodeURIComponent(item.id)}`);
  });
});
