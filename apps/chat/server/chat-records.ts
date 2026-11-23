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
import { statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ChatDb, type Stmt } from "./chat-db.ts";
import { drained } from "./disk.ts";
import { JsonMove, type JsonKind } from "./json-move.ts";

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
}

/** One row of a collection: its key parts, its place (two parts in a `map2`), its extra columns and its body. */
type Row = { table: string; keys: string[]; ords: number[]; extra: SQLInputValue[]; body: string | null };
type Flat = { rows: Map<string, Row & { text: string }>; doc: string; expanded: string };

const rowId = (table: string, keys: readonly string[]): string => [table, ...keys].join("\u0000");
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const docTable = (kind: string): string => `${kind}_doc`;

/**
 * Each key's place: the place its row had when every kept key still comes in the same order and every new key comes after them, which an
 * append, a new map key or a removal leaves, so those write only their own rows; otherwise 0, 1, 2 ... again.
 */
function places(keys: readonly string[], old: (key: string) => number | undefined): number[] {
  let last = -1;
  let fresh = false;
  for (const key of keys) {
    const at = old(key);
    if (at === undefined) fresh = true;
    else if (fresh || at <= last) return keys.map((_, i) => i);
    else last = at;
  }
  return keys.map(key => old(key) ?? ++last);
}

function expands(collection: Collection, value: unknown): boolean {
  if (collection.shape === "list") return Array.isArray(value);
  if (!isPlain(value)) return false;
  return collection.shape === "map" || Object.values(value).every(isPlain);
}

/** A map's entries as JSON, without the keys whose value JSON leaves out. */
const entries = (value: Record<string, unknown>): [string, string][] =>
  Object.entries(value).flatMap(([key, item]) => {
    const body = JSON.stringify(item) as string | undefined;
    return body === undefined ? [] : [[key, body] as [string, string]];
  });

/** `value`'s rows, keeping the places `old` gave the rows it still has. */
function flatten(spec: DocSpec<object>, value: object, old: ReadonlyMap<string, { ords: number[] }>): Flat {
  const rows = new Map<string, Row & { text: string }>();
  const add = (row: Row) => rows.set(rowId(row.table, row.keys), { ...row, text: JSON.stringify([row.ords, row.extra, row.body]) });
  const top = value as Record<string, unknown>;
  const expanded: string[] = [];
  for (const collection of spec.collections) {
    const part = top[collection.key];
    if (!expands(collection, part)) continue;
    expanded.push(collection.key);
    const { table } = collection;
    const extra = (item: unknown) => Object.values(collection.shape === "map2" ? {} : collection.columns ?? {}).map(column => column(item) ?? null);
    if (collection.shape === "list") {
      const seen = new Map<string, number>();
      const items = (part as unknown[]).map(item => {
        const id = collection.id(item);
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        return { key: n === 1 ? id : `${id}#${n}`, item, body: JSON.stringify(item) ?? "null" };
      });
      const ords = places(items.map(i => i.key), key => old.get(rowId(table, [key]))?.ords[0]);
      items.forEach((i, n) => add({ table, keys: [i.key], ords: [ords[n]!], extra: extra(i.item), body: i.body }));
    } else if (collection.shape === "map") {
      const list = entries(part as Record<string, unknown>);
      const ords = places(list.map(([key]) => key), key => old.get(rowId(table, [key]))?.ords[0]);
      list.forEach(([key, body], n) => add({ table, keys: [key], ords: [ords[n]!], extra: extra((part as Record<string, unknown>)[key]), body }));
    } else {
      // Each outer key has a row of its own with an empty inner key and no body, so an outer key with no entries keeps its place too.
      const outer = Object.entries(part as Record<string, Record<string, unknown>>);
      const ords = places(outer.map(([key]) => key), key => old.get(rowId(table, [key, ""]))?.ords[0]);
      outer.forEach(([key, inner], n) => {
        add({ table, keys: [key, ""], ords: [ords[n]!, 0], extra: [], body: null });
        const list = entries(inner);
        const innerOrds = places(list.map(([k]) => k), k => old.get(rowId(table, [key, k]))?.ords[1]);
        list.forEach(([k, body], i) => add({ table, keys: [key, k], ords: [ords[n]!, innerOrds[i]!], extra: [], body }));
      });
    }
  }
  const doc = JSON.stringify(Object.fromEntries(Object.entries(top).map(([key, part]) => [key, expanded.includes(key) ? null : part])));
  return { rows, doc, expanded: JSON.stringify(expanded) };
}

