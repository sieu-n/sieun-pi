import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatDb } from "../../server/chat-db.ts";
import { AgentStore, type AgentsFile, type RoomsFile } from "../../server/agent-store.ts";
import { ChatRecords, DbDoc, docKind, docText, movedKinds, readDoc, type DocSpec } from "../../server/chat-records.ts";
import { drained } from "../../server/disk.ts";
import { JsonMove } from "../../server/json-move.ts";
import { AGENTS, CHANNELS, FOR_ME, oldChannelLog, oldChannels, ROOMS, STATE, type ForMeFile } from "../../server/record-kinds.ts";
import { Store, type StateFile } from "../../server/store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "chat-records-"));
/** A records set whose writes commit on the calling thread at each save, as a script's do. */
const KINDS = ["agents", "rooms", "state", "for_me", "channels"];
const records = (data: string) => ChatRecords.standalone(data, KINDS);
/** A records set whose saves wait for a flush, as the server's do. */
function served(data: string): ChatRecords {
  const chat = new ChatDb(join(data, "chat.sqlite"), { offThread: false });
  return new ChatRecords(chat, data, kind => {
    const move = new JsonMove(chat, data, kind);
    move.open();
    return move;
  }, KINDS);
}

/** Files with what the live ones hold that a round trip could lose: a key no type names, numeric keys, a repeated id, nested key order. */
const FILES: Record<string, unknown> = {
  "agents.json": {
    v: 1,
    agents: [
      { id: "ag_a", slug: "a", name: "A", room: "dm_a", workThread: "t1", host: "metal", home: "/h", createdAt: 1, archived: false, comm: { dm_a: "c1" } },
      { id: "ag_b", slug: "b", name: "B ✓", room: "dm_b", workThread: "t2", host: "metal", home: "/h", createdAt: 2, archived: true, test: true },
      { id: "ag_a", slug: "a", name: "A again", room: "dm_a2", workThread: "t3", host: "metal", home: "/h", createdAt: 3, archived: false },
    ],
    aliases: { t9: "ag_a", "42": "ag_b", t8: "ag_a" },
  },
  "rooms.json": {
    v: 1,
    rooms: [
      { id: "dm_a", createdAt: 1, archived: false, kind: "dm", agent: "ag_a" },
      { id: "ch_1", createdAt: 2, archived: false, kind: "channel", name: "dev", purpose: "", members: [{ agent: "ag_a", wakeOn: "all", addedAt: 2 }] },
    ],
    feed: { ag_a: { thread: "c1", entry: 12, open: { x: { text: "hi", entry: 11 } }, turn: { input: 10, channel: false } } },
    commFeed: { c2: { entry: 3, open: {} } },
  },
  "state.json": {
    v: 1, threads: { t3: { kind: "job", parent: "ag_a" } }, dms: { old: true }, reads: { dm_a: { at: 5, seq: 2 }, "7": { at: 1 } },
    sidebarLayout: { sections: [] }, sidebar: {}, archivedJobs: { "t3:2": 9 }, ownerSettings: { status: "away" },
  },
  "for-me.json": { v: 1, since: 100, marks: { ag_a: { "dm_a/p1": { completed: true, at: 101 } }, ag_b: {}, ag_c: { "ch_1/p2": { completed: false, at: 7 } } } },
};
const SPECS = [AGENTS, ROOMS, STATE, FOR_ME] as unknown as DocSpec<object>[];

function writeFiles(data: string): void {
  for (const [file, value] of Object.entries(FILES)) writeFileSync(join(data, file), docText(value));
}

test("a boot imports each file once, and each document renders back to the same bytes", async () => {
  const data = dir();
  writeFiles(data);
  const chat = new ChatDb(join(data, "chat.sqlite"), { offThread: false });
  for (const spec of SPECS) {
    const move = new JsonMove(chat, data, docKind(spec));
    const opened = move.open();
    assert.deepEqual(opened.imported, [spec.file]);
    assert.equal(docKind(spec).dump(chat.db, spec.file), readFileSync(join(data, spec.file), "utf8"), spec.file);
    assert.deepEqual(move.check().items, [], spec.file);
    assert.equal(move.check().json, move.check().db);
    assert.deepEqual(new JsonMove(chat, data, docKind(spec)).open().imported, [], "a second boot imports nothing");
  }
  assert.equal(new JsonMove(chat, data, docKind(AGENTS as unknown as DocSpec<object>)).check().db, 6, "3 agents, one a repeated id, and 3 aliases");
  await chat.close();
});

