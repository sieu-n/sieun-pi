/**
 * Where the board wakes that have not gone out are kept: one file per wake in `<data dir>/wakes/` (`FolderWakes`), or chat.sqlite
 * (chat-db.ts) once the server names the kind `wakes` in APPS_CHAT_DB_KINDS (`WakeRows`), moved from those files by json-move.ts. The
 * ticker (wakes.ts), the board and Remind me read them through `WakeStore`. The ticker's stamps `.ticked` and `.kinds` stay in the folder.
 *
 * A wake's id is its file's name without `.json`, such as `<thread>-<conversation>-time-1796088600` or `later-<agent>-<room>-<post>`, and a
 * row's `body` holds the wake as its file did.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { owedWakes, pendingWakes, TICKED, type WakeFiles } from "../../../legacy/prime/user-history/src/wakes.ts";
import type { ChatDb } from "./chat-db.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";
import { readJson, writeJson } from "./store.ts";
import { adoptOldWakes, parseArm, parseWake, type Wake } from "./wakes.ts";

const DIR = "wakes";
const FILE = /^wakes\/([\w.-]+)\.json$/;
const fileOf = (id: string): string => `${DIR}/${id}.json`;
const idOf = (file: string): string | undefined => FILE.exec(file)?.[1];

/** The wakes the ticker, the board and Remind me read and set. */
export interface WakeStore {
  /** The folder of the ticker's stamps. */
  readonly dir: string;
  /** Each wake that has not gone out, with its id, in id order as the ticker reads them. */
  list(): { id: string; wake: Wake }[];
  get(id: string): Wake | undefined;
  /** Sets the wake with this id, in place of one set before under it; settles once it is stored. */
  put(id: string, wake: Wake): Promise<void>;
  /** Takes the wake away; one that is not there writes nothing. */
  remove(id: string): Promise<void>;
  /** Where a wake is kept, which board.wake shows the thread that set it. */
  where(id: string): string;
  /** The wakes the ticker owes at `now` (`owedWakes`). */
  owed(now: number): Promise<Wake[]>;
  /** The ticker's source, or undefined for the wake folder itself. */
  readonly files: WakeFiles | undefined;
  /** Runs before the ticker starts. */
  adopt(log: (line: string) => void): void;
}

/** The wakes as one JSON file each in the folder, as the legacy chat keeps them. */
export class FolderWakes implements WakeStore {
  readonly files = undefined;

  constructor(readonly dir: string) {}

  list(): { id: string; wake: Wake }[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir).filter(name => name.endsWith(".json")).sort(); } catch { names = []; }
    return names.flatMap(name => {
      const wake = parseWake(readJson<unknown>(join(this.dir, name), null));
      return wake ? [{ id: name.slice(0, -5), wake }] : [];
    });
  }

  get(id: string): Wake | undefined {
    return parseWake(readJson<unknown>(this.where(id), null)) ?? undefined;
  }

  async put(id: string, wake: Wake): Promise<void> {
    writeJson(this.where(id), wake);
  }

  async remove(id: string): Promise<void> {
    rmSync(this.where(id), { force: true });
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
 * The wakes a chat server still owes at `now`, read without the server, for a duty precheck that runs beside it, such as
 * scripts/duties/fable-sweep.ts. A precheck inherits the server's environment, so APPS_CHAT_DB_KINDS says where the wakes are.
 */
export async function owedWakesOf(dataDir: string, now: number, kinds = process.env.APPS_CHAT_DB_KINDS ?? ""): Promise<Wake[]> {
  if (!kinds.split(",").map(kind => kind.trim()).includes(WAKES.kind)) return pendingWakes(join(dataDir, DIR), now);
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

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove, readonly dir: string, log: (line: string) => void = () => {}) {
    for (const row of chat.db.prepare("SELECT id, body FROM wakes ORDER BY id").all() as { id: string; body: string }[]) {
      const wake = parseWake(JSON.parse(row.body));
      if (wake) this.wakes.set(row.id, wake);
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
    this.wakes.set(id, wake);
    const done = this.chat.write([{ sql: "INSERT OR REPLACE INTO wakes (id, session, body) VALUES (?, ?, ?)", params: [id, wake.session, JSON.stringify(wake)] }], `wake ${id}`);
    this.move.touch(fileOf(id));
    return done;
  }

  remove(id: string): Promise<void> {
    if (!this.wakes.delete(id)) return Promise.resolve();
    const done = this.chat.write([{ sql: "DELETE FROM wakes WHERE id = ?", params: [id] }], `wake ${id} gone`);
    this.move.touch(fileOf(id));
    return done;
  }

  async owed(now: number): Promise<Wake[]> {
    return owedWakes(this.list().map(({ wake }) => wake), tickedAt(this.dir), now);
  }

  get files(): WakeFiles {
    return {
      list: async () => this.list().map(({ id, wake }) => ({ file: id, wake })),
      remove: async id => void (await this.remove(id)),
    };
  }

  adopt(): void {}
}
