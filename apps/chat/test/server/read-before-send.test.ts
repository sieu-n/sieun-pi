/**
 * The read-before-send check (server/moved.ts, rooms.ts `speakNow`, `POST /api/threads/:id/speak`): a speaking call whose thread moved
 * since the agent's run last read it posts nothing and gets the new posts, its next call posts at once with the post's id, and the feed's
 * later read of the call's result adds no second post. An agent's edit of a post in a moved thread is held once the same way.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/read-before-send.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { EntryRecord } from "../../server/host/types.ts";
import { movedPosts, readAnswer, readInput, shownIn } from "../../server/moved.ts";
import type { RoomPost } from "../../server/agent-store.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const input = (text: string, at: number, id = 1): EntryRecord => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: at }] });
const post = (id: number, author: string, at: number, extra: Partial<RoomPost> = {}): RoomPost =>
  ({ room: "ch_x", id: `p${id}`, seq: id, author, text: `post ${id}`, images: [], at, requestId: `r${id}`, threadRoot: "p1", ...extra }) as RoomPost;

describe("what an agent's run read", () => {
  test("an input shows its header's post and its thread lines, and an owner edit notice its post", () => {
    const text = "[#dev · post 45 from sieun (owner) · hops 0]\n(a reply in the thread of post 4; your answer goes in that thread)\n\nagree?\n\n(thread so far)\n4 sieun: databases?\n44 fable auditor: one catch\n\n(pinned in this room)\n2 sieun: rules";
    assert.deepEqual(shownIn(input(text, 1)), ["p45", "p4", "p44", "p2"]);
    const mark = readInput(undefined, input("[The owner edited post p9 in your DM. It read \"a\" and now reads as below.]\n\nb", 50));
    assert.deepEqual(mark, { at: 50, seen: ["p9@50"] });
  });

  test("a run's mark starts at its first input, grows with later inputs, and ends with an answer that is no tool round", () => {
    let mark = readInput(undefined, input("[#dev · post 3 from sieun (owner) · hops 0]\n\nhi", 100));
    mark = readAnswer(mark, { role: "assistant", content: [], stopReason: "toolUse", timestamp: 101 } as never)!;
    mark = readInput(mark, input("[#dev · post 5 from devops guy · hops 1]\n\nx", 105));
    assert.deepEqual(mark, { at: 100, seen: ["p3@100", "p5@105"] });
    mark = readAnswer(mark, { role: "assistant", content: [], stopReason: "stop", timestamp: 106 } as never)!;
    assert.equal(mark.ended, true);
    assert.deepEqual(readInput(mark, input("x", 200)), { at: 200, seen: [] });
  });

  test("the thread moved by a post the run never read, and by an edit after the run read its post, in the post's own thread only", () => {
    const mark = { at: 100, seen: ["p5@105", "p6@105"] };
    const posts = [
      post(1, "owner", 10, { threadRoot: undefined, inputs: [{ thread: "t", at: 11 }] }), post(4, "ag_other", 90, { deliveries: [{ target: "ag_me", state: "delivered", thread: "t" }] as never }), post(5, "owner", 104), post(6, "ag_other", 104, { editedAt: 110 }),
      post(7, "ag_me", 111), post(8, "ag_other", 112), post(9, "owner", 113, { threadRoot: "p2" }), post(10, "owner", 114, { inputs: [{ thread: "t", at: 115 }] }),
    ];
    const moved = movedPosts(posts, "ag_me", "t", mark, "p1").map(m => `${m.post.id}${m.edited ? " edited" : ""}`);
    assert.deepEqual(moved, ["p6 edited", "p8"], "p4 reached the agent before the run, p5 was read, p7 is the agent's own, p9 is another thread, p10's input entered");
    assert.deepEqual(movedPosts(posts, "ag_me", "t", { ...mark, ended: true }, "p1"), [], "a run that ended holds nothing");
    const before = [post(1, "owner", 10, { threadRoot: undefined }), post(2, "ag_me", 20), post(3, "ag_other", 30), post(4, "ag_other", 40, { deliveries: [{ target: "ag_me", state: "delivered", thread: "t" }] as never })];
    assert.deepEqual(movedPosts(before, "ag_me", "t", mark, "p1").map(m => m.post.id), ["p3"], "before the run, a post after the agent's own that never reached it");
    assert.deepEqual(movedPosts(posts, "ag_me", "t", undefined, "p1"), [], "a cursor from before the check holds nothing");
  });
});

describe("a speaking call posts while it runs, after the read-before-send check", () => {
  let s: Running;
  const ROOM = "dm_vent";
  const fx = () => s.host as FixtureHost;
  before(async () => {
    s = await start({ wordMs: 1 });
  });
  after(async () => {
    await s.close();
  });
  const speak = (thread: string, call: string) => s.send<{ kind: string; room?: string; id?: string; text?: string }>("POST", `/api/threads/${encodeURIComponent(thread)}/speak`, { call });
  const call = (thread: string, id: string, text: string) => fx().append(fx().threadsById.get(thread)!, 1, {
    kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id, name: "send_message", arguments: { text } }], stopReason: "toolUse", timestamp: Date.now() }],
  } as never);
  const result = (thread: string, id: string, text: string, isError = false) => fx().append(fx().threadsById.get(thread)!, 1, {
    kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "send_message", content: [{ type: "text", text }], isError, timestamp: Date.now() }],
  } as never);

  test("a post the run never read holds the call with that post, and the call after it posts at once with its id and lands once", async () => {
    // A quiet ask lets the fixture's own turn end with no post, so the comm thread exists and its run is over.
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "quiet: speak walk one", requestId: "speak-1" });
    const first = () => s.app.agentStore.postsOf(ROOM).find(p => p.requestId === "speak-1");
    await until(async () => first(), p => p?.delivery?.state === "delivered", 20_000);
    const thread = first()!.delivery!.thread!;
    await until(async () => fx().threadsById.get(thread)!.running.size, n => n === 0, 20_000);

    // The agent's next run: its input, and then a newer owner post that waits in pi-host's inbox while the run writes its answer.
    fx().append(fx().threadsById.get(thread)!, 1, { kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "quiet: speak walk one" }], timestamp: Date.now() }] } as never);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    fx().beforeSubmit = () => gate;
    await new Promise(resolve => setTimeout(resolve, 5));
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "newer: use the staging box instead", requestId: "speak-2" });
    call(thread, "call_old", "the answer on the old ask");
    const held = await speak(thread, "call_old");
    assert.equal(held.status, 200);
    assert.equal(held.body.kind, "held");
    assert.match(held.body.text!, /^Not sent: the thread moved since you last read it\./);
    assert.match(held.body.text!, /newer: use the staging box instead/);
    assert.equal(s.app.agentStore.postsOf(ROOM).some(p => p.requestId === `m:${thread}:call_old`), false, "the held call posts nothing");
    result(thread, "call_old", held.body.text!, true);

    call(thread, "call_new", "the answer that takes the staging box into account");
    const posted = await speak(thread, "call_new");
    assert.equal(posted.body.kind, "posted", posted.body.text);
    const made = s.app.agentStore.postsOf(ROOM).find(p => p.requestId === `m:${thread}:call_new`)!;
    assert.deepEqual([posted.body.room, posted.body.id], [ROOM, made.id]);
    assert.equal(made.author, agents.vent);
    const again = await speak(thread, "call_new");
    assert.deepEqual([again.body.kind, again.body.id], ["posted", made.id], "a rerun after a crash answers the same post");
    const count = s.app.agentStore.postsOf(ROOM).length;
    result(thread, "call_new", `Sent as ${ROOM}/${made.id}.`);
    await s.app.rooms.feed(s.app.agents.record(agents.vent)!);
    assert.equal(s.app.agentStore.postsOf(ROOM).length, count, "the feed's read of the result adds no second post");

    await s.send("POST", `/api/c/${ROOM}/send`, { text: "newest: and drop the Mac", requestId: "speak-3" });
    const edit = (text: string) => s.send<{ text?: string; error?: string }>("POST", `/api/threads/${encodeURIComponent(thread)}/edits`, { message: made.id, text });
    const heldEdit = await edit("the answer, with the staging box and the Mac");
    assert.equal(heldEdit.status, 400);
    assert.match(heldEdit.body.error!, /^Not edited: the thread moved since you last read it\.[\s\S]*newest: and drop the Mac/);
    assert.equal(s.app.agentStore.postsOf(ROOM).find(p => p.id === made.id)!.text, "the answer that takes the staging box into account");
    const resent = await edit("the answer, with the staging box and the Mac");
    assert.equal(resent.status, 200, resent.body.error);

    // A post the run read with read_post (later-agents.ts `read`) counts as read, so the next edit is not held for it.
    await s.send("POST", `/api/c/${ROOM}/send`, { text: "and keep the logs", requestId: "speak-4" });
    const fourth = s.app.agentStore.postsOf(ROOM).find(p => p.requestId === "speak-4")!;
    const read = await s.send<{ text: string }>("GET", `/api/threads/${encodeURIComponent(thread)}/post?message=${fourth.id}`);
    assert.match(read.body.text, new RegExp(`^\\[post ${fourth.seq} \\(${fourth.id}\\) from `, "m"));
    const afterRead = await edit("the answer, with the staging box, the Mac and the logs");
    assert.equal(afterRead.status, 200, afterRead.body.error);
    fx().beforeSubmit = undefined;
    release();
  });

  test("a reply_to that names a post in another room holds the call with a note that says so, and posts nothing", async () => {
    const thread = s.app.agents.roomThread(s.app.agents.record(agents.vent)!);
    fx().append(fx().threadsById.get(thread)!, 1, {
      kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "call_far", name: "send_message", arguments: { text: "answer", reply_to: "ch_elsewhere/p3" } }], stopReason: "toolUse", timestamp: Date.now() }],
    } as never);
    const answer = await speak(thread, "call_far");
    assert.equal(answer.body.kind, "held");
    assert.match(answer.body.text!, /^Not sent: reply_to names ch_elsewhere\/p3, a post in another room, and this call posts only in dm_vent\./);
    assert.equal(s.app.agentStore.postsOf(ROOM).some(p => p.requestId === `m:${thread}:call_far`), false);
  });

  test("a call the feed has not read, or a thread that is no comm thread, answers unknown and leaves the post to the feed", async () => {
    const thread = s.app.agents.roomThread(s.app.agents.record(agents.vent)!);
    assert.equal((await speak(thread, "call_nowhere")).body.kind, "unknown");
    assert.equal((await speak("no-such-thread", "call_x")).body.kind, "unknown");
  });
});
