/**
 * Where the board wakes that have not gone out are kept: one file per wake in `<data dir>/wakes/` (`FolderWakes`), or chat.sqlite
 * (chat-db.ts) once the server names the kind `wakes` in APPS_CHAT_DB_KINDS (`WakeRows`), moved from those files by json-move.ts. The
 * ticker (wakes.ts), the board and Remind me read them through `WakeStore`. The ticker's stamps `.ticked` and `.kinds` stay in the folder.
 *
 * A wake's id is its file's name without `.json`, such as `<thread>-<conversation>-time-1796088600` or `later-<agent>-<room>-<post>`, and a
 * row's `body` holds the wake as its file did.
 *
 * A wake whose message went to its thread stays here, held, with `sent` in its body, until the thread answered that message (`hold`). The
 * ticker, the board and Remind me read it as gone (`list`, `get`), and every reader of who owns a step reads it as owed: `owed`, and the
 * readers of the rows or files themselves, which are `owedWakesOf` for the fable sweep and d9's `appsWakes`
 * (legacy/prime/user-history/scripts/duties/chat-system-apps.ts). On 11-28 the check wake for devops guy's p150 passed at 11:55:57Z and its
 * message waited in the busy thread's queue until 14:01:37Z. The wake was deleted at the send, so for 126 min p150 read as a step nobody
 * owned, and 7 of that thread's 12 newest wakes waited 8 to 126 min the same way.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { owedWakes, pendingWakes, TICKED, type WakeFiles } from "../../../legacy/prime/user-history/src/wakes.ts";
import type { ChatDb } from "./chat-db.ts";
import { movedKinds } from "./chat-records.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";
import { readJson, writeJson } from "./store.ts";
import { adoptOldWakes, parseArm, parseWake, type Wake } from "./wakes.ts";

const DIR = "wakes";
const FILE = /^wakes\/([\w.-]+)\.json$/;
const fileOf = (id: string): string => `${DIR}/${id}.json`;
const idOf = (file: string): string | undefined => FILE.exec(file)?.[1];

/** A held wake's message in its thread: the pi-host submission that carries it, and when it went. */
export interface SentWake { submission: number; at: number }

/** The `sent` a stored wake's body carries, parsed at the boundary; undefined for a wake that has not gone out. */
function sentOf(value: unknown): SentWake | undefined {
  const sent = (value as { sent?: { submission?: unknown; at?: unknown } } | null)?.sent;
  return sent && typeof sent.submission === "number" && typeof sent.at === "number" ? { submission: sent.submission, at: sent.at } : undefined;
}

/** The wakes the ticker, the board and Remind me read and set. */
export interface WakeStore {
  /** The folder of the ticker's stamps. */
  readonly dir: string;
  /** Each wake that has not gone out, with its id, in id order as the ticker reads them. */
  list(): { id: string; wake: Wake }[];
  get(id: string): Wake | undefined;
  /** Sets the wake with this id, in place of one set before under it; settles once it is stored. */
  put(id: string, wake: Wake): Promise<void>;
  /** Takes the wake away, held or not; one that is not there writes nothing. */
  remove(id: string): Promise<void>;
  /** Holds a wake whose message went to its thread: `list` and `get` leave it out, and `owed` keeps it until `remove`. */
  hold(id: string, sent: SentWake): Promise<void>;
  /** The held wakes, in id order. */
  held(): { id: string; wake: Wake; sent: SentWake }[];
  /** Where a wake is kept, which board.wake shows the thread that set it. */
  where(id: string): string;
  /** The wakes the app owes at `now` (`owedWakes`): the ones the ticker has to send and the held ones. */
  owed(now: number): Promise<Wake[]>;
  /** The ticker's source: the wakes that have not gone out, keyed by id. */
  readonly files: WakeFiles;
  /** Runs before the ticker starts. */
  adopt(log: (line: string) => void): void;
}

/** The wakes as one JSON file each in the folder, as the legacy chat keeps them. */
export class FolderWakes implements WakeStore {
  constructor(readonly dir: string) {}

  /** Each `.json` file of the folder in name order: its wake, or null for a file that holds none, and `sent` for a held one. */
  private read(): { id: string; wake: Wake | null; sent?: SentWake }[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(name => name.endsWith(".json")).sort(); } catch { names = []; }
    return names.map(name => {
      const value = readJson<unknown>(join(this.dir, name), null);
      const sent = sentOf(value);
      return { id: name.slice(0, -5), wake: parseWake(value), ...(sent ? { sent } : {}) };
    });
  }

  list(): { id: string; wake: Wake }[] {
    return this.read().flatMap(({ id, wake, sent }) => (wake && !sent ? [{ id, wake }] : []));
  }

  held(): { id: string; wake: Wake; sent: SentWake }[] {
    return this.read().flatMap(({ id, wake, sent }) => (wake && sent ? [{ id, wake, sent }] : []));
  }

  get(id: string): Wake | undefined {
    const value = readJson<unknown>(this.where(id), null);
    return sentOf(value) ? undefined : parseWake(value) ?? undefined;
  }

  async put(id: string, wake: Wake): Promise<void> {
    writeJson(this.where(id), wake);
  }

  async remove(id: string): Promise<void> {
    rmSync(this.where(id), { force: true });
  }

  async hold(id: string, sent: SentWake): Promise<void> {
    const wake = this.get(id);
    if (wake) writeJson(this.where(id), { ...wake, sent });
  }

  get files(): WakeFiles {
    return {
      list: async () => this.read().flatMap(({ id, wake, sent }) => (wake && sent ? [] : [{ file: id, wake }])),
      remove: id => this.remove(id),
    };
  }

  where(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  owed(now: number): Promise<Wake[]> {
    return pendingWakes(this.dir, now);
  }

  adopt(log: (line: string) => void): void {
    adoptOldWakes(this.dir, log);
  }
}

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
 * The wakes a chat server still owes at `now`, the held ones too, read without the server, for a duty precheck that runs beside it, such as
 * scripts/duties/fable-sweep.ts. They are chat.sqlite rows once a server moved the kind there (chat-records.ts `movedKinds`), whatever the
 * caller's environment says, so a precheck run by hand never reads the exports, which stop after a week.
 */
