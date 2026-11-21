/**
 * The owner's star, mute, close and leave per room (server/sidebar-prefs.ts, `PUT /api/c/:id/prefs`): the sidebar rows carry them, a DM with
 * no posts reads as closed, a closed DM comes back with its next post, a left channel comes back when the owner posts there, and a bad body
 * or an unknown room is refused.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/sidebar-prefs.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ConversationSummary, Sidebar } from "../../web/src/lib/api/types.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { applyPrefs, parsePrefsPatch, withPrefs } from "../../server/sidebar-prefs.ts";
import { start, type Running } from "./helpers.ts";

const row = (s: Sidebar, id: string): ConversationSummary | undefined => [...s.solo, ...s.channels, ...s.dms].find(r => r.id === id);

describe("sidebar prefs", () => {
  let s: Running;
  before(async () => {
    s = await start({ wordMs: 0 });
  });
  after(async () => {
    await s.close();
  });

  test("parse and apply keep only what is set", () => {
    assert.deepEqual(parsePrefsPatch({ starred: true, hidden: null }), { starred: true, hidden: null });
    assert.match(String(parsePrefsPatch({ starred: "yes" })), /true or false/);
    assert.match(String(parsePrefsPatch({ pinned: true })), /not pinned/);
    assert.match(String(parsePrefsPatch({ hidden: "gone" })), /closed/);
    assert.deepEqual(applyPrefs(undefined, { muted: true, hidden: "left" }, 5), { muted: true, hidden: { kind: "left", at: 5 } });
    assert.equal(applyPrefs({ starred: true }, { starred: false }, 5), undefined);
    const dm = { id: "dm_x", kind: "dm" } as ConversationSummary;
    assert.equal(withPrefs(dm, undefined, []).hidden, "closed", "a DM with no posts is not listed");
    assert.equal(withPrefs(dm, { hidden: { kind: "closed", at: 10 } }, [{ at: 11, author: "ag_x" }]).hidden, undefined);
    const ch = { id: "ch_x", kind: "channel" } as ConversationSummary;
    assert.equal(withPrefs(ch, { hidden: { kind: "left", at: 10 } }, [{ at: 11, author: "ag_x" }]).hidden, "left", "an agent's post does not bring a left channel back");
    assert.equal(withPrefs(ch, { hidden: { kind: "left", at: 10 } }, [{ at: 11, author: "owner" }]).hidden, undefined);
  });

  test("star, mute, leave and close reach the sidebar rows, and posts bring rooms back", async () => {
    const star = await s.send("PUT", `/api/c/${ids.cutoverChannel}/prefs`, { starred: true, muted: true });
    assert.equal(star.status, 200, JSON.stringify(star.body));
    assert.deepEqual(star.body, { starred: true, muted: true });
    let sb = await s.get<Sidebar>("/api/sidebar");
    assert.equal(row(sb, ids.cutoverChannel)?.starred, true);
    assert.equal(row(sb, ids.cutoverChannel)?.muted, true);

    assert.equal((await s.send("PUT", `/api/c/${ids.cutoverChannel}/prefs`, { hidden: "left" })).status, 200);
    sb = await s.get<Sidebar>("/api/sidebar");
    assert.equal(row(sb, ids.cutoverChannel)?.hidden, "left");
    const word = `prefs${Date.now().toString(36)}`;
    assert.equal((await s.send("POST", `/api/c/${ids.cutoverChannel}/send`, { text: word, requestId: `p-${word}` })).status, 200);
    sb = await s.get<Sidebar>("/api/sidebar");
    assert.equal(row(sb, ids.cutoverChannel)?.hidden, undefined, "the owner's post joins the channel again");

    const dm = sb.dms.find(d => !d.hidden);
    assert.ok(dm, "the fixture has a DM with posts");
    assert.equal((await s.send("PUT", `/api/c/${dm.id}/prefs`, { hidden: "closed" })).status, 200);
    sb = await s.get<Sidebar>("/api/sidebar");
    assert.equal(row(sb, dm.id)?.hidden, "closed");
    assert.equal((await s.send("PUT", `/api/c/${dm.id}/prefs`, { hidden: null })).status, 200);
    sb = await s.get<Sidebar>("/api/sidebar");
    assert.equal(row(sb, dm.id)?.hidden, undefined, "Undo brings it back");

    assert.equal((await s.send("PUT", `/api/c/${ids.cutoverChannel}/prefs`, { starred: 1 })).status, 400);
    assert.equal((await s.send("PUT", `/api/c/dm_nobody/prefs`, { starred: true })).status, 404);
  });

  test("a walk's room turns into a test room afterwards and leaves the sidebar and the archived list", async () => {
    const made = await s.send("POST", "/api/rooms", { kind: "channel", name: `walk-${Date.now().toString(36)}`, members: [] });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = (made.body as { id: string }).id;
    assert.ok(row(await s.get<Sidebar>("/api/sidebar"), id));
    assert.equal((await s.send("PATCH", `/api/rooms/${id}`, { archived: true, test: true })).status, 200);
    assert.equal(row(await s.get<Sidebar>("/api/sidebar"), id), undefined);
    const archived = await s.get<{ id: string }[] | { rooms: { id: string }[] }>("/api/rooms?archived=1");
    const list = Array.isArray(archived) ? archived : archived.rooms;
    assert.equal(list.some(r => r.id === id), false);
    assert.equal((await s.send("PATCH", `/api/rooms/${id}`, { test: false })).status, 400);
  });
});