const recordsIn = (flat: Flat): number => [...flat.rows.values()].filter(row => row.body !== null).length;

/** The SQL that writes `row`, replacing the row with its key. */
function upsert(spec: DocSpec<object>, row: Row): Stmt {
  const collection = spec.collections.find(c => c.table === row.table)!;
  if (collection.shape === "map2") {
    return {
      sql: `INSERT INTO ${row.table} (${collection.column}, ${collection.inner}, outer_ord, ord, body) VALUES (?, ?, ?, ?, ?) ` +
        `ON CONFLICT (${collection.column}, ${collection.inner}) DO UPDATE SET outer_ord = excluded.outer_ord, ord = excluded.ord, body = excluded.body`,
      params: [row.keys[0]!, row.keys[1]!, row.ords[0]!, row.ords[1]!, row.body],
    };
  }
  const names = Object.keys(collection.columns ?? {});
  return {
    sql: `INSERT INTO ${row.table} (${[collection.column, "ord", ...names, "body"].join(", ")}) VALUES (${["?", "?", ...names.map(() => "?"), "?"].join(", ")}) ` +
      `ON CONFLICT (${collection.column}) DO UPDATE SET ${["ord", ...names, "body"].map(n => `${n} = excluded.${n}`).join(", ")}`,
    params: [row.keys[0]!, row.ords[0]!, ...row.extra, row.body],
  };
}

