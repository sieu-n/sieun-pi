/**
 * The chat server's JSON documents as rows of chat.sqlite (chat-db.ts): agents.json, rooms.json, state.json and for-me.json, each one
 * object whose big parts are collections, such as the agents list or the read marks by conversation. Each collection entry is one row,
 * keyed by its id, with an `ord` for its place and its JSON as the code holds it in `body`, so no field is ever dropped. The rest of the
 * object, such as `v` or the sidebar layout, is the document's own row in `<kind>_doc`, with each collection's key kept in its place.
 *
 * Each store keeps its document in memory and reads it there, as it did with the files; `Doc.value` is that object, and code changes it in
 * place and calls `save`, as before. A save writes only the rows whose entry changed, found by comparing each entry's JSON with the last
 * one written; that is one `JSON.stringify` per entry, as the whole-file write it replaces did. Saves in one burst cost one compare.
 * A save's rows go to the DB once the disk queue (disk.ts) wrote what was queued before it, as rooms.json did in that queue, so a feed
 * cursor never lands before the posts it read while the post logs are files.
 *
 * `readDoc` renders a document back to the same object, so the JSON export `JsonMove` writes for a week after the move is the file the
 * release before the move wrote, byte for byte.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ChatDb, type Stmt } from "./chat-db.ts";
import { drained, writeJsonLater } from "./disk.ts";
import { JsonMove, type JsonKind } from "./json-move.ts";
import { readJson, writeJson } from "./store.ts";

/** Columns a collection's rows carry beside their key, for queries by hand, each worked out from the entry. */
export type Columns = Readonly<Record<string, (value: unknown) => SQLInputValue>>;

/**
 * One part of a document that gets a row per entry. `list` is an array of records with an id, where a repeated id keys its later items as
 * `<id>#2`, `<id>#3`; `map` is an object of entries by key; `map2` is an object of such objects, as for-me.json's marks by agent and item.
 */
export type Collection =
  | { key: string; table: string; shape: "list"; column: string; id: (item: unknown) => string; columns?: Columns }
  | { key: string; table: string; shape: "map"; column: string; columns?: Columns }
  | { key: string; table: string; shape: "map2"; column: string; inner: string };

/** One JSON file as rows: the kind it moves as, its path in the data dir, its collections and the object a missing file reads as. */
export interface DocSpec<T extends object> {
  kind: string;
  file: string;
  collections: readonly Collection[];
  empty: () => T;
  /** While the kind is not in chat.sqlite: the file is written at each save on the calling thread, as for-me.json was, not through the disk queue. */
  syncJson?: true;
}

/** One row of a collection: its key (two parts in a `map2`, whose outer row has an empty inner key), its place, the entry and its JSON. */
type Row = { table: string; k1: string; k2?: string; o1: number; o2: number; item: unknown; body: string | null };
/**
 * A collection's rows in order, as parallel lists: the keys (`k2` only in a `map2`), the places, the entries and their JSON. `kept` says
 * the keys are the ones the last save had, in the same order, so each row kept its place and only its JSON can differ.
 */
type Part = { table: string; k1: string[]; k2: string[] | null; o1: number[]; o2: number[]; items: unknown[]; bodies: (string | null)[]; kept: boolean };
type Flat = { parts: Map<string, Part>; doc: string; expanded: string };

const rowKey = (part: Part, i: number): string => (part.k2 ? `${part.k1[i]}\u0000${part.k2[i]}` : part.k1[i]!);
const rowAt = (part: Part, i: number): Row => ({
  table: part.table, k1: part.k1[i]!, ...(part.k2 ? { k2: part.k2[i]! } : {}), o1: part.o1[i]!, o2: part.o2[i]!, item: part.items[i], body: part.bodies[i]!,
});
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const docTable = (kind: string): string => `${kind}_doc`;
const sameList = (a: readonly string[] | null | undefined, b: readonly string[] | null): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * Each row's place: the place it had when every kept row still comes in the same order and every new row comes after them, which an
 * append, a new map key or a removal leaves, so those write only their own rows; otherwise 0, 1, 2 ... again.
 */
