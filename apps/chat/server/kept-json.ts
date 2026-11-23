/**
 * The JSON values the chat server keeps as copies of what pi-host and the relays last said, as rows in chat.sqlite (chat-db.ts): the host
 * routes (host/multi-host.ts), the caches under cache/ (store.ts `cache`), the relay feed cursors (host/relay-host.ts) and the search
 * cursor (app.ts). Each was one JSON file rewritten whole on every change: on 11-23 host-routes.json held 1.2 MB and was rewritten about
 * 12 times a minute, and cache/threads.json held 1.8 MB.
 *
 * A file's value is split into parts by its kind's `groups`: each group is a record, an array of objects with a unique `id`, or an array of
 * `[key, value]` pairs at one path of the value, and each of its entries is one row keyed by its key. What is left, with null at each group's
 * path, is the file's head row, and each group's key order is one row too. `write` compares a new value with the rows it last wrote and
 * writes only the rows that changed. A group whose entries do not fit its shape, such as two entries with one id, stays whole in the head,
 * so no value is ever dropped.
 *
 * Each entry's body is its JSON as the file renders it at the top level, so a file is its bodies joined and indented to their depth. Each
 * value is held in memory as the rows hold it, so a read never waits on the DB. `dump` renders a file from the rows in the bytes the
 * release before the move wrote, which is the rollback export of json-move.ts and the check that nothing was lost.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChatDb, Stmt } from "./chat-db.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";

/** How a group's entries are keyed: a record's own keys, each object's `id`, or the first item of each `[key, value]` pair. */
type By = "key" | "id" | "pair";
type Group = { path: string[]; by: By };

export interface SplitKind extends JsonKind {
  /** The groups a file's value splits into; one that does not fit the value is left whole in the head. */
  groups(file: string, value: unknown): Group[];
  /** The `JSON.stringify` indent the release before the move wrote the files with: 0 for none, 1 for `writeJson`'s. */
  indent: number;
}

