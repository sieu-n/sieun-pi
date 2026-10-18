import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

interface IdIndexState { ids: string[] }

/** A `{ ids }` file under the data dir, newest first, through locked-json: `chats.json` (the chats) and `threads.json` (every thread this server created). */
export class IdIndex {
  private readonly file: JsonFile<IdIndexState>;
  constructor(path: string, label: string) {
    this.file = { path, label, initial: () => ({ ids: [] }), parse(value: unknown): IdIndexState {
      if (typeof value !== "object" || value === null || !("ids" in value) || !Array.isArray(value.ids)) throw new Error(`Invalid ${label}`);
      return { ids: value.ids.filter((id): id is string => typeof id === "string") };
    } };
  }
  async ids(): Promise<string[]> { return (await snapshotJsonFile(this.file)).ids; }
  async add(id: string): Promise<void> {
    await transactJsonFile(this.file, state => { if (!state.ids.includes(id)) state.ids.unshift(id); });
  }
  async forget(id: string): Promise<void> {
    await transactJsonFile(this.file, state => { state.ids = state.ids.filter(candidate => candidate !== id); });
  }
}
