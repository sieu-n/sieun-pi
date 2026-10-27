import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tailLines } from "./cut-end.ts";
import { missing, readJsonFile, transactJsonFile, withFileLock, type JsonFile } from "./locked-json.ts";
import { parseDutyFile, type Duty, type DutyFile, type DutyRunRecord } from "./shared/chat-duties.ts";

const sessionIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * The duties, one file per chat at `<dataDir>/duties/<chatId>.json` through locked-json, and each chat's run history appended to
 * `<chatId>.runs.jsonl`. Every write of the runs file takes its lock (`<chatId>.runs.jsonl.lock`), so a rewrite of one record (`updateRun`,
 * `remove`) never drops a record appended meanwhile. Precheck state and saved outputs live under `<dataDir>/duties/<chatId>/`.
 */
export class DutyStore {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = join(dataDir, "duties"); }

  private check(chatId: string): string {
    if (!sessionIdPattern.test(chatId)) throw new Error(`Not a session id: ${chatId}`);
    return chatId;
  }
  private runsFile(chatId: string): string { return join(this.dir, this.check(chatId) + ".runs.jsonl"); }
  private lockRuns<R>(chatId: string, task: (path: string) => Promise<R>): Promise<R> {
    const path = this.runsFile(chatId);
    return withFileLock(path, "Duty runs", () => task(path));
  }
  private file(chatId: string): JsonFile<DutyFile> {
    return { path: join(this.dir, this.check(chatId) + ".json"), label: "Chat duties", parse: parseDutyFile, initial: () => ({ version: 1, duties: [] }) };
  }
  /** The folder for a chat's precheck state and saved outputs. */
  chatDir(chatId: string): string { return join(this.dir, this.check(chatId)); }

  /** The chats that have a duties file. */
  async chats(): Promise<string[]> {
    try { return (await readdir(this.dir)).filter(name => name.endsWith(".json")).map(name => name.slice(0, -".json".length)).filter(id => sessionIdPattern.test(id)); }
    catch (error) { if (missing(error)) return []; throw error; }
  }

  async list(chatId: string): Promise<Duty[]> {
    try { return (await readJsonFile(this.file(chatId))).duties; }
    catch (error) { if (missing(error)) return []; throw error; }
  }

  /** Changes the chat's duties under the lock; `change` edits the list in place and returns its result. */
  async update<R>(chatId: string, change: (duties: Duty[]) => R): Promise<R> {
    return (await transactJsonFile(this.file(chatId), state => change(state.duties))).result;
  }

  /** Changes the whole duties file under the lock (the check-in duty's run state lives next to the list). */
  async updateFile<R>(chatId: string, change: (state: DutyFile) => R): Promise<R> {
    return (await transactJsonFile(this.file(chatId), change)).result;
  }

  async read(chatId: string): Promise<DutyFile> {
    try { return await readJsonFile(this.file(chatId)); }
    catch (error) { if (missing(error)) return { version: 1, duties: [] }; throw error; }
  }

  /**
   * Deletes a duty for good: its definition, its run records and its saved outputs and state (`<dutyId>-*.json`, `<dutyId>.*.json`). Returns
   * whether anything was there, so a second call returns false.
   */
  async remove(chatId: string, dutyId: string): Promise<boolean> {
    const defined = await this.update(chatId, duties => {
      const at = duties.findIndex(duty => duty.id === dutyId);
      if (at >= 0) duties.splice(at, 1);
      return at >= 0;
    });
    const ran = await this.lockRuns(chatId, async runsFile => {
      let found = false;
      const read = await readRunLines(runsFile);
      const lines = read.lines.filter(line => {
        try { if ((JSON.parse(line) as { duty?: unknown }).duty === dutyId) { found = true; return false; } } catch { /* an unreadable line stays */ }
        return true;
      });
      if (found) {
        await replaceLines(runsFile, lines);
        await rewroteRuns(runsFile, read.key, records => records.filter(entry => entry.duty !== dutyId));
      }
      return found;
    });
    const files = await readdir(this.chatDir(chatId)).catch(error => { if (missing(error)) return [] as string[]; throw error; });
    const own = files.filter(name => name.startsWith(dutyId + "-") || name.startsWith(dutyId + "."));
    for (const name of own) await rm(join(this.chatDir(chatId), name), { force: true });
    return defined || ran || own.length > 0;
  }

  async appendRun(chatId: string, record: DutyRunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.lockRuns(chatId, path => appendFile(path, JSON.stringify(record) + "\n", { mode: 0o600 }));
  }

  /**
   * Changes one run record, the one of `duty` at `at`, in place under the runs file's lock and rewrites the file; false when no record matches.
   * The duty runner writes a run's after-job measure with it.
   */
  async updateRun(chatId: string, duty: string, at: number, change: (record: DutyRunRecord) => void): Promise<boolean> {
    return this.lockRuns(chatId, async path => {
      const read = await readRunLines(path);
      const { lines } = read;
      for (let index = lines.length - 1; index >= 0; index--) {
        let record: DutyRunRecord;
        try { record = JSON.parse(lines[index]!) as DutyRunRecord; } catch { continue; }
        if (record.duty !== duty || record.at !== at) continue;
        change(record);
        lines[index] = JSON.stringify(record);
        await replaceLines(path, lines);
        await rewroteRuns(path, read.key, records => records.map(entry => entry.duty === duty && entry.at === at ? record : entry));
        return true;
      }
      return false;
    });
  }

  /**
   * The chat's newest run record of `duty`, from the runs file's last NEWEST_RUN_TAIL_BYTES, else from the whole file (`runs`). At the chat's
   * start at 05:53:51Z on 10-26 `Chats.load` read each chat's last check-in through `runs`, which parsed the 16 chats' whole runs files (23.8 MB, 9,182
   * records, 0.59 to 0.91 s on a quiet process), and the owner's api/threads/01a15427/duties read waited on it 1.9 s, which d7 counted dirty;
   * the tail reads take 39 to 52 ms for all 16.
   */
  async newestRun(chatId: string, duty: string): Promise<DutyRunRecord | undefined> {
    const key = `"duty":${JSON.stringify(duty)}`;
    for (const line of (await tailLines(this.runsFile(chatId), NEWEST_RUN_TAIL_BYTES)).reverse()) {
      if (!line.includes(key)) continue;
      try { const record = JSON.parse(line) as DutyRunRecord; if (record.duty === duty) return record; } catch { continue; }
    }
    return (await this.runs(chatId)).find(run => run.duty === duty);
  }

  /**
   * The chat's run records, newest first; a line that does not parse is skipped. A file whose inode, size and mtime match its last parse gives
   * the records of that parse (`parsedRuns`), so callers must not change them. A file that only grew since then parses only its new lines, and
   * this store's own rewrites (`updateRun`, `remove`) change the parse in place: at 06:58Z on 10-27 the owner's read of Crawler VP's duties
   * waited 1.7 s on a parse of its whole 7.8 MB runs file, which took 99 to 141 ms on a quiet copy, and the file changes with each of its runs.
   */
  async runs(chatId: string): Promise<DutyRunRecord[]> {
    const path = this.runsFile(chatId);
    const info = await statRuns(path);
    if (!info) { parsedRuns.delete(path); return []; }
    const key = runsKey(info);
    let parsed = parsedRuns.get(path);
    if (parsed?.key !== key) {
      const before = parsed;
      const records = before && before.ino === info.ino && info.size > before.size
        ? appendedRuns(path, before.size, info.size).then(async added => added ? [...added, ...await before.records] : parseRuns(path))
        : parseRuns(path);
      const entry = { key, ino: info.ino, size: info.size, records };
      parsedRuns.set(path, entry);
      entry.records.catch(() => { if (parsedRuns.get(path) === entry) parsedRuns.delete(path); });
      parsed = entry;
    }
    return [...await parsed.records];
  }
}