function places(had: readonly (number | undefined)[]): number[] {
  let last = -1;
  let fresh = false;
  for (const at of had) {
    if (at === undefined) fresh = true;
    else if (fresh || at <= last) return had.map((_, i) => i);
    else last = at;
  }
  return had.map(at => at ?? ++last);
}

function expands(collection: Collection, value: unknown): boolean {
  if (collection.shape === "list") return Array.isArray(value);
  if (!isPlain(value)) return false;
  return collection.shape === "map" || Object.values(value).every(isPlain);
}

/** A map's keys, entries and their JSON, without the keys whose value JSON leaves out, such as undefined, which the file never holds. */
function entries(map: Record<string, unknown>, keys: string[], items: unknown[], bodies: (string | null)[]): void {
  for (const key of Object.keys(map)) {
    const body = JSON.stringify(map[key]) as string | undefined;
    if (body === undefined) continue;
    keys.push(key);
    items.push(map[key]);
    bodies.push(body);
  }
}

/** A collection's rows in order, before their places. */
function rowsOf(collection: Collection, part: unknown): Omit<Part, "o1" | "o2" | "kept"> {
  const k1: string[] = [];
  const items: unknown[] = [];
  const bodies: (string | null)[] = [];
  const { table } = collection;
  if (collection.shape === "list") {
    const seen = new Map<string, number>();
    for (const item of part as unknown[]) {
      const id = collection.id(item);
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      k1.push(n === 1 ? id : `${id}#${n}`);
      items.push(item);
      bodies.push(JSON.stringify(item) ?? "null");
    }
    return { table, k1, k2: null, items, bodies };
  }
  if (collection.shape === "map") {
    entries(part as Record<string, unknown>, k1, items, bodies);
    return { table, k1, k2: null, items, bodies };
  }
  // Each outer key has a row of its own with an empty inner key and no body, so an outer key with no entries keeps its place too.
  const k2: string[] = [];
  const outer = part as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(outer)) {
    k1.push(key);
    k2.push("");
    items.push(null);
    bodies.push(null);
    const from = k1.length;
    entries(outer[key]!, k2, items, bodies);
    for (let i = from; i < k2.length; i++) k1.push(key);
  }
  return { table, k1, k2, items, bodies };
}

/** The places of `rows`, kept from `old` where they can be: an outer key's place in a `map2`, and each inner key's place under it. */
function placed(rows: Omit<Part, "o1" | "o2" | "kept">, old: Part | undefined): Part {
  if (old && sameList(old.k1, rows.k1) && sameList(old.k2, rows.k2)) return { ...rows, o1: old.o1, o2: old.o2, kept: true };
  const had = new Map<string, number>();
  if (old) for (let i = 0; i < old.k1.length; i++) had.set(rowKey(old, i), i);
  const at = (key: string) => had.get(key);
  if (!rows.k2) {
    const o1 = places(rows.k1.map(key => (at(key) === undefined ? undefined : old!.o1[at(key)!])));
    return { ...rows, o1, o2: rows.k1.map(() => 0), kept: false };
  }
  const o1: number[] = [];
  const o2: number[] = [];
  const outer = rows.k1.flatMap((key, i) => (rows.k2![i] === "" ? [i] : []));
  const outerPlaces = places(outer.map(i => { const j = at(`${rows.k1[i]}\u0000`); return j === undefined ? undefined : old!.o1[j]; }));
  outer.forEach((start, n) => {
    const end = outer[n + 1] ?? rows.k1.length;
    const inner = places(rows.k2!.slice(start + 1, end).map((k, i) => { const j = at(`${rows.k1[start + 1 + i]}\u0000${k}`); return j === undefined ? undefined : old!.o2[j]; }));
    o1.push(outerPlaces[n]!);
    o2.push(0);
    for (const place of inner) {
      o1.push(outerPlaces[n]!);
      o2.push(place);
    }
  });
  return { ...rows, o1, o2, kept: false };
}