test("a save writes only the rows that changed, and the DB renders what the old whole-file write wrote", async () => {
  const data = dir();
  writeFiles(data);
  const set = served(data);
  const agents = set.doc(AGENTS) as DbDoc<AgentsFile>;
  const rooms = set.doc(ROOMS) as DbDoc<RoomsFile>;
  const state = set.doc(STATE) as DbDoc<StateFile>;
  const forMe = set.doc(FOR_ME) as DbDoc<ForMeFile>;
  assert.deepEqual(agents.value, FILES["agents.json"]);
  assert.deepEqual(forMe.value, FILES["for-me.json"]);
  assert.equal(agents.changes().length, 0, "an unsaved document writes nothing");
  agents.save();
  assert.deepEqual(agents.changes(), [], "a save with no change writes nothing");

  const steps: [string, () => void, number][] = [
    ["a new agent", () => agents.value.agents.push({ ...agents.value.agents[0]!, id: "ag_new", room: "dm_new" }), 1],
    ["an alias", () => void (agents.value.aliases.t10 = "ag_new"), 1],
    ["a changed agent in the middle", () => void (agents.value.agents[1]!.name = "renamed"), 1],
    ["a removed agent", () => void (agents.value.agents = agents.value.agents.filter(a => a.id !== "ag_b")), 1],
    ["a removed and re-added alias, which moves to the end", () => { delete agents.value.aliases.t9; agents.value.aliases.t9 = "ag_a"; }, 3],
    ["agents in another order", () => void agents.value.agents.reverse(), 3],
  ];
  for (const [what, change, rows] of steps) {
    change();
    agents.save();
    const stmts = agents.changes();
    assert.equal(stmts.length, rows, `${what}: ${stmts.map(stmt => stmt.sql.slice(0, 30)).join(" | ")}`);
    await set.chat.write(stmts);
    assert.equal(docKind(AGENTS as unknown as DocSpec<object>).dump(set.chat.db, "agents.json"), docText(agents.value), what);
  }

  rooms.value.feed.ag_a!.entry = 13;
  rooms.value.commFeed = undefined;
  rooms.save();
  state.value.reads.dm_b = { at: 9 };
  state.value.ownerSettings = { status: "here" } as never;
  state.save();
  (forMe.value.marks.ag_b ??= {})["dm_b/p3"] = { completed: true, at: 3 };
  forMe.value.marks.ag_d = {};
  forMe.save();
  await set.saved();
  for (const doc of [rooms, state, forMe]) {
    const spec = doc.spec as unknown as DocSpec<object>;
    assert.equal(docKind(spec).dump(set.chat.db, spec.file), docText(doc.value), spec.file);
  }
  assert.equal(readDoc(set.chat.db, ROOMS as unknown as DocSpec<object>)!.value.hasOwnProperty("commFeed"), false);

  const again = records(data);
  assert.deepEqual(again.doc(AGENTS).value, agents.value, "a new process reads what the last one saved");
  assert.deepEqual(again.doc(FOR_ME).value, forMe.value);
});

test("the JSON export follows a save, and a boot after it imports nothing", async () => {
  const data = dir();
  writeFiles(data);
  const set = records(data);
  const rooms = set.doc(ROOMS) as DbDoc<RoomsFile>;
  rooms.value.rooms.push({ id: "so_1", createdAt: 3, archived: false, kind: "solo", name: "s", agenda: "", members: [] });
  rooms.save();
  await set.saved();
  await rooms.move.flushExports();
  await drained();
  assert.equal(readFileSync(join(data, "rooms.json"), "utf8"), docText(rooms.value));
  assert.deepEqual(rooms.move.check().items, []);
  assert.deepEqual(records(data).move(docKind(ROOMS as unknown as DocSpec<object>)).open().imported, []);
});

test("a file an older release wrote after a rollback imports again, and the next process reads it", () => {
  const data = dir();
  writeFiles(data);
  records(data).doc(STATE);
  const rolled = { ...(FILES["state.json"] as object), reads: { dm_z: { at: 1, seq: 1 } } };
  writeFileSync(join(data, "state.json"), docText(rolled));
  assert.deepEqual(records(data).doc(STATE).value, rolled);
});

test("a file that does not parse imports nothing and leaves the DB as it was", () => {
  const data = dir();
  writeFiles(data);
  records(data).doc(AGENTS);
  writeFileSync(join(data, "agents.json"), "{\"v\": 1, \"agen");
  assert.deepEqual(records(data).doc(AGENTS).value, FILES["agents.json"]);
});

