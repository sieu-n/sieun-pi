import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyBatches, appliedSeq, ChatDb, openDb } from "../../server/chat-db.ts";
import { drained } from "../../server/disk.ts";
import { JsonMove, type JsonKind } from "../../server/json-move.ts";

type Note = { id: string; text: string };

/** A small kind for the specs: notes.json holds `{ v: 1, notes: [...] }`, written as store.ts writeJson writes it. */
const NOTES: JsonKind = {
  kind: "notes",
  migrations: ["CREATE TABLE notes (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL)"],
  files: dir => (existsSync(join(dir, "notes.json")) ? ["notes.json"] : []),
  load(db, _file, text) {
    const notes = (JSON.parse(text) as { notes: Note[] }).notes;
    db.exec("DELETE FROM notes");
    const insert = db.prepare("INSERT INTO notes (id, ord, body) VALUES (?, ?, ?)");
    notes.forEach((note, i) => insert.run(note.id, i, JSON.stringify(note)));
    return notes.length;
  },
  records: (_file, text) => (JSON.parse(text) as { notes: Note[] }).notes.length,
  count: db => Number((db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n),
  dump(db) {
    const notes = (db.prepare("SELECT body FROM notes ORDER BY ord").all() as { body: string }[]).map(r => JSON.parse(r.body) as Note);
    return `${JSON.stringify({ v: 1, notes }, null, 1)}\n`;
  },
};
const notesFile = (notes: Note[]) => `${JSON.stringify({ v: 1, notes }, null, 1)}\n`;
const addNote = (note: Note, ord: number) => ({ sql: "INSERT INTO notes (id, ord, body) VALUES (?, ?, ?)", params: [note.id, ord, JSON.stringify(note)] });
const ids = (db: DatabaseSync) => (db.prepare("SELECT id FROM notes ORDER BY ord").all() as { id: string }[]).map(r => r.id);
const dir = () => mkdtempSync(join(tmpdir(), "chat-db-"));

test("the writer thread commits writes in order, and a reopened DB counts on from the stored sequence", async () => {
  const data = dir();
  const file = join(data, "chat.sqlite");
  let chat = new ChatDb(file);
  chat.db.exec(NOTES.migrations[0]!);
  const writes = Array.from({ length: 50 }, (_, i) => chat.write([addNote({ id: `n${i}`, text: "x" }, i)]));
  await Promise.all(writes);
  assert.equal(chat.pending, 0);
  assert.deepEqual(ids(chat.db), Array.from({ length: 50 }, (_, i) => `n${i}`));
  assert.equal(appliedSeq(chat.db), 50);
  await chat.close();
  chat = new ChatDb(file);
  await chat.write([addNote({ id: "n50", text: "x" }, 50)]);
  assert.equal(appliedSeq(chat.db), 51);
  await chat.close();
});

test("a write applied twice changes nothing, and a bad statement costs only its own write", () => {
  const db = openDb(join(dir(), "chat.sqlite"));
  db.exec(NOTES.migrations[0]!);
  const batches = [{ seq: 1, stmts: [addNote({ id: "a", text: "" }, 0)] }, { seq: 2, stmts: [{ sql: "INSERT INTO nowhere VALUES (1)" }] }, { seq: 3, stmts: [addNote({ id: "b", text: "" }, 1)] }];
  const failed = applyBatches(db, batches);
  assert.deepEqual(failed.map(f => f.seq), [2]);
  assert.deepEqual(ids(db), ["a", "b"]);
  assert.deepEqual(applyBatches(db, batches), []);
  assert.deepEqual(ids(db), ["a", "b"]);
  assert.equal(appliedSeq(db), 3);
});

test("an exiting process commits its queued writes on its own thread", async () => {
  const file = join(dir(), "chat.sqlite");
  const chat = new ChatDb(file);
  chat.db.exec(NOTES.migrations[0]!);
  void chat.write([addNote({ id: "late", text: "" }, 0)]);
  chat.flushSync();
  assert.equal(chat.pending, 0);
  const other = openDb(file);
  assert.deepEqual(ids(other), ["late"]);
  other.close();
  await chat.close();
});

test("a boot imports each JSON file once, a second boot imports nothing, and the export renders the same bytes", async () => {
  const data = dir();
  const notes = [{ id: "a", text: "one" }, { id: "b", text: "two" }];
  writeFileSync(join(data, "notes.json"), notesFile(notes));
  let chat = new ChatDb(join(data, "chat.sqlite"));
  let move = new JsonMove(chat, data, NOTES);
  assert.deepEqual(move.open(), { kind: "notes", imported: ["notes.json"], records: 2, known: 0, archived: [] });
  assert.equal(NOTES.dump(chat.db, "notes.json"), readFileSync(join(data, "notes.json"), "utf8"));
  assert.deepEqual(move.check().items, []);
  assert.deepEqual(new JsonMove(chat, data, NOTES).open().imported, []);

  await chat.write([addNote({ id: "c", text: "three" }, 2)]);
  move.touch("notes.json");
  assert.deepEqual(move.check().items.map(i => i.state), ["behind"]);
  await move.flushExports();
  await drained();
  assert.equal(readFileSync(join(data, "notes.json"), "utf8"), notesFile([...notes, { id: "c", text: "three" }]));
  assert.deepEqual(move.check(), { ...move.check(), json: 3, db: 3, items: [] });
  await chat.close();

  chat = new ChatDb(join(data, "chat.sqlite"));
  move = new JsonMove(chat, data, NOTES);
  assert.deepEqual(move.open().imported, [], "the boot after an export knows the file it wrote");
  await chat.close();
});

test("a file an older release wrote after a rollback imports again, and a missing file never clears the DB", async () => {
  const data = dir();
  writeFileSync(join(data, "notes.json"), notesFile([{ id: "a", text: "" }]));
  const chat = new ChatDb(join(data, "chat.sqlite"));
  new JsonMove(chat, data, NOTES).open();
  writeFileSync(join(data, "notes.json"), notesFile([{ id: "a", text: "" }, { id: "rollback", text: "" }]));
  const move = new JsonMove(chat, data, NOTES);
  assert.deepEqual(move.check().items.map(i => i.state), ["unknown"]);
  assert.deepEqual(move.open().imported, ["notes.json"]);
  assert.deepEqual(ids(chat.db), ["a", "rollback"]);
  writeFileSync(join(data, "notes.json"), "");
  assert.equal(existsSync(join(data, "notes.json")), true);
  const { rmSync } = await import("node:fs");
  rmSync(join(data, "notes.json"));
  assert.deepEqual(new JsonMove(chat, data, NOTES).open().imported, []);
  assert.deepEqual(ids(chat.db), ["a", "rollback"]);
  await chat.close();
});

test("once the week of exports ended, the files move to json-archive and writes no longer export", async () => {
  const data = dir();
  writeFileSync(join(data, "notes.json"), notesFile([{ id: "a", text: "" }]));
  const chat = new ChatDb(join(data, "chat.sqlite"));
  let now = Date.parse("2026-11-24T00:00:00Z");
  new JsonMove(chat, data, NOTES, { now: () => now }).open();
  now += 8 * 86_400_000;
  const move = new JsonMove(chat, data, NOTES, { now: () => now });
  assert.deepEqual(move.open().archived, ["notes.json"]);
  assert.equal(existsSync(join(data, "notes.json")), false);
  assert.equal(existsSync(join(data, "json-archive", "notes", "notes.json")), true);
  await chat.write([addNote({ id: "b", text: "" }, 1)]);
  move.touch("notes.json");
  await move.flushExports();
  assert.equal(existsSync(join(data, "notes.json")), false);
  assert.deepEqual(await move.apply(), { kind: "notes", dryRun: false, exported: [], archived: [], left: [] });
  await chat.close();
});
