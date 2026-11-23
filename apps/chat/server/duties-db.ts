/**
 * Where each board's duties file is kept: `<data dir>/agents/<agent>/duties.json` or, for a root chat or an agent whose folder was not
 * moved, `<data dir>/boards/<thread>/duties.json` (`DutyJsonFiles`), or chat.sqlite (chat-db.ts) once the server names the kind `duties` in
 * APPS_CHAT_DB_KINDS (`DutyFiles`), moved from those files by json-move.ts. `DutyFiles` keeps every file in memory, where the board reads it.
 *
 * A row is one duties file, keyed by its path in the data dir, with the file as boards.ts builds it in `body`: the duties, their runs, the
 * prechecks at work, the duty jobs not started yet and the check-in. A save rewrites that one row, as it rewrote that one file, and the
 * file's key order stays the code's. The precheck files in the `duties/` folder beside it (state, outputs, findings) stay files, since
 * the precheck scripts write them by path and duty jobs read them by path.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DutyFile } from "./boards.ts";
import type { ChatDb } from "./chat-db.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";
import { readJson, writeJson } from "./store.ts";

/** The folders that hold a duties file, one per agent or root chat. */
const FOLDERS = ["agents", "boards"];
const NAME = "duties.json";

/** The file a text holds, or null when it holds none, which the release before the move read as an empty one. */
function fileOf(text: string): DutyFile | null {
  try {
    const value = JSON.parse(text) as Partial<DutyFile> | null;
    return value && typeof value === "object" && Array.isArray(value.duties) ? (value as DutyFile) : null;
  } catch {
    return null;
  }
}

/** A duties file's records: its duties and their runs. */
const recordsOf = (file: DutyFile | null): number =>
  file ? file.duties.length + Object.values(file.runs ?? {}).reduce((sum, runs) => sum + (Array.isArray(runs) ? runs.length : 0), 0) : 0;

const bodyOf = (db: DatabaseSync, path: string): string | undefined =>
  (db.prepare("SELECT body FROM duties_files WHERE path = ?").get(path) as { body: string } | undefined)?.body;

export const DUTIES: JsonKind = {
  kind: "duties",
  migrations: ["CREATE TABLE duties_files (path TEXT PRIMARY KEY, body TEXT NOT NULL)"],
  files(dataDir) {
    return FOLDERS.flatMap(folder => {
      let names: string[] = [];
      try {
        names = readdirSync(join(dataDir, folder));
      } catch {
        names = [];
      }
      return names.filter(name => statSync(join(dataDir, folder, name, NAME), { throwIfNoEntry: false })?.isFile()).map(name => `${folder}/${name}/${NAME}`);
    }).sort();
  },
  load(db, path, text) {
    const file = fileOf(text);
    if (!file) return 0;
    db.prepare("INSERT OR REPLACE INTO duties_files (path, body) VALUES (?, ?)").run(path, JSON.stringify(file));
    return recordsOf(file);
  },
  records: (_path, text) => recordsOf(fileOf(text)),
  count(db, path) {
    const body = bodyOf(db, path);
    return body === undefined ? 0 : recordsOf(JSON.parse(body) as DutyFile);
  },
  dump(db, path) {
    const body = bodyOf(db, path);
    return body === undefined ? null : `${JSON.stringify(JSON.parse(body), null, 1)}\n`;
  },
};

/** The duties files the board reads and saves, keyed by their path in the data dir. */
export interface DutyStore {
  /** The file at `path` as kept, for a read that changes nothing, or undefined when there is none. */
  peek(path: string): DutyFile | undefined;
  /** A copy of the file at `path` for the caller to change and save, or an empty one. */
  get(path: string): DutyFile;
  /** Stores the file at `path`; the promise settles once it is stored. */
  save(path: string, file: DutyFile): Promise<void>;
  /** Settles once every save so far is stored. */
  written(): Promise<void>;
}

/** The duties files as JSON files, read on each use and written whole on each save. */
export class DutyJsonFiles implements DutyStore {
  constructor(private readonly dataDir: string) {}

  peek(path: string): DutyFile | undefined {
    return readJson<DutyFile | undefined>(join(this.dataDir, path), undefined);
  }

  get(path: string): DutyFile {
    return readJson<DutyFile>(join(this.dataDir, path), { duties: [], runs: {} });
  }

  async save(path: string, file: DutyFile): Promise<void> {
    writeJson(join(this.dataDir, path), file);
  }

  async written(): Promise<void> {}
}

export class DutyFiles implements DutyStore {
  /** Each duties file by its path in the data dir, as last saved. */
  private readonly files = new Map<string, DutyFile>();

  constructor(private readonly chat: ChatDb, private readonly move: JsonMove) {
    for (const row of chat.db.prepare("SELECT path, body FROM duties_files").all() as { path: string; body: string }[]) {
      this.files.set(row.path, JSON.parse(row.body) as DutyFile);
    }
  }

  /** The file at `path`, kept as saved; the caller reads it and never changes it. */
  peek(path: string): DutyFile | undefined {
    return this.files.get(path);
  }

  /** A copy of the file at `path` for the caller to change and save, or an empty one. */
  get(path: string): DutyFile {
    const file = this.files.get(path);
    return file ? structuredClone(file) : { duties: [], runs: {} };
  }

  /** Settles once every save so far is committed. */
  written(): Promise<void> {
    return this.chat.written();
  }

  /** Stores the file at `path`; the promise settles once it is committed. */
  save(path: string, file: DutyFile): Promise<void> {
    const body = JSON.stringify(file);
    this.files.set(path, JSON.parse(body) as DutyFile);
    const done = this.chat.write([{ sql: "INSERT OR REPLACE INTO duties_files (path, body) VALUES (?, ?)", params: [path, body] }], `duties ${path}`);
    this.move.touch(path);
    return done;
  }
}