/** The tail `newestRun` reads first: the newest check-in sat at most 89 KB from the end of each of the 133 runs files that held one on 10-26. */
const NEWEST_RUN_TAIL_BYTES = 256 * 1024;

/**
 * Each runs file's records as last parsed, by path, with the inode, size and mtime its stat gave before the read. On a scratch serve with a
 * copy of the live data on 10-19, each 30 s tick of the duties and the check-ins read the runs files about 30 times (3,830 records, 10 MB, 3.4 MB
 * for Crawler VP alone), and those parses held the main thread for 0.9 to 1.2 s in one stretch every tick.
 */
const parsedRuns = new Map<string, { key: string; ino: bigint; size: bigint; records: Promise<readonly DutyRunRecord[]> }>();
const runsKey = (info: { ino: bigint; size: bigint; mtimeNs: bigint }): string => `${info.ino}:${info.size}:${info.mtimeNs}`;
const statRuns = (path: string) => stat(path, { bigint: true }).catch(error => { if (missing(error)) return null; throw error; });

/** The records appended to a runs file in [from, to), newest first; null when byte from - 1 is no line end, so the file did not only grow. */
async function appendedRuns(path: string, from: bigint, to: bigint): Promise<DutyRunRecord[] | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Number(to - from) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Number(from) - 1);
    if (bytesRead !== buffer.length || buffer[0] !== 0x0a) return null;
    const records: DutyRunRecord[] = [];
    for (const line of buffer.subarray(1).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as DutyRunRecord); } catch { continue; }
    }
    return records.reverse();
  } finally { await handle.close(); }
}

/** A runs file's lines with the stat key from before the read, so a rewrite can tell whether the parse it changes was of these lines. */
async function readRunLines(path: string): Promise<{ key: string | null; lines: string[] }> {
  const info = await statRuns(path);
  return { key: info ? runsKey(info) : null, lines: await readLines(path) };
}

/** After a rewrite of `path` whose lines read at `before`, changes the parse of those lines the same way, under the rewritten file's key. */
async function rewroteRuns(path: string, before: string | null, change: (records: readonly DutyRunRecord[]) => DutyRunRecord[]): Promise<void> {
  const parsed = parsedRuns.get(path);
  const info = await statRuns(path);
  if (!parsed || parsed.key !== before || !info) { parsedRuns.delete(path); return; }
  const entry = { key: runsKey(info), ino: info.ino, size: info.size, records: parsed.records.then(change) };
  parsedRuns.set(path, entry);
  entry.records.catch(() => { if (parsedRuns.get(path) === entry) parsedRuns.delete(path); });
}

async function parseRuns(path: string): Promise<readonly DutyRunRecord[]> {
  const records: DutyRunRecord[] = [];
  for (const line of await readLines(path)) {
    try { records.push(JSON.parse(line) as DutyRunRecord); } catch { continue; }
  }
  return records.reverse();
}

/** The non-empty lines of a JSONL file; none when it is missing. */
async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(error => { if (missing(error)) return ""; throw error; });
  return text.split("\n").filter(line => line.trim());
}

async function replaceLines(path: string, lines: readonly string[]): Promise<void> {
  await writeFile(path + ".tmp", lines.map(line => line + "\n").join(""), { mode: 0o600 });
  await rename(path + ".tmp", path);
}
