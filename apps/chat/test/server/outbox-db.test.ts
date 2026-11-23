import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatDb } from "../../server/chat-db.ts";
import { drained } from "../../server/disk.ts";
import type { Host } from "../../server/host/types.ts";
import { JsonMove } from "../../server/json-move.ts";
import { DbOutboxLog, JsonOutboxLog, OUTBOX, outboxText, replayOutbox } from "../../server/outbox-db.ts";
import { Outbox, type OutboxDeps, type OutboxRow } from "../../server/outbox.ts";

const NOW = Date.now();
const row = (id: string, at: number): OutboxRow => ({
  requestId: id, conversation: "t1:1", text: `send ${id}`, images: [], mentions: [], whenBusy: "steer", at, state: "sending", attempts: 0, deliveries: [],
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** An outbox file as the release before the move wrote it: a compaction, then appended rows, changes, kept sends and finished ids. */
const oldFile = [
  line({ t: "done", requestId: "old", at: NOW - 3600_000 }),
  line({ t: "row", row: row("a", NOW - 50) }),
  line({ t: "row", row: row("b", NOW - 40) }),
  line({ t: "set", requestId: "a", patch: { state: "sent", sentAt: NOW - 30, attempts: 1, error: null } }),
  line({ t: "set", requestId: "b", patch: { attempts: 3, error: "pi-host is away" } }),
  line({ t: "submit", send: { thread: "t2", input: { text: "[board] p1", requestId: "k1" }, at: NOW - 20 } }),
  line({ t: "submit", send: { thread: "t2", input: { text: "[board] p2", requestId: "k2" }, at: NOW - 10 } }),
  line({ t: "done", requestId: "a", at: NOW - 5 }),
  line({ t: "done", requestId: "k1", at: NOW - 4 }),
  line({ t: "set", requestId: "a", patch: { attempts: 9 } }),
  "{\"t\":\"row\",",
].join("");

const deps = (): OutboxDeps => ({
  host: {} as Host, submitted: () => {}, refWritten: async () => true, mentions: async () => [], changed: () => {},
  image: () => undefined, fileNotes: text => text, log: () => {},
});

function boot(data: string, options: { exportDelayMs?: number } = {}) {
  const chat = new ChatDb(join(data, "chat.sqlite"));
  const move = new JsonMove(chat, data, OUTBOX, options);
  const opened = move.open();
  const outbox = new Outbox(new DbOutboxLog(chat, move), deps());
  outbox.stop();
  return { chat, move, opened, outbox };
}

test("a boot imports outbox.jsonl once, and its export is the compaction the release before the move wrote", async () => {
  const data = mkdtempSync(join(tmpdir(), "outbox-db-"));
  writeFileSync(join(data, "outbox.jsonl"), oldFile);
  const { chat, move, opened, outbox } = boot(data);
  assert.deepEqual(opened.imported, ["outbox.jsonl"]);
  assert.equal(opened.records, 5, "row b, kept send k2 and the finished ids old, a and k1");
  const replayed = replayOutbox(oldFile, NOW);
  assert.equal(OUTBOX.dump(chat.db, "outbox.jsonl"), outboxText(replayed));
  assert.deepEqual(outbox.get("b"), replayed.rows.get("b"));
  assert.equal(outbox.get("a"), undefined);
  assert.deepEqual(move.check(), { ...move.check(), json: 5, db: 5 });
  assert.deepEqual(new JsonMove(chat, data, OUTBOX).open().imported, [], "a second boot imports nothing");
  await chat.close();
});

test("each change writes its row, a send waits for its commit, and a reboot reads the same outbox", async () => {
  const data = mkdtempSync(join(tmpdir(), "outbox-db-"));
  writeFileSync(join(data, "outbox.jsonl"), oldFile);
  let { chat, move, outbox } = boot(data, { exportDelayMs: 10 });
  outbox.add({ requestId: "c", conversation: "t1:1", text: "send c", images: [], mentions: [], whenBusy: "steer" });
  await outbox.written();
  assert.equal((chat.db.prepare("SELECT count(*) AS n FROM outbox_rows WHERE request_id = 'c'").get() as { n: number }).n, 1);
  assert.equal(outbox.discard("b"), true);
  assert.deepEqual(outbox.retry("c")?.kind, "message");
  await outbox.written();
  await move.flushExports();
  await drained();
  const file = readFileSync(join(data, "outbox.jsonl"), "utf8");
  const state = replayOutbox(file, NOW);
  assert.deepEqual([...state.rows.keys()], ["c"]);
  assert.deepEqual([...state.kept.keys()], ["k2"]);
  assert.deepEqual([...state.done.keys()], ["old", "a", "k1", "b"]);
  assert.equal(file, outboxText(state), "the export is a compaction, which an older release reads as the same outbox");
  await chat.close();

  ({ chat, outbox } = boot(data));
  assert.deepEqual(outbox.items("t1:1").map(i => i.id), ["r:c"]);
  await chat.close();
});

test("finished ids older than a day go at boot", async () => {
  const data = mkdtempSync(join(tmpdir(), "outbox-db-"));
  writeFileSync(join(data, "outbox.jsonl"), line({ t: "done", requestId: "stale", at: NOW - 25 * 3600_000 }) + line({ t: "done", requestId: "fresh", at: NOW - 60_000 }));
  const { chat, outbox } = boot(data);
  await outbox.written();
  assert.deepEqual((chat.db.prepare("SELECT request_id FROM outbox_done").all() as { request_id: string }[]).map(r => r.request_id), ["fresh"]);
  await chat.close();
});

test("the JSON path and the DB path hold the same outbox after the same changes", async () => {
  const json = mkdtempSync(join(tmpdir(), "outbox-json-"));
  const db = mkdtempSync(join(tmpdir(), "outbox-db-"));
  writeFileSync(join(json, "outbox.jsonl"), oldFile);
  writeFileSync(join(db, "outbox.jsonl"), oldFile);
  const fromFile = new Outbox(new JsonOutboxLog(json), deps());
  fromFile.stop();
  const { chat, outbox: fromDb } = boot(db);
  for (const outbox of [fromFile, fromDb]) {
    outbox.add({ requestId: "c", conversation: "t1:1", text: "send c", images: [], mentions: [], whenBusy: "steer" });
    outbox.add({ requestId: "d", conversation: "t1:1", text: "send d", images: [], mentions: [], whenBusy: "followUp" });
    outbox.discard("b");
    outbox.discard("c");
    await outbox.written();
  }
  await drained();
  const file = replayOutbox(readFileSync(join(json, "outbox.jsonl"), "utf8"), NOW);
  const rows = replayOutbox(OUTBOX.dump(chat.db, "outbox.jsonl")!, NOW);
  assert.deepEqual([...rows.rows.keys()], ["d"]);
  const timeless = (state: typeof rows) => [...state.rows.values()].map(({ at: _at, ...row }) => row);
  assert.deepEqual(timeless(rows), timeless(file));
  assert.deepEqual(rows.kept, file.kept);
  assert.deepEqual([...rows.done.keys()], [...file.done.keys()]);
  await chat.close();
});