/** The rows of one file as they were last written: its head, its group list and each group's keys and entries. */
type Rows = { head: string; spec: string; groups: Map<string, { keys: string[]; bodies: Map<string, string> }> };
type Split = { head: string; spec: string; groups: { grp: string; keys: string[]; bodies: string[] }[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

/** The group's entries as `[key, body]`, each body as the file renders it at the top level, or null when the value does not fit. */
function entriesOf(value: unknown, by: By, indent: number): [string, string][] | null {
  const json = (v: unknown): string | undefined => JSON.stringify(v, null, indent);
  if (by === "key") {
    if (!isRecord(value)) return null;
    // JSON leaves out a key whose value is undefined, as the file did.
    return Object.entries(value).flatMap(([key, v]): [string, string][] => {
      const body = json(v);
      return body === undefined ? [] : [[key, body]];
    });
  }
  if (!Array.isArray(value)) return null;
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let key: unknown, body: string | undefined;
    if (by === "id") {
      if (!isRecord(item)) return null;
      key = item.id;
      body = json(item);
    } else {
      if (!Array.isArray(item) || item.length !== 2) return null;
      key = item[0];
      body = json(item[1]) ?? "null";
    }
    if (typeof key !== "string" || seen.has(key)) return null;
    seen.add(key);
    out.push([key, body]);
  }
  return out;
}

function at(value: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let here = value;
  for (const key of path) {
    if (!isRecord(here) || !Object.hasOwn(here, key)) return { found: false, value: undefined };
    here = here[key];
  }
  return { found: true, value: here };
}

/** A copy of `value` with null at each path, sharing everything off the paths. */
function blank(value: unknown, paths: readonly (readonly string[])[]): unknown {
  if (paths.some(p => !p.length)) return null;
  const copy = { ...(value as Record<string, unknown>) };
  const next = new Map<string, string[][]>();
  for (const [first, ...rest] of paths) next.set(first!, [...(next.get(first!) ?? []), rest]);
  for (const [key, rest] of next) own(copy, key, blank((value as Record<string, unknown>)[key], rest));
  return copy;
}

/** `value` split into rows by `kind`'s groups. */
export function split(kind: SplitKind, file: string, value: unknown): Split {
  const groups: (Group & { entries: [string, string][] })[] = [];
  const taken: string[][] = [];
  for (const group of kind.groups(file, value)) {
    // A path inside or around one already taken would split the same entries twice.
    if (taken.some(p => p.length <= group.path.length ? p.every((k, i) => group.path[i] === k) : group.path.every((k, i) => p[i] === k))) continue;
    const found = at(value, group.path);
    const entries = found.found ? entriesOf(found.value, group.by, kind.indent) : null;
    if (!entries) continue;
    taken.push(group.path);
    groups.push({ ...group, entries });
  }
  const spec = groups.map(({ path, by }) => ({ path, by }));
  return {
    head: JSON.stringify(blank(value, taken)) ?? "null",
    spec: JSON.stringify(spec),
    groups: groups.map(g => ({ grp: JSON.stringify(g.path), keys: g.entries.map(([k]) => k), bodies: g.entries.map(([, b]) => b) })),
  };
}

/** One group's keys in order and each key's body, as the rows hold them. */
type GroupRows = { keys: readonly string[]; bodies: readonly string[] };

/**
 * The file's JSON as `JSON.stringify(value, null, indent)` writes it, built from the rows' text: each group's bodies are joined in their
 * order, indented to their depth, and put in the head where its path holds a marker, so no entry is parsed or rendered again.
 */
function textOf(head: string, spec: string, group: (grp: string) => GroupRows, indent: number): string {
  const groups = JSON.parse(spec) as Group[];
  const nonce = randomUUID();
  let value = JSON.parse(head) as unknown;
  groups.forEach(({ path }, i) => {
    if (!path.length) value = `${nonce}:${i}`;
    else own(at(value, path.slice(0, -1)).value as object, path.at(-1)!, `${nonce}:${i}`);
  });
  const nl = (depth: number) => (indent ? `\n${" ".repeat(indent * depth)}` : "");
  const shift = (body: string, depth: number) => (indent ? body.replaceAll("\n", nl(depth)) : body);
  const q = (key: string) => JSON.stringify(key);
  let text = JSON.stringify(value, null, indent);
  groups.forEach(({ path, by }, i) => {
    const { keys, bodies } = group(JSON.stringify(path));
    const d = path.length;
    const list = (items: string[], open: string, close: string) => (items.length ? `${open}${nl(d + 1)}${items.join(`,${nl(d + 1)}`)}${nl(d)}${close}` : `${open}${close}`);
    const joined = by === "id" ? list(bodies.map(b => shift(b, d + 1)), "[", "]")
      : by === "pair" ? list(keys.map((k, n) => `[${nl(d + 2)}${q(k)},${nl(d + 2)}${shift(bodies[n]!, d + 2)}${nl(d + 1)}]`), "[", "]")
      : list(keys.map((k, n) => `${q(k)}:${indent ? " " : ""}${shift(bodies[n]!, d + 1)}`), "{", "}");
    text = text.replace(`"${nonce}:${i}"`, () => joined);
  });
  return text;
}

/** How many records a split holds: each group entry, or one for a file with no groups. */
const recordsOf = (s: Split): number => (s.groups.length ? s.groups.reduce((n, g) => n + g.keys.length, 0) : 1);

/** The JsonKind and the rows of a kind whose files split by `groups`, with tables `<prefix>_heads`, `_orders` and `_parts`. */
export function splitKind(options: {
  kind: string; prefix: string; files: (dataDir: string) => string[]; groups: SplitKind["groups"]; indent: number;
}): SplitKind {
  const { prefix } = options;
  const parse = (text: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  };
  const kind: SplitKind = {
    kind: options.kind,
    migrations: [
      `CREATE TABLE ${prefix}_heads (file TEXT PRIMARY KEY, head TEXT NOT NULL, groups TEXT NOT NULL);
       CREATE TABLE ${prefix}_orders (file TEXT NOT NULL, grp TEXT NOT NULL, keys TEXT NOT NULL, PRIMARY KEY (file, grp));
       CREATE TABLE ${prefix}_parts (file TEXT NOT NULL, grp TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (file, grp, key));`,
    ],
    files: options.files,
    groups: options.groups,
    indent: options.indent,
    load(db, file, text) {
      const parsed = parse(text);
      // A file that is not JSON read as missing before the move too; the rows keep what they held.
      if (!parsed.ok) return 0;
      const s = split(kind, file, parsed.value);
      for (const stmt of rowsOf(prefix, file, s)) db.prepare(stmt.sql).run(...(stmt.params ?? []));
      return recordsOf(s);
    },
    records(file, text) {
      const parsed = parse(text);
      return parsed.ok ? recordsOf(split(kind, file, parsed.value)) : 0;
    },
    count(db, file) {
      const head = db.prepare(`SELECT groups FROM ${prefix}_heads WHERE file = ?`).get(file) as { groups: string } | undefined;
      if (!head) return 0;
      if (head.groups === "[]") return 1;
      return Number((db.prepare(`SELECT count(*) AS n FROM ${prefix}_parts WHERE file = ?`).get(file) as { n: number | bigint }).n);
    },
    dump(db, file) {
      const head = db.prepare(`SELECT head, groups FROM ${prefix}_heads WHERE file = ?`).get(file) as { head: string; groups: string } | undefined;
      if (!head) return null;
      // SQLite joins each group's bodies in its key order, so an export reads one string per group and not one row per entry. JSON text
      // never holds a raw control character, so char(1) splits them again.
      const order = db.prepare(`SELECT keys FROM ${prefix}_orders WHERE file = ? AND grp = ?`);
      const joined = db.prepare(
        `SELECT group_concat(coalesce(p.body, 'null'), char(1) ORDER BY j.key) AS bodies FROM json_each(?) j ` +
        `LEFT JOIN ${prefix}_parts p ON p.file = ? AND p.grp = ? AND p.key = j.value`,
      );
      const group = (grp: string): GroupRows => {
        const keys = (order.get(file, grp) as { keys: string } | undefined)?.keys ?? "[]";
        const bodies = (joined.get(keys, file, grp) as { bodies: string | null }).bodies;
        return { keys: JSON.parse(keys) as string[], bodies: bodies === null ? [] : bodies.split("\u0001") };
      };
      return `${textOf(head.head, head.groups, group, options.indent)}\n`;
    },
  };
  return kind;
}

/** The statements that replace every row of `file` with those of `s`. */
function rowsOf(prefix: string, file: string, s: Split): Stmt[] {
  return [
    { sql: `DELETE FROM ${prefix}_parts WHERE file = ?`, params: [file] },
    { sql: `DELETE FROM ${prefix}_orders WHERE file = ?`, params: [file] },
    { sql: `INSERT OR REPLACE INTO ${prefix}_heads (file, head, groups) VALUES (?, ?, ?)`, params: [file, s.head, s.spec] },
    ...s.groups.flatMap(g => [
      { sql: `INSERT INTO ${prefix}_orders (file, grp, keys) VALUES (?, ?, ?)`, params: [file, g.grp, JSON.stringify(g.keys)] },
      ...g.keys.map((key, i) => ({ sql: `INSERT INTO ${prefix}_parts (file, grp, key, body) VALUES (?, ?, ?, ?)`, params: [file, g.grp, key, g.bodies[i]!] })),
    ]),
  ];
}

/** Every file's rows. */
function readRows(db: DatabaseSync, prefix: string): Map<string, Rows> {
  const out = new Map<string, Rows>();
  for (const r of db.prepare(`SELECT file, head, groups FROM ${prefix}_heads`).all() as { file: string; head: string; groups: string }[]) {
    out.set(r.file, { head: r.head, spec: r.groups, groups: new Map() });
  }
  for (const r of db.prepare(`SELECT file, grp, keys FROM ${prefix}_orders`).all() as { file: string; grp: string; keys: string }[]) {
    out.get(r.file)?.groups.set(r.grp, { keys: JSON.parse(r.keys) as string[], bodies: new Map() });
  }
  for (const r of db.prepare(`SELECT file, grp, key, body FROM ${prefix}_parts`).all() as { file: string; grp: string; key: string; body: string }[]) {
    out.get(r.file)?.groups.get(r.grp)?.bodies.set(r.key, r.body);
  }
  return out;
}

function valueOf(rows: Rows, indent: number): unknown {
  return JSON.parse(textOf(rows.head, rows.spec, grp => {
    const group = rows.groups.get(grp);
    const keys = group?.keys ?? [];
    return { keys, bodies: keys.map(key => group?.bodies.get(key) ?? "null") };
  }, indent));
}

/** A place that keeps JSON values by their file path relative to the data dir. */
export interface Kept {
  read(file: string): unknown;
  write(file: string, value: unknown): Promise<void>;
}

/** The values of one split kind, held in memory as its rows hold them; a write queues only the rows that changed. */
export class KeptJson implements Kept {
  private readonly files: Map<string, Rows>;
  private readonly prefix: string;

  constructor(private readonly chat: ChatDb, private readonly kind: SplitKind, private readonly move?: JsonMove) {
    this.prefix = kind.kind.replace(/\W/g, "_");
    this.files = readRows(chat.db, this.prefix);
  }

  /** A fresh copy of the value last written to `file`, or undefined when it holds none. */
  read(file: string): unknown {
    const rows = this.files.get(file);
    return rows ? valueOf(rows, this.kind.indent) : undefined;
  }

  /** Writes `value` as `file`'s value, as the rows that changed; settles once they are committed. */
  write(file: string, value: unknown): Promise<void> {
    const { prefix } = this;
    const s = split(this.kind, file, value);
    const before = this.files.get(file);
    const stmts: Stmt[] = [];
    if (!before || before.head !== s.head || before.spec !== s.spec) {
      stmts.push({ sql: `INSERT OR REPLACE INTO ${prefix}_heads (file, head, groups) VALUES (?, ?, ?)`, params: [file, s.head, s.spec] });
    }
    const groups: Rows["groups"] = new Map();
    for (const g of s.groups) {
      const old = before?.groups.get(g.grp);
      const bodies = new Map<string, string>();
      g.keys.forEach((key, i) => {
        const body = g.bodies[i]!;
        bodies.set(key, body);
        if (old?.bodies.get(key) !== body) {
          stmts.push({ sql: `INSERT OR REPLACE INTO ${prefix}_parts (file, grp, key, body) VALUES (?, ?, ?, ?)`, params: [file, g.grp, key, body] });
        }
      });
      for (const key of old?.bodies.keys() ?? []) {
        if (!bodies.has(key)) stmts.push({ sql: `DELETE FROM ${prefix}_parts WHERE file = ? AND grp = ? AND key = ?`, params: [file, g.grp, key] });
      }
      if (!old || old.keys.length !== g.keys.length || old.keys.some((k, i) => k !== g.keys[i])) {
        stmts.push({ sql: `INSERT OR REPLACE INTO ${prefix}_orders (file, grp, keys) VALUES (?, ?, ?)`, params: [file, g.grp, JSON.stringify(g.keys)] });
      }
      groups.set(g.grp, { keys: g.keys, bodies });
    }
    for (const grp of before?.groups.keys() ?? []) {
      if (groups.has(grp)) continue;
      stmts.push({ sql: `DELETE FROM ${prefix}_parts WHERE file = ? AND grp = ?`, params: [file, grp] });
      stmts.push({ sql: `DELETE FROM ${prefix}_orders WHERE file = ? AND grp = ?`, params: [file, grp] });
    }
    this.files.set(file, { head: s.head, spec: s.spec, groups });
    if (!stmts.length) return Promise.resolve();
    const done = this.chat.write(stmts, `${this.kind.kind} ${file}`);
    this.move?.touch(file);
    return done;
  }
}

const jsonFiles = (dataDir: string, dir: string): string[] => {
  try {
    return readdirSync(join(dataDir, dir), { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".json")).map(e => `${dir}/${e.name}`).sort();
  } catch {
    return [];
  }
};

/** host-routes.json (host/multi-host.ts): the box of each thread, and each box's last good thread list, one row per thread. */
export const HOST_ROUTES_KIND = splitKind({
  kind: "host-routes",
  prefix: "host_routes",
  files: dataDir => (existsSync(join(dataDir, "host-routes.json")) ? ["host-routes.json"] : []),
  groups: (_file, value) => [
    { path: ["threads"], by: "key" },
    ...Object.entries(at(value, ["rows"]).value ?? {}).flatMap(([box, lists]) =>
      Object.keys(isRecord(lists) ? lists : {}).map((list): Group => ({ path: ["rows", box, list], by: "id" }))),
  ],
  indent: 0,
});

/**
 * The caches under cache/ (store.ts `cache`, agents.ts's agent refs and rooms.ts's feed marks), the relay feed cursors under relay/ and
 * the search cursor in search/meili.json, one row per thread, board, ref or mark. cache/tails/ is the tail cache's own (tail-cache.ts).
 */
export const CACHE_KIND = splitKind({
  kind: "cache",
  prefix: "cache",
  files: dataDir => [
    ...jsonFiles(dataDir, "cache"), ...jsonFiles(dataDir, "relay"), ...(existsSync(join(dataDir, "search", "meili.json")) ? ["search/meili.json"] : []),
  ],
  groups(file, value): Group[] {
    if (file === "cache/threads.json") return [{ path: ["threads"], by: "id" }, { path: ["trees"], by: "pair" }];
    if (file === "cache/agent-refs.json") return [{ path: ["refs"], by: "key" }];
    if (file === "cache/first-sends.json" && isRecord(at(value, ["scans"]).value)) return [{ path: ["scans"], by: "key" }];
    if (file.startsWith("cache/")) return [{ path: [], by: "key" }];
    return [];
  },
  indent: 1,
});
