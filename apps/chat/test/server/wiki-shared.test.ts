import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomPost } from "../../server/agent-store.ts";
import { sharedIn, sharePattern } from "../../server/wiki/shared.ts";

const post = (room: string, id: string, text: string, at: number, threadRoot?: string): RoomPost =>
  ({ id, seq: Number(id.slice(1)), room, author: "owner", text, images: [], at, requestId: id, ...(threadRoot ? { threadRoot } : {}) }) as RoomPost;

const rooms: Record<string, RoomPost[]> = {
  ch_a: [
    post("ch_a", "p1", "See [the flow](wiki:domains/x/flow.html) for details.", 10),
    post("ch_a", "p2", "Old copy at wiki:domains/x/flow.html.bak, ignore it.", 20),
    post("ch_a", "p3", "Answer in https://box.example:5184/wiki/domains/x/flow.html", 30, "p1"),
  ],
  dm_b: [post("dm_b", "p1", "the folder is wiki:domains/x/ and the [[domains/x/flow.html]] page", 40)],
  ch_test: [post("ch_test", "p1", "wiki:domains/x/flow.html", 50)],
};
const source = { rooms: () => Object.keys(rooms), postsOf: (room: string) => rooms[room] ?? [], isTest: (room: string) => room === "ch_test" };

test("a page is shared by the posts that link it in any link form, newest first, with test rooms left out", () => {
  const shares = sharedIn(source, "domains/x/flow.html");
  assert.deepEqual(shares.map(s => `${s.room}/${s.post}`), ["dm_b/p1", "ch_a/p3", "ch_a/p1"]);
  assert.equal(shares[1]!.threadRoot, "p1");
  assert.equal(shares[2]!.snippet, "See the flow for details.");
});

test("a folder's index page is shared by a link to the folder, and a longer path does not match", () => {
  assert.deepEqual(sharedIn(source, "domains/x/index.html").map(s => `${s.room}/${s.post}`), ["dm_b/p1"]);
  assert.equal(sharePattern("domains/x/flow.html").test("wiki:domains/x/flow.htmlx"), false);
  assert.equal(sharePattern("x/flow.html").test("wiki:domains/x/flow.html"), false);
  assert.deepEqual(sharedIn(source, "  "), []);
});