/** `value`'s rows, keeping the places `old` gave the rows it still has. One `JSON.stringify` per entry is the cost of a save. */
function flatten(spec: DocSpec<object>, value: object, old: Flat | null): Flat {
  const parts = new Map<string, Part>();
  const top = value as Record<string, unknown>;
  const expanded: string[] = [];
  for (const collection of spec.collections) {
    const part = top[collection.key];
    if (!expands(collection, part)) continue;
    expanded.push(collection.key);
    parts.set(collection.table, placed(rowsOf(collection, part), old?.parts.get(collection.table)));
  }
  const doc = JSON.stringify(Object.fromEntries(Object.entries(top).map(([key, part]) => [key, expanded.includes(key) ? null : part])));
  return { parts, doc, expanded: JSON.stringify(expanded) };
}

/** The statements that take the rows of `old` to the rows of `next`. */
function diff(spec: DocSpec<object>, old: Flat | null, next: Flat): Stmt[] {
  const stmts: Stmt[] = [];
  if (next.doc !== old?.doc || next.expanded !== old?.expanded) stmts.push(saveDoc(spec, next));
  for (const [table, part] of next.parts) {
    const was = old?.parts.get(table);
    if (part.kept) {
      for (let i = 0; i < part.bodies.length; i++) if (part.bodies[i] !== was!.bodies[i]) stmts.push(upsert(spec, rowAt(part, i)));
      continue;
    }
    const had = new Map<string, number>();
    if (was) for (let i = 0; i < was.k1.length; i++) had.set(rowKey(was, i), i);
    for (let i = 0; i < part.k1.length; i++) {
      const j = had.get(rowKey(part, i));
      if (j !== undefined) had.delete(rowKey(part, i));
      if (j === undefined || was!.bodies[j] !== part.bodies[i] || was!.o1[j] !== part.o1[i] || was!.o2[j] !== part.o2[i]) stmts.push(upsert(spec, rowAt(part, i)));
    }
    for (const j of had.values()) stmts.push(remove(spec, rowAt(was!, j)));
  }
  // A collection the document no longer expands, such as one set to null, loses every row it had.
  for (const [table, was] of old?.parts ?? []) if (!next.parts.has(table)) for (let j = 0; j < was.k1.length; j++) stmts.push(remove(spec, rowAt(was, j)));
  return stmts;
}

const recordsIn = (flat: Flat): number => [...flat.parts.values()].reduce((n, part) => n + part.bodies.filter(body => body !== null).length, 0);

/** The SQL that writes `row`, replacing the row with its key. */
function upsert(spec: DocSpec<object>, row: Row): Stmt {
  const collection = spec.collections.find(c => c.table === row.table)!;
  if (collection.shape === "map2") {
    return {
      sql: `INSERT INTO ${row.table} (${collection.column}, ${collection.inner}, outer_ord, ord, body) VALUES (?, ?, ?, ?, ?) ` +
        `ON CONFLICT (${collection.column}, ${collection.inner}) DO UPDATE SET outer_ord = excluded.outer_ord, ord = excluded.ord, body = excluded.body`,
      params: [row.k1, row.k2!, row.o1, row.o2, row.body],
    };
  }
  const columns = collection.columns ?? {};
  const names = Object.keys(columns);
  return {
    sql: `INSERT INTO ${row.table} (${[collection.column, "ord", ...names, "body"].join(", ")}) VALUES (${["?", "?", ...names.map(() => "?"), "?"].join(", ")}) ` +
      `ON CONFLICT (${collection.column}) DO UPDATE SET ${["ord", ...names, "body"].map(n => `${n} = excluded.${n}`).join(", ")}`,
    params: [row.k1, row.o1, ...names.map(name => columns[name]!(row.item) ?? null), row.body],
  };
}

function remove(spec: DocSpec<object>, row: Row): Stmt {
  const collection = spec.collections.find(c => c.table === row.table)!;
  return collection.shape === "map2"
    ? { sql: `DELETE FROM ${row.table} WHERE ${collection.column} = ? AND ${collection.inner} = ?`, params: [row.k1, row.k2!] }
    : { sql: `DELETE FROM ${row.table} WHERE ${collection.column} = ?`, params: [row.k1] };
}

