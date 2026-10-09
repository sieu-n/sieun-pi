import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { missing, readJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { parseDutyFile, type Duty, type DutyFile, type DutyRunRecord } from "./shared/chat-duties.ts";

const sessionIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * The duties, one file per chat at `<dataDir>/duties/<chatId>.json` through locked-json, and each chat's run history appended to
 * `<chatId>.runs.jsonl`. Precheck state and saved outputs live under `<dataDir>/duties/<chatId>/`.
 */
export class DutyStore {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = join(dataDir, "duties"); }

  private check(chatId: string): string {
    if (!sessionIdPattern.test(chatId)) throw new Error(`Not a session id: ${chatId}`);
    return chatId;
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
    const runsFile = join(this.dir, this.check(chatId) + ".runs.jsonl");
    let ran = false;
    const text = await readFile(runsFile, "utf8").catch(error => { if (missing(error)) return ""; throw error; });
    const kept = text.split("\n").filter(line => {
      if (!line.trim()) return false;
      try { if ((JSON.parse(line) as { duty?: unknown }).duty === dutyId) { ran = true; return false; } } catch { /* an unreadable line stays */ }
      return true;
    });
    if (ran) {
      await writeFile(runsFile + ".tmp", kept.map(line => line + "\n").join(""), { mode: 0o600 });
      await rename(runsFile + ".tmp", runsFile);
    }
    const files = await readdir(this.chatDir(chatId)).catch(error => { if (missing(error)) return [] as string[]; throw error; });
    const own = files.filter(name => name.startsWith(dutyId + "-") || name.startsWith(dutyId + "."));
    for (const name of own) await rm(join(this.chatDir(chatId), name), { force: true });
    return defined || ran || own.length > 0;
  }

  async appendRun(chatId: string, record: DutyRunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(join(this.dir, this.check(chatId) + ".runs.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  /** The chat's run records, newest first; a line that does not parse is skipped. */
  async runs(chatId: string): Promise<DutyRunRecord[]> {
    let text: string;
    try { text = await readFile(join(this.dir, this.check(chatId) + ".runs.jsonl"), "utf8"); }
    catch (error) { if (missing(error)) return []; throw error; }
    const records: DutyRunRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as DutyRunRecord); } catch { continue; }
    }
    return records.reverse();
  }
}
