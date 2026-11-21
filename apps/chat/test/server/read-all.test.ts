/**
 * Mark all as read on the fixture host: `POST /api/read {rooms}` reads each room to its newest post and answers where each read from, and
 * `{restore}` with that answer is the toast's Undo, which puts each room back, unread from its marked post again when it had one.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/read-all.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ConversationSummary, ReadPoint, Sidebar } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

describe("Mark all as read", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  const row = async (id: string): Promise<ConversationSummary> => (await s.get<Sidebar>("/api/sidebar")).channels.find(c => c.id === id)!;
  const post = async (room: string, text: string): Promise<{ id: string; seq: number }> =>
    (await s.send("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID() })).body.item;
  const channel = async (): Promise<string> => (await s.send("POST", "/api/rooms", { kind: "channel", name: `all-${crypto.randomUUID().slice(0, 8)}`, members: [] })).body.id as string;

  test("reads every room it names, answers their read points, and Undo puts each back", async () => {
    const [a, b] = [await channel(), await channel()];
    const first = await post(a, "one");
    await post(a, "two");
    const marked = await post(b, "three");
    await post(b, "four");
    await s.send("POST", `/api/c/${a}/read`, { seq: first.seq });
    await s.send("POST", `/api/c/${a}/read`, { unreadFrom: first.id });
    await s.send("POST", `/api/c/${b}/read`, { unreadFrom: marked.id });
    assert.equal((await row(a)).hasNew, true);
    assert.equal((await row(b)).unreadFrom, marked.id);

    const res = await s.send("POST", "/api/read", { rooms: [a, b] });
    assert.equal(res.status, 200);
    const points = res.body.before as ReadPoint[];
    assert.deepEqual(points.map(p => p.room), [a, b]);
    assert.equal(points[1]!.from, marked.id);
    assert.equal(points[1]!.seq, marked.seq - 1);
    for (const id of [a, b]) {
      const read = await row(id);
      assert.equal(read.hasNew, false, `${id} reads to its newest post`);
      assert.equal(read.unreadFrom, undefined);
    }

    assert.equal((await s.send("POST", "/api/read", { restore: points })).status, 200);
    assert.equal((await row(a)).unreadFrom, first.id, "a room that read unread from a post does so again");
    const back = await row(b);
    assert.equal(back.hasNew, true);
    assert.equal(back.unreadFrom, marked.id);
    assert.equal((await s.get(`/api/c/${b}`)).readSeq, marked.seq - 1);
  });

  test("a room that had no read point goes back to reading nothing", async () => {
    const c = await channel();
    await post(c, "five");
    const res = await s.send("POST", "/api/read", { rooms: [c] });
    const point = (res.body.before as ReadPoint[])[0]!;
    assert.equal(typeof point.seq, "number");
    await s.send("POST", "/api/read", { restore: [{ room: c, seq: 0 }] });
    assert.equal((await s.get(`/api/c/${c}`)).readSeq, 0);
  });

  test("a body with neither rooms nor restore is refused", async () => {
    assert.equal((await s.send("POST", "/api/read", {})).status, 400);
    assert.equal((await s.send("POST", "/api/read", { restore: [{ room: "ch_x" }] })).status, 400);
  });
});
