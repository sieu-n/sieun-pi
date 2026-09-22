import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface ReadMarker { entryId: string; timestamp: number }
interface ReadState { baseline: number; sessions: Record<string, ReadMarker> }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
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
  constructor(private readonly path: string) {}
  private async read(): Promise<ReadState> { return parse(JSON.parse(await readFile(this.path, "utf8"))); }
  private async transaction(change: (state: ReadState) => void): Promise<ReadState> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = this.path + ".lock";
    const deadline = Date.now() + 3000;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); await writeFile(lock + "/pid.tmp", String(process.pid), { mode: 0o600 }); await rename(lock + "/pid.tmp", lock + "/pid"); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        let stale = false;
        try {
          const pid = Number(await readFile(lock + "/pid", "utf8"));
          if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid read-state lock owner");
          try { process.kill(pid, 0); } catch (error) { stale = error instanceof Error && "code" in error && error.code === "ESRCH"; }
        } catch (error) {
          if (!missing(error)) throw error;
          try { stale = Date.now() - (await stat(lock)).mtimeMs > 30000; } catch (error) { if (!missing(error)) throw error; }
        }
        if (stale) {
          const recovery = lock + ".recovery";
          try {
            await mkdir(recovery, { mode: 0o700 });
            try {
              const owner = Number(await readFile(lock + "/pid", "utf8").catch(error => { if (missing(error)) return "0"; throw error; }));
              let dead = owner === 0 && Date.now() - (await stat(lock)).mtimeMs > 30000;
              if (owner > 0) try { process.kill(owner, 0); } catch (error) { dead = error instanceof Error && "code" in error && error.code === "ESRCH"; }
              if (dead) await rm(lock, { recursive: true, force: true });
            } finally { await rm(recovery, { recursive: true, force: true }); }
          } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
          if (Date.now() >= deadline) throw new Error("Browser read state recovery is busy");
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Browser read state is busy");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const temporary = this.path + "." + randomUUID();
    try {
      let state: ReadState; let before: string | undefined;
      try { state = await this.read(); before = JSON.stringify(state); }
      catch (error) { if (!missing(error)) throw error; state = { baseline: Date.now(), sessions: {} }; }
      change(state);
      const after = JSON.stringify(state);
      if (after !== before) { await writeFile(temporary, after, { mode: 0o600 }); await rename(temporary, this.path); }
      return state;
    } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }); }
  }
  async snapshot(): Promise<ReadState> {
    try { return await this.read(); }
    catch (error) { if (!missing(error)) throw error; return this.transaction(() => {}); }
  }
  async mark(sessionId: string, marker: ReadMarker): Promise<void> {
    await this.transaction(state => {
      const previous = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : undefined;
      if (!previous || previous.timestamp < marker.timestamp) Object.defineProperty(state.sessions, sessionId,
        { value: marker, enumerable: true, configurable: true, writable: true });
    });
  }
}
