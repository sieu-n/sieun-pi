import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import type { ThreadNote } from "./shared/types.ts";

export const NOTE_MAX = 100_000;
interface NotesState { threads: Record<string, ThreadNote> }

function parse(value: unknown): NotesState {
  if (typeof value !== "object" || value === null || !("threads" in value) || typeof value.threads !== "object" || value.threads === null) throw new Error("Invalid browser notes");
  const threads: Record<string, ThreadNote> = Object.create(null);
  for (const [id, note] of Object.entries(value.threads)) {
    if (typeof note !== "object" || note === null || !("text" in note) || typeof note.text !== "string" ||
      !("updatedAt" in note) || typeof note.updatedAt !== "number") throw new Error("Invalid browser note");
    threads[id] = { text: note.text, updatedAt: note.updatedAt };
  }
  return { threads };
}

/** A person's own memo per thread, in notes.json next to the labels. The agent never reads or writes it. */
export class ChatNotes {
  private readonly file: JsonFile<NotesState>;
  constructor(path: string) { this.file = { path, label: "Browser notes", parse, initial: () => ({ threads: Object.create(null) }) }; }
  async get(id: string): Promise<ThreadNote> {
    return (await snapshotJsonFile(this.file)).threads[id] ?? { text: "", updatedAt: 0 };
  }
  /** An empty memo removes the entry. */
  async set(id: string, text: string): Promise<ThreadNote> {
    const note = { text, updatedAt: Date.now() };
    await transactJsonFile(this.file, state => {
      if (text.trim()) state.threads[id] = note;
      else delete state.threads[id];
    });
    return note;
  }
}
