import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

/** `at`: when each id was added, in epoch ms; ids added before 10-19 have none. */
interface IdIndexState { ids: string[]; at?: Record<string, number> }

/** A `{ ids }` file under the data dir, newest first, through locked-json: `chats.json` (the chats) and `threads.json` (every thread this server created). */
export class IdIndex {
  private readonly file: JsonFile<IdIndexState>;
  constructor(path: string, label: string) {
    this.file = { path, label, initial: () => ({ ids: [] }), parse(value: unknown): IdIndexState {
      if (typeof value !== "object" || value === null || !("ids" in value) || !Array.isArray(value.ids)) throw new Error(`Invalid ${label}`);
      const at = "at" in value && typeof value.at === "object" && value.at !== null ? Object.fromEntries(Object.entries(value.at).filter(([, when]) => typeof when === "number")) : undefined;
      return { ids: value.ids.filter((id): id is string => typeof id === "string"), ...at ? { at } : {} };
    } };
  }
  async ids(): Promise<string[]> { return (await snapshotJsonFile(this.file)).ids; }
  async add(id: string, now = Date.now()): Promise<void> {
    await transactJsonFile(this.file, state => { if (!state.ids.includes(id)) { state.ids.unshift(id); state.at = { ...state.at, [id]: now }; } });
  }
  async forget(id: string): Promise<void> {
    await transactJsonFile(this.file, state => {
      state.ids = state.ids.filter(candidate => candidate !== id);
      if (state.at) { const { [id]: _gone, ...rest } = state.at; state.at = rest; }
    });
  }
}
