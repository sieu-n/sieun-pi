/**
 * The 2 s thread list read (threads.ts `refresh`) holds the event loop only briefly. On 11-21 on us-metal02 it held it 100 to 160 ms every
 * 2 s, and each request that arrived meanwhile waited: a 20 ms read of vent's thread took 260 to 490 ms, and Cmd K searches took 325 to 382 ms
 * at a 200 ms round trip (p156). Three scans made it: a save of rooms.json after every empty feed page, which also bumped the store version
 * and built every summary again, a scan of every alias for each agent's job threads, and a filter of all rooms for each agent's channels.
 * On 11-23 it held it 130 to 200 ms again with 2,091 threads: a scan of the channels by name for each DM room's comm entry, and the summary
 * builds run back to back (p190).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/refresh-stall.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RoomPost } from "../../server/agent-store.ts";
import { isGroupRoom } from "../../server/agent-store.ts";
import { readFeedThread, type FeedSide } from "../../server/rooms.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
  await s.app.threads.refresh();
});
after(async () => {
  await s.close();
});

const side = (room: string): FeedSide => ({
  room, turn: entry => ({ input: entry.id, channel: false }), speaks: () => false, aimedHere: () => false,
  post: () => { throw new Error("this side posts nothing"); },
});

test("a feed read with no new entry saves no rooms file, and one with new entries saves it", async () => {
  const store = s.app.agents.store;
  const record = s.app.agents.list().find(r => s.app.threads.thread(r.workThread))!;
  assert.ok(record, "the fixture holds an agent with a work thread");
  const { entries } = await s.host.entries(record.workThread, { conversation: 1, after: 0, limit: 1000 });
  assert.ok(entries.length > 1, "its work thread holds entries");
  const newest = entries.at(-1)!.id;
  const changed: RoomPost[][] = [];
  const atEnd = { entry: newest, open: {} };
  const version = store.version;
  await readFeedThread(s.host, store, side(record.room), record.workThread, atEnd, posts => changed.push(posts));
  assert.equal(store.version, version, "an empty page leaves rooms.json and the store version alone");
  assert.equal(atEnd.entry, newest);

  const behind = { entry: entries.at(-2)!.id, open: {} };
  await readFeedThread(s.host, store, side(record.room), record.workThread, behind, posts => changed.push(posts));
  assert.equal(behind.entry, newest, "a page with a new entry moves the cursor");
  assert.equal(store.version, version + 1, "and saves rooms.json once");
});

test("each agent's job threads read from the lookup equal a scan of the aliases, and follow a new alias at once", () => {
  const agents = s.app.agents;
  const scan = (id: string, work: string) => Object.entries(agents.store.agents.aliases).filter(([thread, owner]) => owner === id && thread !== work).map(([thread]) => thread);
  for (const record of agents.list()) assert.deepEqual(agents.jobThreads(record), scan(record.id, record.workThread), record.id);
  const record = agents.list()[0]!;
  agents.alias("refresh-stall-job-thread", record.id);
  assert.ok(agents.jobThreads(record).includes("refresh-stall-job-thread"));
  assert.deepEqual(agents.jobThreads(record), scan(record.id, record.workThread));
});

test("the channels and Solo rooms read from the lookup equal a filter of the rooms, and a new room shows at once", async () => {
  const store = s.app.agents.store;
  assert.deepEqual(s.app.groups.rows(), store.rooms.rooms.filter(isGroupRoom));
  const made = await s.send<{ id: string; name: string }>("POST", "/api/rooms", { kind: "channel", name: "refresh-stall", members: [], test: true });
  assert.equal(made.status, 200);
  assert.equal(s.app.groups.row(made.body.id)?.id, made.body.id, "a room made just now reads by id");
  assert.equal(s.app.groups.row("#refresh-stall")?.id, made.body.id, "and by its channel name");
  assert.deepEqual(s.app.groups.rows(), store.rooms.rooms.filter(isGroupRoom));
});

test("the poll after each list read finds each comm thread's room by id, with no scan of the channels for a DM room's entry", () => {
  const store = s.app.agents.store;
  const dmEntries = s.app.agents.list().flatMap(r => Object.keys(r.comm ?? {})).filter(room => !store.groupRoom(room));
  assert.ok(dmEntries.length > 0, "the fixture holds comm entries of rooms that are not channels");
  const groupRooms = store.groupRooms.bind(store);
  let scans = 0;
  store.groupRooms = () => { scans += 1; return groupRooms(); };
  try {
    s.app.groups.poll();
  } finally {
    store.groupRooms = groupRooms;
  }
  assert.equal(scans, 1, "one read of the rooms for the status pass; on 11-23 each of 598 DM entries scanned 216 channels by name");
});
