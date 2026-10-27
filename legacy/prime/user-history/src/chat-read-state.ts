import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";

export interface ReadMarker { entryId: string; timestamp: number }
interface ReadState { baseline: number; sessions: Record<string, ReadMarker> }
function parse(value: unknown): ReadState {
  if (typeof value !== "object" || value === null || !("baseline" in value) || typeof value.baseline !== "number" || !Number.isFinite(value.baseline) ||
    !("sessions" in value) || typeof value.sessions !== "object" || value.sessions === null) throw new Error("Invalid browser read state");
  const sessions: Record<string, ReadMarker> = {};
  for (const [id, marker] of Object.entries(value.sessions)) {
    if (typeof marker !== "object" || marker === null || !("entryId" in marker) || typeof marker.entryId !== "string" ||
      !("timestamp" in marker) || typeof marker.timestamp !== "number" || !Number.isFinite(marker.timestamp)) throw new Error("Invalid browser read marker");
    Object.defineProperty(sessions, id, { value: { entryId: marker.entryId, timestamp: marker.timestamp }, enumerable: true, writable: true, configurable: true });
  }
  return { baseline: value.baseline, sessions };
}
export class ChatReadState {
  private readonly file: JsonFile<ReadState>;
  constructor(path: string) { this.file = { path, label: "Browser read state", parse, initial: () => ({ baseline: Date.now(), sessions: {} }) }; }
  snapshot(): Promise<ReadState> { return snapshotJsonFile(this.file); }
  async mark(sessionId: string, marker: ReadMarker): Promise<void> {
    await transactJsonFile(this.file, state => {
      const previous = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : undefined;
      if (!previous || previous.timestamp < marker.timestamp) Object.defineProperty(state.sessions, sessionId,
        { value: marker, enumerable: true, configurable: true, writable: true });
    });
  }
}
