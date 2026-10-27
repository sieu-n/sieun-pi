/** The messages around one hit, from the docs table of the box that holds it or from a durable thread index. */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Kind } from "./query.ts";
import { durableKind } from "./search.ts";

export interface ReadMessage { at: number; kind: Kind; author: string; tool?: string; text: string; hit?: boolean }
export interface ReadAnswer { box: string; session: string; thread: string; messages: ReadMessage[] }

export type Ref =
  | { box: string; session: string; at: number; source: "prime"; id: number }
  | { box: string; session: string; at: number; source: "durable"; index: number; id: number };

export class ReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Parses `<box>:<session>@<at>#<doc id>` (prime) or `<box>:<thread>@<at>#d<index>.<rowid>` (durable). */
export function parseRef(ref: string): Ref {
  const match = /^([^:]+):([^@]+)@(\d+)#(?:(\d+)|d(\d+)\.(\d+))$/.exec(ref.trim());
  if (!match) throw new ReadError(400, `Not a hit ref: ${ref}. A ref reads <box>:<session>@<at>#<doc id>.`);
  const [, box, session, at, id, index, rowid] = match;
  if (id) return { box: box!, session: session!, at: Number(at), source: "prime", id: Number(id) };
  return { box: box!, session: session!, at: Number(at), source: "durable", index: Number(index), id: Number(rowid) };
}

type Row = Record<string, SQLInputValue>;

const message = (row: Row, hit: boolean, kind = String(row.kind) as Kind): ReadMessage => ({
  at: Number(row.at), kind, author: String(row.author ?? ""), ...row.tool ? { tool: String(row.tool) } : {},
  text: String(row.text), ...hit ? { hit: true } : {},
});

/** The hit and up to `before` and `after` messages of the same transcript beside it, thinking left out unless it is the hit. */
export function readPrime(db: DatabaseSync, box: string, ref: Extract<Ref, { source: "prime" }>, before: number, after: number, roots: string[] | null): ReadAnswer {
  const hit = db.prepare(`SELECT d.id, d.file, d.at, d.kind, d.tool, d.author, d.text, f.session, f.root, f.name FROM docs d JOIN files f ON f.id = d.file WHERE d.id = ?`)
    .get(ref.id) as Row | undefined;
  if (!hit) throw new ReadError(404, `No message ${ref.id} on ${box}; the index may have been rebuilt, so search again.`);
  if (roots && !roots.includes(String(hit.root))) throw new ReadError(403, `${String(hit.session)} is outside this session's chat family.`);
  const columns = "id, at, kind, tool, author, text";
  const older = db.prepare(`SELECT ${columns} FROM docs WHERE file = ? AND id < ? AND kind != 'thinking' ORDER BY id DESC LIMIT ?`).all(hit.file, ref.id, before) as Row[];
  const newer = db.prepare(`SELECT ${columns} FROM docs WHERE file = ? AND id > ? AND kind != 'thinking' ORDER BY id LIMIT ?`).all(hit.file, ref.id, after) as Row[];
  return {
    box, session: String(hit.session), thread: hit.name ? String(hit.name) : String(hit.session),
    messages: [...older.reverse().map(row => message(row, false)), message(hit, true), ...newer.map(row => message(row, false))],
  };
}

/** The same from a pi-host durable index, where an entry's neighbours are the thread's entries by rowid. */
export function readDurable(db: DatabaseSync, box: string, ref: Extract<Ref, { source: "durable" }>, before: number, after: number, roots: string[] | null): ReadAnswer {
  const hit = db.prepare("SELECT rowid AS id, thread, kind, author, CAST(at AS INTEGER) AS at, text FROM entries WHERE rowid = ?").get(ref.id) as Row | undefined;
  if (!hit) throw new ReadError(404, `No durable entry ${ref.id} on ${box}.`);
  if (roots && !roots.includes(String(hit.thread))) throw new ReadError(403, `${String(hit.thread)} is outside this session's chat family.`);
  const columns = "rowid AS id, kind, author, CAST(at AS INTEGER) AS at, text";
  const older = db.prepare(`SELECT ${columns} FROM entries WHERE thread = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`).all(hit.thread, ref.id, before) as Row[];
  const newer = db.prepare(`SELECT ${columns} FROM entries WHERE thread = ? AND rowid > ? ORDER BY rowid LIMIT ?`).all(hit.thread, ref.id, after) as Row[];
  const name = db.prepare("SELECT name FROM threads WHERE id = ?").get(hit.thread) as Row | undefined;
  return {
    box, session: String(hit.thread), thread: name?.name ? String(name.name) : String(hit.thread),
    messages: [...older.reverse().map(row => message(row, false, durableKind(String(row.kind)))), message(hit, true, durableKind(String(hit.kind))),
      ...newer.map(row => message(row, false, durableKind(String(row.kind))))],
  };
}
