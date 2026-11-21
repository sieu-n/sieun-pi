/**
 * Forward message (server/forward.ts): the owner forwards a channel or DM post into another room, with words or none, the forward keeps the
 * post as it read then, and the room's agents read the quote under his words.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/forward.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, Principal, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { RoomPost } from "../../server/agent-store.ts";
import { forwardInput, forwardOf, withForward } from "../../server/forward.ts";
import { start, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;

const vent: Principal = { id: "ag_vent", kind: "chat", name: "vent", avatar: { initials: "VE", hue: 20 } };

function post(extra: Partial<RoomPost> = {}): RoomPost {
  return { id: "p7", seq: 7, room: "ch_x", author: "ag_vent", text: "the relay is up\nport 4100", images: [], at: Date.UTC(2026, 10, 21, 3), requestId: "r:7", ...extra };
}

describe("the forward model", () => {
  test("a forward copies the post, and a forward of a bare forward copies the post it quotes", () => {
    assert.throws(() => forwardInput({ room: "ch_x" }), /names its post/);
    const copy = forwardOf(post({ threadRoot: "p3" }), "x", () => vent);
    assert.deepEqual(copy, { room: "ch_x", roomName: "x", post: "p7", threadRoot: "p3", author: vent, text: "the relay is up\nport 4100", images: [], at: post().at });
    assert.equal(forwardOf(post({ id: "p9", text: "", forward: copy }), "y", () => vent), copy);
    assert.notEqual(forwardOf(post({ id: "p9", text: "see this", forward: copy }), "y", () => vent).post, "p7");
    assert.throws(() => forwardOf(post({ deletedAt: 1 }), "x", () => vent), /deleted/);
  });

  test("an agent reads the quote under the owner's words", () => {
    const copy = forwardOf(post(), "x", () => vent);
    assert.equal(withForward("look", undefined), "look");
    assert.equal(
      withForward("look", copy),
      "look\n\n[forwarded post p7 from vent in #x (ch_x), written 2026-11-21T03:00:00.000Z]\n> the relay is up\n> port 4100",
    );
    assert.match(withForward("", { ...copy, room: "dm_vent", roomName: "vent" }), /^\[forwarded post p7 from vent in the DM with vent/);
  });
});

describe("forwards on the fixture server", () => {
  let s: Running;
  const CH = "ch_cutover";
  const items = async (room: string): Promise<Message[]> => (await s.get<TimelinePage>(`/api/c/${room}/items?limit=200`)).items as Message[];
  const send = (room: string, body: unknown) => s.send<{ item: Message; error?: string }>("POST", `/api/c/${room}/send`, body);
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });

  test("a channel post forwards into a DM with no words, and a DM post into a channel with words", async () => {
    const source = s.app.agentStore.postsOf(CH).find(p => !p.threadRoot && p.text.trim())!;
    const toDm = await send("dm_vent", { text: "", requestId: "fwd-1", forward: { room: CH, post: source.id } });
    assert.equal(toDm.status, 200, toDm.body.error);
    assert.equal(toDm.body.item.text, "");
    assert.equal(toDm.body.item.forward?.room, CH);
    assert.equal(toDm.body.item.forward?.roomName, "pi-cutover");
    assert.equal(toDm.body.item.forward?.text, source.text);
    assert.ok((await items("dm_vent")).find(i => i.id === toDm.body.item.id)?.forward, "the timeline reads the forward");

    const toChannel = await send(CH, { text: "for the record", requestId: "fwd-2", forward: { room: "dm_vent", post: toDm.body.item.id } });
    assert.equal(toChannel.status, 200, toChannel.body.error);
    assert.equal(toChannel.body.item.text, "for the record");
    assert.equal(toChannel.body.item.forward?.room, CH, "a bare forward forwards the post it quotes");
    assert.equal(toChannel.body.item.forward?.post, source.id);
  });

  test("a forward of a missing post or a bad ref is refused", async () => {
    assert.equal((await send("dm_vent", { text: "", requestId: "fwd-3", forward: { room: CH, post: "p999999" } })).status, 404);
    assert.equal((await send("dm_vent", { text: "", requestId: "fwd-4", forward: { room: CH } })).status, 400);
    assert.equal((await send("dm_vent", { text: "", requestId: "fwd-5" })).status, 400, "a send with nothing in it is still refused");
  });
});
