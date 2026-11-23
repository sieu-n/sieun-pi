import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentStore, type RoomPost } from "../../server/agent-store.ts";
import { ChatRecords } from "../../server/chat-records.ts";
import { ChatDb, openDb } from "../../server/chat-db.ts";
import { drained } from "../../server/disk.ts";
import { JsonMove } from "../../server/json-move.ts";
import { PostLog, POSTS, replayLog } from "../../server/post-log.ts";

const post = (room: string, seq: number, extra: Partial<RoomPost> = {}): RoomPost => ({
  id: `p${seq}`, seq, room, author: "owner", text: `post ${seq}`, images: [], at: 1_000 + seq, requestId: `r${seq}`, ...extra,
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** A log as the release before the move wrote it: post lines, set lines for a delivery, a reaction and an edit, a repeated post line and a torn line. */
const oldLog = (room: string) => [
  line({ t: "post", post: post(room, 1) }),
  line({ t: "post", post: post(room, 2, { author: "ag_vent" }) }),
  line({ t: "set", post: "p1", patch: { delivery: { target: "ag_vent", state: "delivered", attempts: 1, at: 5, requestId: "d:p1:ag_vent" } } }),
  line({ t: "set", post: "p2", patch: { reactions: [{ emoji: "👍", by: "owner", at: 6 }] } }),
  line({ t: "post", post: post(room, 1, { text: "a repeat reads as a no-op" }) }),
  line({ t: "set", post: "p1", patch: { text: "edited", editedAt: 7 } }),
  line({ t: "set", post: "p9", patch: { text: "no such post" } }),
  '{"t":"post","post":{"id":"p3"',
].join("");

function rig() {
  const data = mkdtempSync(join(tmpdir(), "post-log-"));
  mkdirSync(join(data, "rooms"));
  return data;
}

test("a boot imports each room log once, and the rows read back as the log's replay", async () => {
  const data = rig();
  writeFileSync(join(data, "rooms", "dm_vent.jsonl"), oldLog("dm_vent"));
  writeFileSync(join(data, "rooms", "ch_1.jsonl"), line({ t: "post", post: post("ch_1", 1) }));
  const chat = new ChatDb(join(data, "chat.sqlite"));
  const move = new JsonMove(chat, data, POSTS);
  assert.deepEqual(move.open(), { kind: "posts", imported: ["rooms/ch_1.jsonl", "rooms/dm_vent.jsonl"], records: 3, known: 0, archived: [] });
  const log = new PostLog(chat, data, move);
  const replayed = replayLog(oldLog("dm_vent"));
  assert.deepEqual(log.postsOf("dm_vent"), replayed);
  assert.equal(log.postsOf("dm_vent")[0]!.text, "edited");
  assert.deepEqual(Object.keys(log.postsOf("dm_vent")[0]!), Object.keys(replayed[0]!), "keys keep the replay's order");
  assert.deepEqual(log.postsOf("dm_none"), []);
  assert.deepEqual(new JsonMove(chat, data, POSTS).open().imported, [], "a second boot imports nothing");
  const check = move.check();
  assert.equal(check.json, 3);
  assert.equal(check.db, 3);
  assert.deepEqual(check.items.map(i => [i.file, i.state]), [["rooms/dm_vent.jsonl", "behind"]], "a log with set lines exports as post lines");
  await chat.close();
});

test("a new post and a change write the row, a send waits for its commit, and the export reads as the same posts", async () => {
  const data = rig();
  writeFileSync(join(data, "rooms", "dm_vent.jsonl"), oldLog("dm_vent"));
  const chat = new ChatDb(join(data, "chat.sqlite"));
  const move = new JsonMove(chat, data, POSTS, { exportDelayMs: 10 });
  move.open();
  const log = new PostLog(chat, data, move);
  const added = log.add({ room: "dm_vent", author: "owner", text: "new", images: [], at: 9, requestId: "r-new" });
  assert.equal(added.id, "p3");
  added.delivery = { target: "ag_vent", state: "sending", attempts: 0, at: 9, requestId: "d:p3:ag_vent" };
  log.save(added);
  const other = log.add({ room: "ch_new", author: "owner", text: "first", images: [], at: 9, requestId: "r-ch" });
  assert.equal(other.id, "p1");
  await log.written("dm_vent");
  const reader = openDb(join(data, "chat.sqlite"));
  const row = reader.prepare("SELECT ord, seq, body FROM posts WHERE room = ? AND id = ?").get("dm_vent", "p3") as { ord: number; seq: number; body: string };
  assert.deepEqual({ ord: row.ord, seq: row.seq }, { ord: 2, seq: 3 });
  assert.equal(JSON.parse(row.body).delivery.state, "sending");
  reader.close();

  await log.written("ch_new");
  await move.flushExports();
  await drained();
  const exported = readFileSync(join(data, "rooms", "dm_vent.jsonl"), "utf8");
  assert.deepEqual(replayLog(exported), log.postsOf("dm_vent"), "the release before the move reads the export as the same posts");
  assert.equal(exported, log.postsOf("dm_vent").map(p => line({ t: "post", post: p })).join(""));
  assert.deepEqual(replayLog(readFileSync(join(data, "rooms", "ch_new.jsonl"), "utf8")), [other]);
  assert.deepEqual(move.check().items, []);
  await chat.close();

  const again = new ChatDb(join(data, "chat.sqlite"));
  assert.deepEqual(new JsonMove(again, data, POSTS).open().imported, [], "the boot after an export knows the files it wrote");
  assert.deepEqual(new PostLog(again, data).postsOf("dm_vent").map(p => p.id), ["p1", "p2", "p3"]);
  await again.close();
});

test("a log an older release appended to after a rollback imports again, and the room counts on from it", async () => {
  const data = rig();
  writeFileSync(join(data, "rooms", "dm_vent.jsonl"), oldLog("dm_vent"));
  let chat = new ChatDb(join(data, "chat.sqlite"));
  new JsonMove(chat, data, POSTS).open();
  await chat.close();
  appendFileSync(join(data, "rooms", "dm_vent.jsonl"), "\n" + line({ t: "post", post: post("dm_vent", 3) }) + line({ t: "set", post: "p2", patch: { text: "rolled back" } }));
  chat = new ChatDb(join(data, "chat.sqlite"));
  assert.deepEqual(new JsonMove(chat, data, POSTS).open().imported, ["rooms/dm_vent.jsonl"]);
  const log = new PostLog(chat, data);
  assert.deepEqual(log.postsOf("dm_vent").map(p => [p.id, p.text]), [["p1", "edited"], ["p2", "rolled back"], ["p3", "post 3"]]);
  assert.equal(log.add({ room: "dm_vent", author: "owner", text: "after", images: [], at: 10, requestId: "r-after" }).id, "p4");
  await chat.close();
});

test("writes queued at a crash commit at exit, and a replay of them changes nothing", async () => {
  const data = rig();
  const file = join(data, "chat.sqlite");
  const chat = new ChatDb(file);
  new JsonMove(chat, data, POSTS).open();
  const log = new PostLog(chat, data);
  for (let i = 0; i < 200; i++) {
    const p = log.add({ room: "dm_burst", author: "owner", text: `burst ${i}`, images: [], at: i, requestId: `b${i}` });
    p.reactions = [{ emoji: "👀", by: "ag_vent", at: i }];
    log.save(p);
  }
  chat.flushSync();
  const reader = new PostLog(new ChatDb(file, { offThread: false }), data);
  const read = reader.postsOf("dm_burst");
  assert.equal(read.length, 200);
  assert.deepEqual(read, log.postsOf("dm_burst"));
  await chat.close();
});

test("AgentStore keeps posts in the room logs until the server keeps the posts kind in chat.sqlite", async () => {
  const data = rig();
  writeFileSync(join(data, "rooms", "dm_vent.jsonl"), `${oldLog("dm_vent")}\n`);
  const files = new AgentStore(data, ChatRecords.standalone(data, []));
  const { post } = files.append({ room: "dm_vent", author: "owner", text: "to the log", images: [], at: 9, requestId: "r-log" });
  files.set(post, { text: "to the log, edited" });
  await files.written("dm_vent");
  assert.equal(existsSync(join(data, "chat.sqlite")), false, "a store whose kinds all keep their files never opens chat.sqlite");
  assert.deepEqual(replayLog(readFileSync(join(data, "rooms", "dm_vent.jsonl"), "utf8")).map(p => [p.id, p.text]), [["p1", "edited"], ["p2", "post 2"], ["p3", "to the log, edited"]]);

  const rows = new AgentStore(data, ChatRecords.standalone(data, ["posts"]));
  assert.deepEqual(rows.postsOf("dm_vent"), new AgentStore(data, ChatRecords.standalone(data, [])).postsOf("dm_vent"), "the first open imports the log");
  const before = readFileSync(join(data, "rooms", "dm_vent.jsonl"), "utf8");
  const { post: added } = rows.append({ room: "dm_vent", author: "owner", text: "to the rows", images: [], at: 10, requestId: "r-row" });
  rows.set(added, { reactions: [{ emoji: "👍", by: "owner", at: 11 }] });
  assert.deepEqual(new AgentStore(data, ChatRecords.standalone(data, ["posts"])).postsOf("dm_vent").at(-1), added, "a standalone store commits each write before it returns");
  assert.equal(readFileSync(join(data, "rooms", "dm_vent.jsonl"), "utf8"), before, "the log waits for the export");
});
