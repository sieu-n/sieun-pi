/**
 * Each room's posts, reactions, edits, pins and deliveries included, as rows of chat.sqlite (chat-db.ts): one row per post with its room,
 * its place in the room and its current state as JSON. Before the move each room had an append-only log, `rooms/<room>.jsonl`, with a `post`
 * line per new post and a `set` line per later change, read by replaying it; `POSTS` imports each such log once (json-move.ts).
 *
 * A room's posts are read once, on the first read of the room, and kept in memory as the log's were, so a read never waits on the DB. A new
 * post or a change writes the post's row through the writer thread, and a send awaits `written(room)` before it answers, as it awaited the
 * log's append. For the week of exports, each room's log is written back as `post` lines with each post's current state, which an older
 * release reads as the same posts.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ImageRef } from "../web/src/lib/api/types.ts";
import type { RoomId, RoomPost } from "./agent-store.ts";
import type { ChatDb } from "./chat-db.ts";
import { fileImageSize, withSize } from "./image-size.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";

/** A line of a room's log before the move. */
type LogLine = { t: "post"; post: RoomPost } | { t: "set"; post: string; patch: Partial<RoomPost> };

/** The name of a room's log, and of its rows' `room`: the room id with each character outside [\w.-] as `_`, as the log file was named. */
export const logName = (room: RoomId): string => room.replace(/[^\w.-]/g, "_");
const logFile = (name: string): string => `rooms/${name}.jsonl`;
const nameOf = (file: string): string => file.slice("rooms/".length, -".jsonl".length);

/** A room log's posts as the log replays: the first `post` line of each id, with every later `set` line on it applied in order. */
export function replayLog(text: string): RoomPost[] {
  const byId = new Map<string, RoomPost>();
  const list: RoomPost[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: LogLine;
    try {
      parsed = JSON.parse(line) as LogLine;
    } catch {
      continue;
    }
    if (parsed.t === "post") {
      if (byId.has(parsed.post.id)) continue;
      byId.set(parsed.post.id, parsed.post);
      list.push(parsed.post);
    } else {
      const post = byId.get(parsed.post);
      if (post) Object.assign(post, parsed.patch);
    }
  }
  return list;
}

const UPSERT = "INSERT INTO posts (room, id, ord, seq, body) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT (room, id) DO UPDATE SET ord = excluded.ord, seq = excluded.seq, body = excluded.body";

/** `rooms/<room>.jsonl` against the `posts` rows. A post's `ord` is its place in the room, as the log's line order gave it. */
export const POSTS: JsonKind = {
  kind: "posts",
  migrations: [
    "CREATE TABLE posts (room TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (room, id)) WITHOUT ROWID; " +
    "CREATE INDEX posts_order ON posts (room, ord)",
  ],
  files(dataDir) {
    let names: string[];
    try {
      names = readdirSync(join(dataDir, "rooms"));
    } catch {
      return [];
    }
    return names.filter(name => name.endsWith(".jsonl")).sort().map(name => `rooms/${name}`);
  },
  load(db, file, text) {
    const room = nameOf(file);
    const posts = replayLog(text);
    db.prepare("DELETE FROM posts WHERE room = ?").run(room);
    const insert = db.prepare(UPSERT);
    posts.forEach((post, ord) => insert.run(room, post.id, ord, post.seq, JSON.stringify(post)));
    return posts.length;
  },
  records: (_file, text) => replayLog(text).length,
  count: (db, file) => Number((db.prepare("SELECT count(*) AS n FROM posts WHERE room = ?").get(nameOf(file)) as { n: number | bigint }).n),
  dump(db, file) {
    const rows = db.prepare("SELECT body FROM posts WHERE room = ? ORDER BY ord").all(nameOf(file)) as { body: string }[];
    return rows.length ? rows.map(r => `{"t":"post","post":${r.body}}\n`).join("") : null;
  },
};

export class PostLog {
  private readonly rooms = new Map<string, RoomPost[]>();
  /** Each room's newest write, which settles once it and every write queued before it are committed. */
  private readonly last = new Map<string, Promise<void>>();
  private select?: StatementSync;

  /** `move` is the posts move while its week of exports lasts; a tool that only reads the posts passes none. */
  constructor(private readonly chat: ChatDb, private readonly dir: string, private readonly move?: JsonMove) {}

  private get db(): DatabaseSync {
    return this.chat.db;
  }

  /** The room's posts in order, read from the DB on the room's first read. */
  postsOf(room: RoomId): RoomPost[] {
    const name = logName(room);
    let list = this.rooms.get(name);
    if (list) return list;
    this.select ??= this.db.prepare("SELECT body FROM posts WHERE room = ? ORDER BY ord");
    list = (this.select.all(name) as { body: string }[]).map(row => {
      const post = JSON.parse(row.body) as RoomPost;
      // A post from before its upload's size was kept reads it from the file's header here, so every room draws its images at size.
      if (post.images?.length) post.images = post.images.map(ref => withSize(ref, () => this.uploadSize(ref)));
      return post;
    });
    this.rooms.set(name, list);
    return list;
  }

  /** Adds a post with the next seq at the end of its room and writes its row. */
  add(input: Omit<RoomPost, "id" | "seq">): RoomPost {
    const list = this.postsOf(input.room);
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    const post: RoomPost = { ...input, id: `p${seq}`, seq };
    const ord = list.length;
    list.push(post);
    const name = logName(post.room);
    this.write(name, { sql: UPSERT, params: [name, post.id, ord, seq, JSON.stringify(post)] }, "post");
    return post;
  }

  /** Writes the post's current state over its row, after a change to it. */
  save(post: RoomPost): void {
    const name = logName(post.room);
    this.write(name, { sql: "UPDATE posts SET body = ? WHERE room = ? AND id = ?", params: [JSON.stringify(post), name, post.id] }, "post change");
  }

  /** Settles once every post and change of the room written so far is committed. */
  written(room: RoomId): Promise<void> {
    return this.last.get(logName(room)) ?? Promise.resolve();
  }

  private write(name: string, stmt: { sql: string; params: (string | number)[] }, label: string): void {
    const done = this.chat.write([stmt], label);
    this.last.set(name, done);
    void done.then(() => {
      if (this.last.get(name) === done) this.last.delete(name);
    });
    this.move?.touch(logFile(name));
  }

  private uploadSize(ref: ImageRef): { width: number; height: number } | undefined {
    const name = ref.url.startsWith("/api/uploads/") ? ref.url.slice("/api/uploads/".length).replace(/[^\w.-]/g, "") : "";
    return name ? fileImageSize(join(this.dir, "images", name)) : undefined;
  }
}
