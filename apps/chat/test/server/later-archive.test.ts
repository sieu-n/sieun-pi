/**
 * Later's Archived tab and test-room posts (server/later.ts) on the fixture server: an item moves between In progress, Archived and
 * Completed, each tab counts its own, archiving a Keep unread item handles its post, and a post saved in a walk's test room stays out of
 * the owner's lists and badge unless `test=1` asks for it.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/later-archive.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, LaterItem, LaterList, TimelinePage } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

describe("Later's Archived tab and test rooms", () => {
  let s: Running;
  const posts = async (room: string): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  const save = (body: Record<string, unknown>) => s.send<{ item: LaterItem; error?: string }>("POST", "/api/later", body);
  const patch = (id: string, body: Record<string, unknown>) => s.send<{ item: LaterItem; error?: string }>("PATCH", `/api/later/${encodeURIComponent(id)}`, body);
  const counts = (l: LaterList) => [l.open, l.archived, l.done];
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("an item moves between In progress, Archived and Completed, and each tab counts its own", async () => {
    const post = (await posts("ch_cutover")).at(-1)!;
    const id = (await save({ room: "ch_cutover", post: post.id })).body.item.id;

    const archived = await patch(id, { state: "archived" });
    assert.equal(archived.status, 200, archived.body.error);
    assert.equal(archived.body.item.state, "archived");
    assert.ok(archived.body.item.archivedAt);
    const tab = await s.get<LaterList>("/api/later?state=archived");
    assert.deepEqual(tab.items.map(i => i.id), [id]);
    assert.deepEqual(counts(tab), [0, 1, 0]);
    assert.equal((await posts("ch_cutover")).find(p => p.id === post.id)!.later, undefined, "an archived item marks no post");

    const done = await patch(id, { state: "done" });
    assert.equal(done.body.item.archivedAt, undefined, "Completed drops the archive time");
    assert.ok(done.body.item.doneAt);
    assert.deepEqual(counts(await s.get<LaterList>("/api/later?state=done")), [0, 0, 1]);

    const again = await patch(id, { state: "archived" });
    assert.equal(again.body.item.doneAt, undefined, "Archived drops the done time");
    const open = await patch(id, { state: "open" });
    assert.deepEqual([open.body.item.state, open.body.item.archivedAt, open.body.item.doneAt], ["open", undefined, undefined]);

    await patch(id, { state: "archived" });
    const saved = await save({ room: "ch_cutover", post: post.id });
    assert.equal(saved.body.item.state, "open", "saving an archived post opens it again");
    assert.equal((await s.send<{ error?: string }>("GET", "/api/later?state=later")).status, 400);
    await s.send("DELETE", `/api/later/${encodeURIComponent(id)}`);
  });

  test("archiving a Keep unread item handles the post, so its room reads again", async () => {
    const room = ((await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: "later-archive-unread", members: [] })).body).id;
    const sent: string[] = [];
    for (const text of ["one", "two", "three"]) sent.push((await s.send<{ item: { id: string } }>("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID() })).body.item.id);
    assert.equal((await s.send("POST", `/api/c/${room}/read`, { unreadFrom: sent[1] })).status, 200);
    assert.equal(s.app.store.state.reads[room]?.from, sent[1]);
    await patch(`${room}:${sent[1]}`, { state: "archived" });
    assert.notEqual(s.app.store.state.reads[room]?.from, sent[1], "the room no longer reads unread from the archived post");
  });

  test("a post saved in a test room stays out of the owner's lists and badge unless test=1 asks for it", async () => {
    const live = await s.live();
    const room = ((await s.send<{ id: string }>("POST", "/api/rooms", { kind: "channel", name: "later-archive-test", members: [], test: true })).body).id;
    const post = (await s.send<{ item: { id: string } }>("POST", `/api/c/${room}/send`, { text: "walk post", requestId: crypto.randomUUID() })).body.item.id;
    const before = (await s.get<LaterList>("/api/later?state=open")).open;
    const saved = await save({ room, post });
    assert.equal(saved.status, 200, saved.body.error);
    const event = await live.waitFor(e => e.type === "later" && e.by === "owner");
    assert.equal((event as { open: number }).open, before, "the badge does not count it");
    const owner = await s.get<LaterList>("/api/later?state=open");
    assert.equal(owner.open, before);
    assert.ok(!owner.items.some(i => i.room === room));
    const walk = await s.get<LaterList>("/api/later?state=open&test=1");
    assert.equal(walk.items.find(i => i.room === room)?.test, true);
    assert.equal(walk.open, before + 1);
    live.close();
  });
});
