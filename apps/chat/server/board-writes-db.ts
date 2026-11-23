/**
 * The board writes this server answered and pi-host has not taken yet, in chat.sqlite (chat-db.ts), moved from `<data dir>/board-writes.json`
 * (json-move.ts). pi-host keeps each board in its thread's `chat.board` document; this is only the queue of puts in front of it, which the
 * next server process puts again (boards.ts `putBoards`).
 *
 * One row per chat holds the newest board that waits for its put. `ord` keeps the order the old file listed the chats in: a chat keeps its
 * place while its board is replaced, and goes last once its put landed and a later write queues it again.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChatBoard } from "../web/src/lib/api/types.ts";
import type { ChatDb } from "./chat-db.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";

const FILE = "board-writes.json";

function boardsOf(text: string): Record<string, ChatBoard> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, ChatBoard>) : null;
  } catch {
    return null;
  }
}

const rows = (db: DatabaseSync): { chat: string; ord: number | bigint; body: string }[] =>
  db.prepare("SELECT chat, ord, body FROM board_writes ORDER BY ord").all() as { chat: string; ord: number | bigint; body: string }[];

export const BOARD_WRITES: JsonKind = {
  kind: "board-writes",
  migrations: ["CREATE TABLE board_writes (chat TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL)"],
  files: dataDir => (existsSync(join(dataDir, FILE)) ? [FILE] : []),
  load(db, _file, text) {
    const boards = boardsOf(text);
    if (!boards) return 0;
    db.exec("DELETE FROM board_writes");
    const insert = db.prepare("INSERT INTO board_writes (chat, ord, body) VALUES (?, ?, ?)");
    Object.entries(boards).forEach(([chat, board], i) => insert.run(chat, i, JSON.stringify(board)));
    return Object.keys(boards).length;
  },
  records: (_file, text) => Object.keys(boardsOf(text) ?? {}).length,
  count: db => Number((db.prepare("SELECT count(*) AS n FROM board_writes").get() as { n: number | bigint }).n),
  dump: db => `${JSON.stringify(Object.fromEntries(rows(db).map(row => [row.chat, JSON.parse(row.body) as ChatBoard])), null, 1)}\n`,
};

export class BoardWrites {
  /** Each chat's place in the queue, and the next place a chat queued anew takes. */
  private readonly ords = new Map<string, number>();
  private next = 0;

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove) {}

  /** The boards that wait for their put, in queue order. */
  all(): Map<string, ChatBoard> {
    const boards = new Map<string, ChatBoard>();
    for (const row of rows(this.chat.db)) {
      const ord = Number(row.ord);
      this.ords.set(row.chat, ord);
      this.next = Math.max(this.next, ord + 1);
      boards.set(row.chat, JSON.parse(row.body) as ChatBoard);
    }
    return boards;
  }

  /** Queues the chat's newest board; the promise settles once it is committed, which a board write's answer waits for. */
  put(chat: string, board: ChatBoard): Promise<void> {
    let ord = this.ords.get(chat);
    if (ord === undefined) this.ords.set(chat, (ord = this.next++));
    return this.write([{ sql: "INSERT OR REPLACE INTO board_writes (chat, ord, body) VALUES (?, ?, ?)", params: [chat, ord, JSON.stringify(board)] }], chat);
  }

  /** Takes the chat's board out of the queue once its put landed. */
  remove(chat: string): Promise<void> {
    this.ords.delete(chat);
    return this.write([{ sql: "DELETE FROM board_writes WHERE chat = ?", params: [chat] }], chat);
  }

  private write(stmts: { sql: string; params: (string | number)[] }[], chat: string): Promise<void> {
    const done = this.chat.write(stmts, `board write ${chat}`);
    this.move.touch(FILE);
    return done;
  }
}