const saveDoc = (spec: DocSpec<object>, flat: Flat): Stmt => ({
  sql: `INSERT INTO ${docTable(spec.kind)} (file, body, expanded) VALUES (?, ?, ?) ON CONFLICT (file) DO UPDATE SET body = excluded.body, expanded = excluded.expanded`,
  params: [spec.file, flat.doc, flat.expanded],
});

/** The tables of a document's kind, as one migration step. */
export function docTables(spec: DocSpec<object>): string {
  return [
    `CREATE TABLE ${docTable(spec.kind)} (file TEXT PRIMARY KEY, body TEXT NOT NULL, expanded TEXT NOT NULL)`,
    ...spec.collections.map(c => {
      if (c.shape === "map2") {
        return `CREATE TABLE ${c.table} (${c.column} TEXT NOT NULL, ${c.inner} TEXT NOT NULL, outer_ord INTEGER NOT NULL, ord INTEGER NOT NULL, body TEXT, ` +
          `PRIMARY KEY (${c.column}, ${c.inner}))`;
      }
      const extra = Object.keys(c.columns ?? {}).map(name => `, ${name}`).join("");
      return `CREATE TABLE ${c.table} (${c.column} TEXT PRIMARY KEY, ord INTEGER NOT NULL${extra}, body TEXT NOT NULL)`;
    }),
  ].join(";\n");
}

/** The document as the DB holds it, with its rows in order, or null when the DB holds none of it. */
export function readDoc(db: DatabaseSync, spec: DocSpec<object>): { value: object; flat: Flat } | null {
  const doc = db.prepare(`SELECT body, expanded FROM ${docTable(spec.kind)} WHERE file = ?`).get(spec.file) as { body: string; expanded: string } | undefined;
  if (!doc) return null;
  const value = JSON.parse(doc.body) as Record<string, unknown>;
  const expanded = JSON.parse(doc.expanded) as string[];
  const parts = new Map<string, Part>();
  for (const c of spec.collections) {
    if (!expanded.includes(c.key)) continue;
    const map2 = c.shape === "map2";
    const rows = db.prepare(map2
      ? `SELECT ${c.column} AS k, ${c.inner} AS i, outer_ord AS o, ord AS o2, body FROM ${c.table} ORDER BY outer_ord, ord`
      : `SELECT ${c.column} AS k, ord AS o, 0 AS o2, body FROM ${c.table} ORDER BY o`).all() as { k: string; i?: string; o: number; o2: number; body: string | null }[];
    const items = rows.map(row => (row.body === null ? null : JSON.parse(row.body)));
    parts.set(c.table, {
      table: c.table, k1: rows.map(row => row.k), k2: map2 ? rows.map(row => row.i!) : null, o1: rows.map(row => Number(row.o)), o2: rows.map(row => Number(row.o2)),
      items, bodies: rows.map(row => row.body), kept: false,
    });
    if (c.shape === "list") value[c.key] = items;
    else if (c.shape === "map") value[c.key] = Object.fromEntries(rows.map((row, i) => [row.k, items[i]]));
    else {
      const out: [string, [string, unknown][]][] = [];
      rows.forEach((row, i) => (row.body === null ? out.push([row.k, []]) : out.at(-1)![1].push([row.i!, items[i]])));
      value[c.key] = Object.fromEntries(out.map(([k, inner]) => [k, Object.fromEntries(inner)]));
    }
  }
  return { value, flat: { parts, doc: doc.body, expanded: doc.expanded } };
}

/** The file's text, as `writeJson` and `writeJsonLater` write it. */
export const docText = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** Replaces every row of the document with the rows of `value`, inside the caller's transaction, and answers how many records it holds. */
function replaceDoc(db: DatabaseSync, spec: DocSpec<object>, value: object): number {
  const flat = flatten(spec, value, null);
  for (const c of spec.collections) db.exec(`DELETE FROM ${c.table}`);
  const run = (stmt: Stmt) => db.prepare(stmt.sql).run(...(stmt.params ?? []));
  run(saveDoc(spec, flat));
  for (const part of flat.parts.values()) for (let i = 0; i < part.k1.length; i++) run(upsert(spec, rowAt(part, i)));
  return recordsIn(flat);
}