test("a missing file reads as the empty document, and its first save writes it", async () => {
  const data = dir();
  const set = records(data);
  const doc = set.doc(FOR_ME);
  assert.equal(doc.stored, false);
  doc.value.marks.ag_a = { x: { completed: true, at: 1 } };
  doc.save();
  set.flushSync();
  const read = records(data).doc(FOR_ME);
  assert.equal(read.stored, true);
  assert.deepEqual(read.value, doc.value);
});

test("a kind the server does not keep in chat.sqlite reads and writes its JSON file as before the move, and opens no DB", async () => {
  const data = dir();
  writeFiles(data);
  const set = ChatRecords.standalone(data, []);
  const state = set.doc(STATE);
  assert.equal(state.stored, true);
  assert.deepEqual(state.value, FILES["state.json"]);
  state.value.reads.dm_q = { at: 3 };
  state.save();
  await drained();
  assert.equal(readFileSync(join(data, "state.json"), "utf8"), docText(state.value));
  const forMe = set.doc(FOR_ME);
  forMe.value.marks.ag_q = {};
  forMe.save();
  assert.equal(readFileSync(join(data, "for-me.json"), "utf8"), docText(forMe.value), "for-me.json is written at the save, as before");
  set.flushSync();
  assert.equal(existsSync(join(data, "chat.sqlite")), false);
});

test("the channel files of before phase 5 import as rows and render back to the same bytes", () => {
  const data = dir();
  const channels = { channels: [{ id: "ch_1", name: "dev", members: [] }, { id: "ch_2", name: "ops", members: [] }] };
  const log = `${JSON.stringify({ t: "post", post: { id: "p1", seq: 1 } })}\n${JSON.stringify({ t: "delivery", post: "p1", delivery: {} })}\n`;
  writeFileSync(join(data, "channels.json"), docText(channels));
  mkdirSync(join(data, "channels"));
  writeFileSync(join(data, "channels", "ch_1.jsonl"), log);
  writeFileSync(join(data, "channels", "ch_2.jsonl"), "");
  const set = records(data);
  const move = set.move(CHANNELS);
  assert.deepEqual(move.check().items, []);
  assert.deepEqual({ json: move.check().json, db: move.check().db }, { json: 4, db: 4 });
  assert.equal(CHANNELS.dump(set.chat.db, "channels.json"), docText(channels));
  assert.equal(CHANNELS.dump(set.chat.db, "channels/ch_1.jsonl"), log);
  assert.equal(CHANNELS.dump(set.chat.db, "channels/ch_2.jsonl"), "");
  assert.deepEqual(oldChannels(set.chat.db), channels.channels);
  assert.equal(oldChannelLog(set.chat.db, "ch_1"), log);
  assert.equal(oldChannelLog(set.chat.db, "ch_9"), undefined);
});

test("a process with no APPS_CHAT_DB_KINDS reads each kind a server moved from the rows, after its exports went stale or were archived", async () => {
  const data = dir();
  writeFiles(data);
  assert.deepEqual(movedKinds(data), [], "a dir no server moved holds no kind in chat.sqlite");
  const server = served(data);
  const agents = server.doc(AGENTS);
  const state = server.doc(STATE);
  agents.value.agents.push({ ...agents.value.agents[0]!, id: "ag_after_move" });
  agents.save();
  state.value.reads.dm_after_move = { at: 9 };
  state.save();
  server.flushSync();
  await server.chat.close();
  // The week of exports ended and the boot moved the files into json-archive/ (json-move.ts `archive`); agents.json is left stale instead.
  mkdirSync(join(data, "json-archive"));
  renameSync(join(data, "state.json"), join(data, "json-archive", "state.json"));
  assert.ok(!readFileSync(join(data, "agents.json"), "utf8").includes("ag_after_move"));

  const env = process.env.APPS_CHAT_DB_KINDS;
  delete process.env.APPS_CHAT_DB_KINDS;
  try {
    assert.deepEqual(movedKinds(data), ["agents", "state"]);
    const agentStore = new AgentStore(data);
    assert.ok(agentStore.records.inDb("agents") && !agentStore.records.inDb("rooms"));
    assert.ok(agentStore.agents.agents.some(agent => agent.id === "ag_after_move"), "agents come from the rows, not the stale agents.json");
    assert.deepEqual(agentStore.rooms, FILES["rooms.json"], "rooms, which no server moved, still come from rooms.json");
    assert.deepEqual(new Store(data).state.reads.dm_after_move, { at: 9 }, "state comes from the rows after state.json was archived");
  } finally {
    if (env !== undefined) process.env.APPS_CHAT_DB_KINDS = env;
  }
});
