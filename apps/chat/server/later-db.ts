/**
 * Where Save for later's lists are kept: `<data dir>/later/<by>.json` (`LaterFiles`), or chat.sqlite (chat-db.ts) once the server names the
 * kind `later` in APPS_CHAT_DB_KINDS (`LaterRows`), moved from those files by json-move.ts. Later (later.ts) keeps each principal's list in
 * memory either way.
 *
 * `later_items` holds one row per item, with the item as later.ts holds it in `body`. A list reads newest save first, the order of the old
 * file: an item saved anew goes on top, with an `ord` below every other of its principal's items, and a changed item keeps its place.
 * `later_principals` names each principal that has a list, so the export of a list whose last item went still writes `{"v": 1, "items": []}`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LaterItem } from "../web/src/lib/api/types.ts";
import type { ChatDb, Stmt } from "./chat-db.ts";
import { writeJsonLater } from "./disk.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";
import { readJson } from "./store.ts";

/** `owner` or an agent id; it names the principal's file, so it may hold no path characters. */
export const PRINCIPAL = /^(owner|ag_[\w.-]+)$/;

const FILE = /^later\/(.+)\.json$/;
const fileOf = (by: string): string => `later/${by}.json`;
const principalOf = (file: string): string | undefined => FILE.exec(file)?.[1];

interface LaterFile { v: 1; items: LaterItem[] }

/** Each principal's list as Later reads and writes it. */
export interface LaterLists {
  /** The principal's list as stored, newest save first, or an empty one. */
  load(by: string): LaterItem[];
  /** Stores `item`, which the principal's list `list` now holds in its place, or on top when it is new. */
  put(by: string, list: readonly LaterItem[], item: LaterItem): void;
  /** Takes the item `id` away; `list` is the principal's list without it. */
  remove(by: string, list: readonly LaterItem[], id: string): void;
}

/** The lists as JSON files, one per principal, each rewritten whole on a change. */
export class LaterFiles implements LaterLists {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "later");
  }

  load(by: string): LaterItem[] {
    return readJson<LaterFile>(join(this.dir, `${by}.json`), { v: 1, items: [] }).items ?? [];
  }

  put(by: string, list: readonly LaterItem[]): void {
    writeJsonLater(join(this.dir, `${by}.json`), { v: 1, items: [...list] } satisfies LaterFile);
  }

  remove(by: string, list: readonly LaterItem[]): void {
    this.put(by, list);
  }
}

/** The items of a list's text, or null when it is no list, which the release before the move read as an empty one. */
function itemsOf(text: string): LaterItem[] | null {
  try {
    const items = (JSON.parse(text) as Partial<LaterFile>).items;
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

function rows(db: DatabaseSync, by: string): LaterItem[] {
  return (db.prepare("SELECT body FROM later_items WHERE by = ? ORDER BY ord").all(by) as { body: string }[]).map(r => JSON.parse(r.body) as LaterItem);
}

export const LATER: JsonKind = {
  kind: "later",
  migrations: [
    "CREATE TABLE later_principals (by TEXT PRIMARY KEY)",
    "CREATE TABLE later_items (by TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (by, id))",
  ],
  files(dataDir) {
    try {
      return readdirSync(join(dataDir, "later")).filter(name => name.endsWith(".json") && PRINCIPAL.test(name.slice(0, -5))).map(name => `later/${name}`).sort();
    } catch {
      return [];
    }
  },
  /** The file is the whole list, so an item the DB holds and the file does not, such as one an older release unsaved, goes. */
  load(db, file, text) {
    const by = principalOf(file);
    const items = itemsOf(text);
    if (by === undefined || items === null) return 0;
    db.prepare("INSERT OR IGNORE INTO later_principals (by) VALUES (?)").run(by);
    db.prepare("DELETE FROM later_items WHERE by = ?").run(by);
    const insert = db.prepare("INSERT OR REPLACE INTO later_items (by, id, ord, body) VALUES (?, ?, ?, ?)");
    items.forEach((item, i) => insert.run(by, item.id, i, JSON.stringify(item)));
    return items.length;
  },
  records: (_file, text) => itemsOf(text)?.length ?? 0,
  count(db, file) {
    const row = db.prepare("SELECT count(*) AS n FROM later_items WHERE by = ?").get(principalOf(file) ?? "") as { n: number | bigint };
    return Number(row.n);
  },
  dump(db, file) {
    const by = principalOf(file);
    if (by === undefined || !db.prepare("SELECT 1 FROM later_principals WHERE by = ?").get(by)) return null;
    return `${JSON.stringify({ v: 1, items: rows(db, by) } satisfies LaterFile, null, 1)}\n`;
  },
};

/** The lists as chat.sqlite rows: every list read once here, and one statement per changed item after. */
export class LaterRows implements LaterLists {
  private readonly lists = new Map<string, LaterItem[]>();
  /** Each principal's items by id with their `ord`, and the lowest `ord`, under which a new save goes. */
  private readonly ords = new Map<string, { of: Map<string, number>; low: number }>();

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove) {
    for (const { by } of chat.db.prepare("SELECT by FROM later_principals ORDER BY by").all() as { by: string }[]) this.lists.set(by, []);
    const all = chat.db.prepare("SELECT by, id, ord, body FROM later_items ORDER BY by, ord").all() as { by: string; id: string; ord: number | bigint; body: string }[];
    for (const row of all) {
      const ord = Number(row.ord);
      const kept = this.ordsOf(row.by);
      kept.of.set(row.id, ord);
      kept.low = Math.min(kept.low, ord);
      const list = this.lists.get(row.by);
      if (list) list.push(JSON.parse(row.body) as LaterItem);
      else this.lists.set(row.by, [JSON.parse(row.body) as LaterItem]);
    }
  }

  load(by: string): LaterItem[] {
    return this.lists.get(by) ?? [];
  }

  private ordsOf(by: string): { of: Map<string, number>; low: number } {
    let kept = this.ords.get(by);
    if (!kept) this.ords.set(by, (kept = { of: new Map(), low: 0 }));
    return kept;
  }

  put(by: string, _list: readonly LaterItem[], item: LaterItem): void {
    const kept = this.ordsOf(by);
    let ord = kept.of.get(item.id);
    if (ord === undefined) {
      ord = kept.low = kept.of.size ? kept.low - 1 : 0;
      kept.of.set(item.id, ord);
    }
    this.write([
      { sql: "INSERT OR IGNORE INTO later_principals (by) VALUES (?)", params: [by] },
      { sql: "INSERT INTO later_items (by, id, ord, body) VALUES (?, ?, ?, ?) ON CONFLICT (by, id) DO UPDATE SET ord = excluded.ord, body = excluded.body", params: [by, item.id, ord, JSON.stringify(item)] },
    ], by);
  }

  remove(by: string, _list: readonly LaterItem[], id: string): void {
    this.ordsOf(by).of.delete(id);
    this.write([{ sql: "DELETE FROM later_items WHERE by = ? AND id = ?", params: [by, id] }], by);
  }

  private write(stmts: Stmt[], by: string): void {
    void this.chat.write(stmts, `later ${by}`);
    this.move.touch(fileOf(by));
  }
}
