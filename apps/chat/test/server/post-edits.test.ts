/**
 * Edit and delete of the owner's own room posts (server/post-edits.ts) on the fixture server: the post's new text with its edit mark, the
 * stub a delete leaves, the owner input each agent that read the post gets, and the posts no one may edit.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/post-edits.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

describe("editing and deleting the owner's own posts", () => {
  let s: Running;
  const ROOM = "dm_vent";
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  const inputs = async (thread: string, words: string) =>
    (await s.host.entries(thread, { conversation: 1, limit: 400 })).entries.filter(e => e.kind === "pi.user" && JSON.stringify(e.model).includes(words));

  test("an edit shows the new text with its mark, and the agent that read the post gets the edit as an owner input", async () => {
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "edit walk: ship the fix to staging", requestId: "edit-1" });
    const stored = () => s.app.agentStore.postsOf(ROOM).find(p => p.requestId === "edit-1");
    await until(async () => stored(), p => p?.delivery?.state === "delivered", 20_000);
    const post = stored()!;
    const live = await s.live();
    live.watch(ROOM);
    const edited = await s.send<{ item: Message }>("PATCH", `/api/c/${ROOM}/posts/${post.id}`, { text: "edit walk: ship the fix to prod" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.item.text, "edit walk: ship the fix to prod");
    assert.ok(edited.body.item.editedAt);
    await live.waitFor(e => e.type === "items" && e.items.some(i => i.id === post.id && i.kind === "message" && !!i.editedAt));
    live.close();
    const page = await s.get<TimelinePage>(`/api/c/${ROOM}/items?limit=200`);
    assert.equal((page.items.find(i => i.id === post.id) as Message).text, "edit walk: ship the fix to prod");
    const thread = post.delivery!.thread!;
    await until(() => inputs(thread, "The owner edited post"), found => found.length === 1, 20_000);
    const notice = JSON.stringify((await inputs(thread, "The owner edited post"))[0]!.model);
    assert.match(notice, new RegExp(`edited post ${post.id} in your DM`));
    assert.match(notice, /ship the fix to staging.*ship the fix to prod/);
    const same = await s.send<{ item: Message }>("PATCH", `/api/c/${ROOM}/posts/${post.id}`, { text: "edit walk: ship the fix to prod" });
    assert.equal(same.status, 200, "the same text again changes nothing");
    assert.equal((await inputs(thread, "The owner edited post")).length, 1, "and tells nobody again");
  });

  test("a delete leaves a stub with no words, tells the agent, and takes no edit after it", async () => {
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "delete walk: wrong room", requestId: "delete-1" });
    const stored = () => s.app.agentStore.postsOf(ROOM).find(p => p.requestId === "delete-1");
    await until(async () => stored(), p => p?.delivery?.state === "delivered", 20_000);
    const post = stored()!;
    const gone = await s.send<{ item: Message }>("DELETE", `/api/c/${ROOM}/posts/${post.id}`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.item.deleted, true);
    assert.equal(gone.body.item.text, "");
    assert.equal(stored()!.text, "", "the store keeps no words of it");
    await until(() => inputs(post.delivery!.thread!, "The owner deleted post"), found => found.length === 1, 20_000);
    assert.match(JSON.stringify((await inputs(post.delivery!.thread!, "The owner deleted post"))[0]!.model), /delete walk: wrong room/);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${post.id}`, { text: "back" })).status, 400);
    assert.equal((await s.send("DELETE", `/api/c/${ROOM}/posts/${post.id}`)).status, 400);
  });

  test("a channel delete drops the post from the agents' context lines and its reply from the root's count", async () => {
    const ROOT = "ch_cutover";
    const root = await s.send<{ item: Message }>("POST", `/api/c/${ROOT}/send`, { text: "thread root for delete", requestId: "delete-root" });
    const reply = await s.send<{ item: Message }>("POST", `/api/c/${ROOT}/send`, { text: "a reply to delete", requestId: "delete-reply", threadRoot: root.body.item.id });
    const count = async () => ((await s.get<TimelinePage>(`/api/c/${ROOT}/items?limit=200`)).items.find(i => i.id === root.body.item.id) as Message).thread?.replies ?? 0;
    assert.equal(await count(), 1);
    await s.send("DELETE", `/api/c/${ROOT}/posts/${reply.body.item.id}`);
    assert.equal(await count(), 0);
    const row = s.app.groups.row(ROOT)!;
    const next = s.app.agentStore.postsOf(ROOT).find(p => p.id === root.body.item.id)!;
    assert.doesNotMatch(s.app.groups.envelope(row, { ...next, id: "p999", seq: 9999, threadRoot: next.id }), /a reply to delete/);
  });

  test("only the owner's own posts take an edit or a delete, and an edit needs text", async () => {
    const theirs = s.app.agentStore.postsOf(ROOM).find(p => p.author === agents.vent)!;
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${theirs.id}`, { text: "not mine" })).status, 400);
    assert.equal((await s.send("DELETE", `/api/c/${ROOM}/posts/${theirs.id}`)).status, 400);
    const mine = s.app.agentStore.postsOf(ROOM).findLast(p => p.author === "owner" && p.deletedAt === undefined && !p.imported)!;
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${mine.id}`, { text: "  " })).status, 400);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/${mine.id}`, { text: "x", testSend: { by: "a", reason: "b" } })).status, 400);
    assert.equal((await s.send("PATCH", `/api/c/${ROOM}/posts/p999999`, { text: "x" })).status, 404);
  });
});
