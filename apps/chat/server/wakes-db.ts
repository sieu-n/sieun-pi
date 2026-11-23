/**
 * The board wakes that have not gone out, in chat.sqlite (chat-db.ts), moved from one file per wake in `<data dir>/wakes/` (json-move.ts).
 * `WakeStore` keeps them in memory, where the ticker (wakes.ts), the board and Remind me read them, and each arm, send or drop changes one
 * row. The ticker's stamps `.ticked` and `.kinds` stay in the folder.
 *
 * A wake's id is its old file's name without `.json`, such as `<thread>-<conversation>-time-1796088600` or `later-<agent>-<room>-<post>`,
 * and `body` holds the wake as its file did.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { owedWakes, TICKED, type WakeFiles } from "../../../legacy/prime/user-history/src/wakes.ts";
import type { ChatDb } from "./chat-db.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";
import { parseArm, parseWake, type Wake } from "./wakes.ts";

const DIR = "wakes";
const FILE = /^wakes\/([\w.-]+)\.json$/;
const fileOf = (id: string): string => `${DIR}/${id}.json`;
const idOf = (file: string): string | undefined => FILE.exec(file)?.[1];

/**
 * The wake a file holds, or null when it holds none, which the ticker removed. A time wake apps/chat wrote before it took run and check wakes
 * (`{id, thread, conversation?, at, text}`) reads as the wake the ticker would have rewritten it to.
 */
function wakeOf(text: string): Wake | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const old = value as Record<string, unknown> | null;
  if (old && typeof old.thread === "string" && old.on === undefined && old.session === undefined) {
    try {
      return parseArm(old.thread, old, Date.now()).wake;
    } catch {
      return null;
    }
  }
  return parseWake(value);
}

const asFile = (body: string): string => `${JSON.stringify(JSON.parse(body), null, 1)}\n`;

export const WAKES: JsonKind = {
  kind: "wakes",
  migrations: ["CREATE TABLE wakes (id TEXT PRIMARY KEY, session TEXT NOT NULL, body TEXT NOT NULL)"],
  files(dataDir) {
    try {
      return readdirSync(join(dataDir, DIR)).filter(name => name.endsWith(".json") && idOf(fileOf(name.slice(0, -5))) !== undefined).map(name => `${DIR}/${name}`).sort();
    } catch {
      return [];
    }
  },
  load(db, file, text) {
    const id = idOf(file);
    const wake = wakeOf(text);
    if (id === undefined || !wake) return 0;
    db.prepare("INSERT OR REPLACE INTO wakes (id, session, body) VALUES (?, ?, ?)").run(id, wake.session, JSON.stringify(wake));
    return 1;
  },
  records: (_file, text) => (wakeOf(text) ? 1 : 0),
  count: (db, file) => (db.prepare("SELECT 1 FROM wakes WHERE id = ?").get(idOf(file) ?? "") ? 1 : 0),
  dump(db, file) {
    const row = db.prepare("SELECT body FROM wakes WHERE id = ?").get(idOf(file) ?? "") as { body: string } | undefined;
    return row ? asFile(row.body) : null;
  },
};

/** When the ticker last stamped `dir`, or undefined when it never did. */
export function tickedAt(dir: string): number | undefined {
  let text = "";
  try {
    text = readFileSync(join(dir, TICKED), "utf8");
  } catch {
    return undefined;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * The wakes the chat server still owes at `now` (`owedWakes`), read from a data dir's chat.sqlite without the server, for a duty precheck
 * that runs beside it, such as scripts/duties/fable-sweep.ts.
 */
export function owedWakesOf(dataDir: string, now: number): Wake[] {
  const db = new DatabaseSync(join(dataDir, "chat.sqlite"), { readOnly: true });
  try {
    const wakes = (db.prepare("SELECT body FROM wakes ORDER BY id").all() as { body: string }[]).flatMap(row => parseWake(JSON.parse(row.body)) ?? []);
    return owedWakes(wakes, tickedAt(join(dataDir, DIR)), now);
  } finally {
    db.close();
  }
}

export class WakeStore {
  private readonly wakes = new Map<string, Wake>();

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove, readonly dir: string) {
    for (const row of chat.db.prepare("SELECT id, body FROM wakes ORDER BY id").all() as { id: string; body: string }[]) {
      const wake = parseWake(JSON.parse(row.body));
      if (wake) this.wakes.set(row.id, wake);
    }
  }

  /** Each wake that has not gone out, with its id, in id order as the ticker reads them. */
  list(): { id: string; wake: Wake }[] {
    return [...this.wakes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, wake]) => ({ id, wake }));
  }

  get(id: string): Wake | undefined {
    return this.wakes.get(id);
  }

  /** Where a wake is kept, which board.wake shows the thread that set it. */
  where(id: string): string {
    return `chat.sqlite wakes ${id}`;
  }

  /** Sets the wake with this id, in place of one set before under it. */
  put(id: string, wake: Wake): Promise<void> {
    this.wakes.set(id, wake);
    const done = this.chat.write([{ sql: "INSERT OR REPLACE INTO wakes (id, session, body) VALUES (?, ?, ?)", params: [id, wake.session, JSON.stringify(wake)] }], `wake ${id}`);
    this.move.touch(fileOf(id));
    return done;
  }

  /** Takes the wake away; one that is not there writes nothing. */
  remove(id: string): Promise<void> {
    if (!this.wakes.delete(id)) return Promise.resolve();
    const done = this.chat.write([{ sql: "DELETE FROM wakes WHERE id = ?", params: [id] }], `wake ${id} gone`);
    this.move.touch(fileOf(id));
    return done;
  }

  /** The wakes the ticker owes at `now`, as `pendingWakes` read them from the folder. */
  owed(now: number): Wake[] {
    return owedWakes(this.list().map(({ wake }) => wake), tickedAt(this.dir), now);
  }

  /** The ticker's view: each wake keyed by its id, and its removal once it went out. */
  get files(): WakeFiles {
    return {
      list: async () => this.list().map(({ id, wake }) => ({ file: id, wake })),
      remove: async id => void (await this.remove(id)),
    };
  }
}
