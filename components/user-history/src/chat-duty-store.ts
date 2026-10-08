import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
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