function remove(spec: DocSpec<object>, row: Row): Stmt {
  const collection = spec.collections.find(c => c.table === row.table)!;
  return collection.shape === "map2"
    ? { sql: `DELETE FROM ${row.table} WHERE ${collection.column} = ? AND ${collection.inner} = ?`, params: [row.keys[0]!, row.keys[1]!] }
    : { sql: `DELETE FROM ${row.table} WHERE ${collection.column} = ?`, params: [row.keys[0]!] };
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

/** The document as the DB holds it, with each row's place, or null when the DB holds none of it. */
export function readDoc(db: DatabaseSync, spec: DocSpec<object>): { value: object; ords: Map<string, { ords: number[] }> } | null {
  const doc = db.prepare(`SELECT body, expanded FROM ${docTable(spec.kind)} WHERE file = ?`).get(spec.file) as { body: string; expanded: string } | undefined;
  if (!doc) return null;
  const value = JSON.parse(doc.body) as Record<string, unknown>;
  const expanded = JSON.parse(doc.expanded) as string[];
  const ords = new Map<string, { ords: number[] }>();
  for (const c of spec.collections) {
    if (!expanded.includes(c.key)) continue;
    if (c.shape === "map2") {
      const rows = db.prepare(`SELECT ${c.column} AS k, ${c.inner} AS i, outer_ord AS o, ord, body FROM ${c.table} ORDER BY outer_ord, ord`).all() as
        { k: string; i: string; o: number; ord: number; body: string | null }[];
      const out: [string, [string, unknown][]][] = [];
      for (const row of rows) {
        ords.set(rowId(c.table, [row.k, row.i]), { ords: [Number(row.o), Number(row.ord)] });
        if (row.body === null) out.push([row.k, []]);
        else out.at(-1)![1].push([row.i, JSON.parse(row.body)]);
      }
      value[c.key] = Object.fromEntries(out.map(([k, inner]) => [k, Object.fromEntries(inner)]));
      continue;
    }
    const rows = db.prepare(`SELECT ${c.column} AS k, ord, body FROM ${c.table} ORDER BY ord`).all() as { k: string; ord: number; body: string }[];
    for (const row of rows) ords.set(rowId(c.table, [row.k]), { ords: [Number(row.ord)] });
    value[c.key] = c.shape === "list" ? rows.map(row => JSON.parse(row.body)) : Object.fromEntries(rows.map(row => [row.k, JSON.parse(row.body)]));
  }
  return { value, ords };
}

/** The file's text, as `writeJson` and `writeJsonLater` write it. */
export const docText = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** Replaces every row of the document with the rows of `value`, inside the caller's transaction, and answers how many records it holds. */
function replaceDoc(db: DatabaseSync, spec: DocSpec<object>, value: object): number {
  const flat = flatten(spec, value, new Map());
  for (const c of spec.collections) db.exec(`DELETE FROM ${c.table}`);
  const run = (stmt: Stmt) => db.prepare(stmt.sql).run(...(stmt.params ?? []));
  run(saveDoc(spec, flat));
  for (const row of flat.rows.values()) run(upsert(spec, row));
  return recordsIn(flat);
}

/** How many records a document's file holds: its collections' entries; a file that does not parse holds none. */
export function docRecords(spec: DocSpec<object>, text: string): number {
  const value = parse(text);
  return value ? recordsIn(flatten(spec, value, new Map())) : 0;
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

/** One document a store holds in memory and saves as rows. */
export class Doc<T extends object> {
  /** The document; code reads and changes it in place, then calls `save`. */
  value: T;
  readonly move: JsonMove;
  /** Whether the DB held the document when it was opened, so `value` is not `spec.empty()`. */
  readonly stored: boolean;
  private last: Flat | null = null;
  private dirty = false;

  constructor(private readonly records: ChatRecords, readonly spec: DocSpec<T>) {
    this.move = records.move(docKind(spec as DocSpec<object>));
    const stored = readDoc(records.chat.db, spec as DocSpec<object>);
    this.value = (stored?.value as T | undefined) ?? spec.empty();
    this.stored = stored !== null;
    if (stored) this.last = flatten(spec as DocSpec<object>, stored.value, stored.ords);
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
    const old = this.last?.rows ?? new Map();
    const next = flatten(spec, this.value, old);
    const stmts: Stmt[] = [];
    if (next.doc !== this.last?.doc || next.expanded !== this.last?.expanded) stmts.push(saveDoc(spec, next));
    for (const [id, row] of next.rows) if (old.get(id)?.text !== row.text) stmts.push(upsert(spec, row));
    for (const [id, row] of old) if (!next.rows.has(id)) stmts.push(remove(spec, row));
    // A collection the document no longer expands, such as one set to null, loses every row of the ones it had.
    this.last = next;
    return stmts;
  }
}

/** The chat.sqlite connection, the data dir and the moves the documents of one process share. */
export class ChatRecords {
  private readonly docs: Doc<object>[] = [];
  private readonly moves = new Map<string, JsonMove>();
  private queued = false;

  constructor(readonly chat: ChatDb, readonly dataDir: string, private readonly open: (kind: JsonKind) => JsonMove) {}

  /** For a script or spec with no App: its own connection, which writes on the calling thread, and its own moves. */
  static standalone(dataDir: string): ChatRecords {
    const chat = new ChatDb(join(dataDir, "chat.sqlite"), { offThread: false });
    return new ChatRecords(chat, dataDir, kind => {
      const move = new JsonMove(chat, dataDir, kind);
      move.open();
      return move;
    });
  }

  /** The kind's move, opened on the first call: its tables, then the import of each of its files the DB has not seen. */
  move(kind: JsonKind): JsonMove {
    let move = this.moves.get(kind.kind);
    if (!move) this.moves.set(kind.kind, (move = this.open(kind)));
    return move;
  }

  doc<T extends object>(spec: DocSpec<T>): Doc<T> {
    const doc = new Doc(this, spec);
    this.docs.push(doc as unknown as Doc<object>);
    return doc;
  }

  /** Flushes once the disk queue wrote what was queued before the save. */
  schedule(): void {
    if (this.queued) return;
    this.queued = true;
    void drained().then(() => {
      this.queued = false;
      this.flush();
    });
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
    await this.chat.written();
  }

  /** Commits every save on this thread, for a process that is exiting or a script that is done. */
  flushSync(): void {
    this.flush();
    this.chat.flushSync();
  }
}
