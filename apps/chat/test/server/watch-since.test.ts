/**
 * A page that comes back on the socket, after a wake or a reload, names the newest post it holds, and the server sends what it missed
 * (app.ts `watch`, rooms.ts and group-rooms.ts `since`). On 11-23 that was only the newer roots, so a kept root missed its new replies and
 * his opens after a reload waited a round trip for the thread pill (work/p278-thread-open/census.md).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/watch-since.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Item, LiveEvent, Sidebar } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

type Items = Extract<LiveEvent, { type: "items" }>;
const QUIET = "quiet: a post no agent answers";
let s: Running;
before(async () => {
  s = await start();
});
after(() => s.close());

const send = async (room: string, text: string, threadRoot?: string): Promise<string> => {
  const sent = await s.send("POST", `/api/c/${room}/send`, { text, requestId: crypto.randomUUID(), ...(threadRoot ? { threadRoot } : {}) });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return (sent.body as { item: Item }).item.id;
};

/** The items the server sends a page that watches `room` holding everything up to `held`, once its status shows it took the watch. */
async function caughtUp(room: string, held: string): Promise<Item[]> {
  const live = await s.live();
  live.watch(room, held);
  await live.waitFor(event => event.type === "status" && event.conversation === room);
  live.close();
  return live.events.filter((event): event is Items => event.type === "items" && event.conversation === room).flatMap(event => event.items);
}

const thread = (items: Item[], id: string) => {
  const found = items.find(item => item.id === id);
  return found?.kind === "message" ? found.thread?.replies : undefined;
};

test("a channel page that comes back gets the reply to an older root with that root's new thread pill", async () => {
  const room = (await s.send("POST", "/api/rooms", { kind: "channel", name: `since-${Date.now()}`, members: [] })).body.id as string;
  const root = await send(room, "the root");
  const newest = await send(room, "the newest root");
  const reply = await send(room, "a reply in the older root's thread", root);
  const items = await caughtUp(room, newest);
  assert.ok(items.some(item => item.id === reply), "the reply came");
  assert.equal(thread(items, root), 1, "the older root came with its pill");
});

test("a DM page that comes back gets the root of a new reply, and one that names no post of the DM gets the newest page", async () => {
  const dm = (await s.get<Sidebar>("/api/sidebar")).dms[0]!.id;
  const root = await send(dm, `${QUIET} root`);
  const newest = await send(dm, `${QUIET} newest`);
  await send(dm, `${QUIET} reply`, root);
  assert.equal(thread(await caughtUp(dm, newest), root), 1);
  const page = await caughtUp(dm, "m:1:added:ag_none");
  assert.ok(page.some(item => item.id === newest), "the newest page came");
});
