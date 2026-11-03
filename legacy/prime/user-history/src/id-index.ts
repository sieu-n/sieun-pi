import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

/** `at`: when each id was added, in epoch ms; ids added before 10-19 have none. */
interface IdIndexState { ids: string[]; at?: Record<string, number> }

/** A `{ ids }` file under the data dir, newest first, through locked-json: `chats.json` (the chats) and `threads.json` (every thread this server created). */
export class IdIndex {
  private readonly file: JsonFile<IdIndexState>;
  /** The ids as this process last read or wrote them (`known`), and a count of its writes, so a read that a write overtook is not kept. */
  private last: ReadonlySet<string> | undefined;
  private writes = 0;
  constructor(path: string, label: string) {
    this.file = { path, label, initial: () => ({ ids: [] }), parse(value: unknown): IdIndexState {
      if (typeof value !== "object" || value === null || !("ids" in value) || !Array.isArray(value.ids)) throw new Error(`Invalid ${label}`);
      const at = "at" in value && typeof value.at === "object" && value.at !== null ? Object.fromEntries(Object.entries(value.at).filter(([, when]) => typeof when === "number")) : undefined;
      return { ids: value.ids.filter((id): id is string => typeof id === "string"), ...at ? { at } : {} };
    } };
  }
  async ids(): Promise<string[]> {
    const writes = this.writes;
    const { ids } = await snapshotJsonFile(this.file);
    if (writes === this.writes) this.last = new Set(ids);
    return ids;
  }
  /**
   * The ids from this process's last read or write of the file, with no file step; undefined before the first. Only the chat service writes
   * these files, so for the one instance it writes through this is the file. An owner send asks it in place of a read: on 11-03 each file step
   * of a send waited a turn of the chat service's main thread, 15 to 30 ms each at box load 430, and a follow-up to a Mac chat read 1.8 round trips.
   */
  known(): ReadonlySet<string> | undefined { return this.last; }
  async add(id: string, now = Date.now()): Promise<void> {
    await this.write(state => { if (!state.ids.includes(id)) { state.ids.unshift(id); state.at = { ...state.at, [id]: now }; } });
  }
  async forget(id: string): Promise<void> {
    await this.write(state => {
      state.ids = state.ids.filter(candidate => candidate !== id);
      if (state.at) { const { [id]: _gone, ...rest } = state.at; state.at = rest; }
    });
  }
  /** The count moves at the start and the end of each write, so a read that overlapped any part of one keeps nothing. */
  private async write(change: (state: IdIndexState) => void): Promise<void> {
    this.writes++;
    try { this.last = new Set((await transactJsonFile(this.file, change)).state.ids); }
    catch (error) { this.last = undefined; throw error; }
    finally { this.writes++; }
  }
}