/** How many records a document's file holds: its collections' entries; a file that does not parse holds none. */
export function docRecords(spec: DocSpec<object>, text: string): number {
  const value = parse(text);
  return value ? recordsIn(flatten(spec, value, null)) : 0;
}

function parse(text: string): object | null {
  try {
    const value = JSON.parse(text) as unknown;
    return isPlain(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The `JsonKind` of a document, which `JsonMove` imports once and exports for a week. A file that does not parse imports no records and
 * leaves the DB as it was; the release before the move read such a file as empty.
 */
export function docKind(spec: DocSpec<object>): JsonKind {
  return {
    kind: spec.kind,
    migrations: [docTables(spec)],
    files: dir => (existsFile(join(dir, spec.file)) ? [spec.file] : []),
    load(db, _file, text) {
      const value = parse(text);
      return value ? replaceDoc(db, spec, value) : 0;
    },
    records: (_file, text) => docRecords(spec, text),
    count: db => spec.collections.reduce((n, c) =>
      n + Number((db.prepare(`SELECT count(*) AS n FROM ${c.table}${c.shape === "map2" ? " WHERE body IS NOT NULL" : ""}`).get() as { n: number }).n), 0),
    dump(db) {
      const doc = readDoc(db, spec);
      return doc ? docText(doc.value) : null;
    },
  };
}

const existsFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

/** One document a store holds in memory: `value` is read and changed in place, then `save` keeps it. */
export interface Doc<T extends object> {
  value: T;
  /** Whether the document was kept before, so `value` is not `spec.empty()`. */
  readonly stored: boolean;
  save(): void;
}

/** A document of a kind the server does not keep in chat.sqlite (`Config.dbKinds`): its JSON file, read and written as before the move. */
class JsonDoc<T extends object> implements Doc<T> {
  value: T;
  readonly stored: boolean;

  constructor(private readonly path: string, private readonly spec: DocSpec<T>) {
    const read = readJson<T | undefined>(path, undefined);
    this.value = read ?? spec.empty();
    this.stored = read !== undefined;
  }

  save(): void {
    if (this.spec.syncJson) writeJson(this.path, this.value);
    else writeJsonLater(this.path, this.value);
  }
}

/** A document of a kind kept in chat.sqlite, as rows. */
export class DbDoc<T extends object> implements Doc<T> {
  /** The document; code reads and changes it in place, then calls `save`. */
  value: T;
  readonly move: JsonMove;
  /** Whether the DB held the document when it was opened, so `value` is not `spec.empty()`. */
  readonly stored: boolean;
  private last: Flat | null = null;
  private dirty = false;
  private readonly records: ChatRecords;

  constructor(records: ChatRecords, readonly spec: DocSpec<T>) {
    this.records = records;
    this.move = records.move(docKind(spec as DocSpec<object>));
    const stored = readDoc(records.chat.db, spec as DocSpec<object>);
    this.value = (stored?.value as T | undefined) ?? spec.empty();
    this.stored = stored !== null;
    if (stored) this.last = stored.flat;
  }

  /** Says the document changed; its changed rows go to the DB with the next flush. */
  save(): void {
    this.dirty = true;
    this.records.schedule();
  }

  /** The statements that bring the DB to the document as it is now, and nothing when it did not change since the last ones. */
  changes(): Stmt[] {
    if (!this.dirty) return [];
    this.dirty = false;
    const spec = this.spec as DocSpec<object>;
    const next = flatten(spec, this.value, this.last);
    const stmts = diff(spec, this.last, next);
    this.last = next;
    return stmts;
  }
}

/**
 * The kinds the chat.sqlite of `dataDir` holds: each `db_kinds` row whose first import a server stamped (json-move.ts `open`). From then on
 * the rows are the records and the JSON files are exports that stop after a week, so a process with no server reads these kinds from the
 * rows whatever its env says. A dir with no chat.sqlite, or none with a `db_kinds` table, holds none.
 */
export function movedKinds(dataDir: string): string[] {
  const file = join(dataDir, "chat.sqlite");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT kind FROM db_kinds WHERE imported_at IS NOT NULL ORDER BY kind").all() as { kind: string }[]).map(row => row.kind);
  } catch (error) {
    if (/no such table: db_kinds/.test(String((error as Error).message))) return [];
    throw error;
  } finally {
    db.close();
  }
}

/** The chat.sqlite connection, the data dir, the kinds kept in chat.sqlite and the moves the documents of one process share. */
export class ChatRecords {
  private readonly docs: DbDoc<object>[] = [];
  private readonly moves = new Map<string, JsonMove>();
  private queued = false;
  private connection: ChatDb | null;
  readonly kinds: ReadonlySet<string>;

  /**
   * `kinds`: the kinds kept in chat.sqlite (`Config.dbKinds`); every other kind keeps its JSON file. `syncSaves`: each save commits before
   * it returns, as a script's or spec's must, since the next store it opens on the same dir reads the DB; a write of the old files was read
   * back the same way through the disk queue (disk.ts `readLatest`).
   */
  constructor(chat: ChatDb | (() => ChatDb), readonly dataDir: string, private readonly open: (kind: JsonKind) => JsonMove, kinds: Iterable<string>, readonly syncSaves = false) {
    this.connection = typeof chat === "function" ? null : chat;
    this.connect = typeof chat === "function" ? chat : () => chat;
    this.kinds = new Set(kinds);
  }
  private readonly connect: () => ChatDb;

  /** The chat.sqlite connection, opened on first use, so a script whose kinds all keep their files never opens it. */
  get chat(): ChatDb {
    return (this.connection ??= this.connect());
  }

  /**
   * For a script or spec with no App: the kinds a server already moved into the dir's chat.sqlite (`movedKinds`), so a duty script run by
   * hand or a job's shell with no APPS_CHAT_DB_KINDS reads the rows, never the stale or archived exports; and its own connection, which
   * commits each save on the calling thread at once, and its own moves.
   */
  static standalone(dataDir: string, kinds: Iterable<string> = movedKinds(dataDir)): ChatRecords {
    let chat: ChatDb | undefined;
    const connect = () => (chat ??= new ChatDb(join(dataDir, "chat.sqlite"), { offThread: false }));
    const open = (kind: JsonKind) => {
      const move = new JsonMove(connect(), dataDir, kind);
      move.open();
      return move;
    };
    return new ChatRecords(connect, dataDir, open, kinds, true);
  }

  /** Whether the server keeps `kind` in chat.sqlite. */
  inDb(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /** The kind's move, opened on the first call: its tables, then the import of each of its files the DB has not seen. */
  move(kind: JsonKind): JsonMove {
    let move = this.moves.get(kind.kind);
    if (!move) this.moves.set(kind.kind, (move = this.open(kind)));
    return move;
  }

  /** The document of `spec`: rows of chat.sqlite when its kind is kept there, else its JSON file as before the move. */
  doc<T extends object>(spec: DocSpec<T>): Doc<T> {
    if (!this.inDb(spec.kind)) return new JsonDoc(join(this.dataDir, spec.file), spec);
    const doc = new DbDoc(this, spec);
    this.docs.push(doc as unknown as DbDoc<object>);
    return doc;
  }

  /** Flushes once the disk queue wrote what was queued before the save, or at once for a script. */
  schedule(): void {
    if (this.syncSaves) return this.flushSync();
    if (this.queued) return;
    this.queued = true;
    // The compare runs after the turn that saved, so a route's answer never waits for it.
    void drained().then(() => setImmediate(() => {
      this.queued = false;
      this.flush();
    }));
  }

  /** Queues each changed document's rows and its JSON export now. */
  flush(): void {
    for (const doc of this.docs) {
      const stmts = doc.changes();
      if (!stmts.length) continue;
      void this.chat.write(stmts, `${doc.spec.kind} save`);
      doc.move.touch(doc.spec.file);
    }
  }

  /** Settles once every save so far is committed. */
  async saved(): Promise<void> {
    this.flush();
    if (this.connection) await this.connection.written();
  }

  /** Commits every save on this thread, for a process that is exiting or a script that is done. */
  flushSync(): void {
    this.flush();
    this.connection?.flushSync();
  }
}
