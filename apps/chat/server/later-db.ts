/**
 * Save for later's items in chat.sqlite (chat-db.ts), moved from `<data dir>/later/<by>.json` (json-move.ts). Later (later.ts) keeps each
 * principal's list in memory as it did with the files, and each write changes one item's row.
 *
 * `later_items` holds one row per item, with the item as later.ts holds it in `body`. A list reads newest save first, the order of the old
 * file: an item saved anew goes on top, with an `ord` below every other of its principal's items, and a changed item keeps its place.
 * `later_principals` names each principal that has a list, so the export of a list whose last item went still writes `{"v": 1, "items": []}`.
 */
import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { LaterItem } from "../web/src/lib/api/types.ts";
import type { ChatDb, Stmt } from "./chat-db.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";

/** `owner` or an agent id; it names the principal's file, so it may hold no path characters. */
export const PRINCIPAL = /^(owner|ag_[\w.-]+)$/;

const FILE = /^later\/(.+)\.json$/;
const fileOf = (by: string): string => `later/${by}.json`;
const principalOf = (file: string): string | undefined => FILE.exec(file)?.[1];

interface LaterFile { v: 1; items: LaterItem[] }

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
      return readdirSync(`${dataDir}/later`).filter(name => name.endsWith(".json") && PRINCIPAL.test(name.slice(0, -5))).map(name => `later/${name}`).sort();
    } catch {
      return [];
    }
  },
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

/** The rows of Later's lists: every list read once at boot, and one statement per changed item after. */
export class LaterRows {
  /** Each principal's items by id with their `ord`, and the lowest `ord`, under which a new save goes. */
  private readonly ords = new Map<string, { of: Map<string, number>; low: number }>();

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove) {}

  /** Every principal's list as stored, newest save first. */
  all(): Map<string, LaterItem[]> {
    const lists = new Map<string, LaterItem[]>();
    for (const { by } of this.chat.db.prepare("SELECT by FROM later_principals ORDER BY by").all() as { by: string }[]) lists.set(by, []);
    const all = this.chat.db.prepare("SELECT by, id, ord, body FROM later_items ORDER BY by, ord").all() as { by: string; id: string; ord: number | bigint; body: string }[];
    for (const row of all) {
      const ord = Number(row.ord);
      const kept = this.ordsOf(row.by);
      kept.of.set(row.id, ord);
      kept.low = Math.min(kept.low, ord);
      const list = lists.get(row.by);
      if (list) list.push(JSON.parse(row.body) as LaterItem);
      else lists.set(row.by, [JSON.parse(row.body) as LaterItem]);
    }
    return lists;
  }

  private ordsOf(by: string): { of: Map<string, number>; low: number } {
    let kept = this.ords.get(by);
    if (!kept) this.ords.set(by, (kept = { of: new Map(), low: 0 }));
    return kept;
  }

  /** Stores `item` in its place, or on top of the list when it is new there. */
  put(by: string, item: LaterItem): Promise<void> {
    const kept = this.ordsOf(by);
    let ord = kept.of.get(item.id);
    if (ord === undefined) {
      ord = kept.low = kept.of.size ? kept.low - 1 : 0;
      kept.of.set(item.id, ord);
    }
    return this.write([
      { sql: "INSERT OR IGNORE INTO later_principals (by) VALUES (?)", params: [by] },
      { sql: "INSERT INTO later_items (by, id, ord, body) VALUES (?, ?, ?, ?) ON CONFLICT (by, id) DO UPDATE SET ord = excluded.ord, body = excluded.body", params: [by, item.id, ord, JSON.stringify(item)] },
    ], by);
  }

  /** Deletes the item's row; its principal keeps its list, maybe empty. */
  remove(by: string, id: string): Promise<void> {
    this.ordsOf(by).of.delete(id);
    return this.write([{ sql: "DELETE FROM later_items WHERE by = ? AND id = ?", params: [by, id] }], by);
  }

  private write(stmts: Stmt[], by: string): Promise<void> {
    const done = this.chat.write(stmts, `later ${by}`);
    this.move.touch(fileOf(by));
    return done;
  }
}