export async function owedWakesOf(dataDir: string, now: number, kinds: readonly string[] = movedKinds(dataDir)): Promise<Wake[]> {
  if (!kinds.includes(WAKES.kind)) return pendingWakes(join(dataDir, DIR), now);
  const db = new DatabaseSync(join(dataDir, "chat.sqlite"), { readOnly: true });
  try {
    const wakes = (db.prepare("SELECT body FROM wakes ORDER BY id").all() as { body: string }[]).flatMap(row => parseWake(JSON.parse(row.body)) ?? []);
    return owedWakes(wakes, tickedAt(join(dataDir, DIR)), now);
  } finally {
    db.close();
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The wakes as chat.sqlite rows, kept in memory, where each arm, send or drop changes one row. */
export class WakeRows implements WakeStore {
  private readonly wakes = new Map<string, Wake>();
  /** The held wakes (`hold`), whose rows carry `sent`. */
  private readonly kept = new Map<string, { wake: Wake; sent: SentWake }>();

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove, readonly dir: string, log: (line: string) => void = () => {}) {
    for (const row of chat.db.prepare("SELECT id, body FROM wakes ORDER BY id").all() as { id: string; body: string }[]) {
      const value: unknown = JSON.parse(row.body);
      const wake = parseWake(value);
      const sent = sentOf(value);
      if (wake && sent) this.kept.set(row.id, { wake, sent });
      else if (wake) this.wakes.set(row.id, wake);
    }
    this.dropDeleted(log);
  }

  /**
   * In the week of exports a wake's file is its whole record: a wake whose file the DB wrote or read as it holds it now, and which is gone
   * from the folder, went out or was dropped by an older release after a rollback, so it goes here too and never goes out twice. A wake
   * whose row changed since its last export, such as one set again before a crash cut the export, keeps its row.
   */
  private dropDeleted(log: (line: string) => void): void {
    if (!this.move.exportsOn()) return;
    const known = this.chat.db.prepare("SELECT 1 FROM db_files WHERE kind = ? AND path = ? AND sha256 = ?");
    const gone: string[] = [];
    for (const id of this.wakes.keys()) {
      const file = fileOf(id);
      if (existsSync(join(this.move.dataDir, file))) continue;
      const text = WAKES.dump(this.chat.db, file);
      if (text !== null && known.get(WAKES.kind, file, sha256(text))) gone.push(id);
    }
    if (!gone.length) return;
    for (const id of gone) this.wakes.delete(id);
    // The boot's own connection, as the import's, so the rows are gone before the first read.
    const remove = this.chat.db.prepare("DELETE FROM wakes WHERE id = ?");
    this.chat.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of gone) remove.run(id);
      this.chat.db.exec("COMMIT");
    } catch (error) {
      if (this.chat.db.isTransaction) this.chat.db.exec("ROLLBACK");
      throw error;
    }
    log(`chat db: wakes dropped ${gone.length} whose files an older release took away: ${gone.join(", ")}`);
  }

  list(): { id: string; wake: Wake }[] {
    return [...this.wakes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, wake]) => ({ id, wake }));
  }

  get(id: string): Wake | undefined {
    return this.wakes.get(id);
  }

  where(id: string): string {
    return `chat.sqlite wakes ${id}`;
  }

  put(id: string, wake: Wake): Promise<void> {
    this.kept.delete(id);
    this.wakes.set(id, wake);
    const done = this.chat.write([{ sql: "INSERT OR REPLACE INTO wakes (id, session, body) VALUES (?, ?, ?)", params: [id, wake.session, JSON.stringify(wake)] }], `wake ${id}`);
    this.move.touch(fileOf(id));
    return done;
  }

  remove(id: string): Promise<void> {
    const [waiting, held] = [this.wakes.delete(id), this.kept.delete(id)];
    if (!waiting && !held) return Promise.resolve();
    const done = this.chat.write([{ sql: "DELETE FROM wakes WHERE id = ?", params: [id] }], `wake ${id} gone`);
    this.move.touch(fileOf(id));
    return done;
  }

  hold(id: string, sent: SentWake): Promise<void> {
    const wake = this.wakes.get(id);
    if (!wake) return Promise.resolve();
    this.wakes.delete(id);
    this.kept.set(id, { wake, sent });
    const done = this.chat.write([{ sql: "INSERT OR REPLACE INTO wakes (id, session, body) VALUES (?, ?, ?)", params: [id, wake.session, JSON.stringify({ ...wake, sent })] }], `wake ${id} held`);
    this.move.touch(fileOf(id));
    return done;
  }

  held(): { id: string; wake: Wake; sent: SentWake }[] {
    return [...this.kept].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, { wake, sent }]) => ({ id, wake, sent }));
  }

  async owed(now: number): Promise<Wake[]> {
    return owedWakes([...this.list(), ...this.held()].map(({ wake }) => wake), tickedAt(this.dir), now);
  }

  get files(): WakeFiles {
    return {
      list: async () => this.list().map(({ id, wake }) => ({ file: id, wake })),
      remove: async id => void (await this.remove(id)),
    };
  }

  adopt(): void {}
}
