import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { IdIndex } from "./id-index.ts";

export type ThreadOrigin = "user" | "agent";

/**
 * Who created a session, read from the head of its file. The daemon records no creator, but a `create` request that carries a name writes
 * `session_info` before `session_state` (daemon-mode addRuntime: setStateSessionName, then appendSessionState active), and `rlm.create_session`
 * is the caller that names a root at create. A person's session is named later, if ever, so its first `session_info` follows `session_state`.
 * Files from before `session_state` existed fall back to the parent's rule: the name precedes the first message. `final` is false while the
 * head has neither entry yet (the daemon is still writing it), so the caller asks again next time.
 */
export function fileOrigin(sessionFile: string): { origin: ThreadOrigin; final: boolean } {
  let fd: number;
  try { fd = openSync(sessionFile, "r"); } catch { return { origin: "user", final: false }; }
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(64 * 1024);
    let pending = "";
    let offset = 0;
    let named = false;
    while (offset < HEAD_SCAN_BYTES) {
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      offset += read;
      pending += decoder.write(chunk.subarray(0, read));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        const type = entryType(line);
        if (type === "session_info") named = true;
        else if (type === "session_state" || type === "message") return { origin: named ? "agent" : "user", final: true };
      }
    }
    return { origin: named ? "agent" : "user", final: false };
  } finally { closeSync(fd); }
}

const HEAD_SCAN_BYTES = 4 * 1024 * 1024;
/** A listed session as the resolver reads it: its file, and the daemon row's fields that change when the file is written. */
type OriginRow = { sessionId: string; sessionFile?: string; modified?: string; messageCount?: number; lastActivityAt?: string };
const TYPE = /^\{"type":"([a-z_]+)"/;
/** The entry type of one JSONL line. The session writer puts `type` first, so the line is not parsed. */
function entryType(line: string): string | undefined { return TYPE.exec(line)?.[1]; }

/**
 * The origin of every listed session, for one catalog projection. Rule, in order: a clean-room test chat (`clean-room-chats.json`) is an
 * agent's, because a clean-room job opened it through the person's route; a thread this server created (`threads.json`, both kinds, or
 * `chats.json`) is the person's; else the session file decides; else the person's. File decisions are kept once final, so each file is read once.
 * An agent-created row stays out of the owner's sidebar and its For you count until he turns on "Show agent-created": on 10-18 he saw the r3c
 * chats "LinkedIn index gaps" and "Facebook index gaps" there, answered one's For you ask and typed into it, which voided the run.
 */
export class ThreadOrigins {
  private readonly decided = new Map<string, ThreadOrigin>();
  /**
   * Files whose head did not decide yet (still being written, or not on this disk, as the other box's rows with no local copy), with the row's
   * write key and the answer then: one is read again only once its row changes. On 10-18 opening them again on every projection took 1.1 s of
   * every 20 s of the chat service's main thread.
   */
  private readonly undecided = new Map<string, { key: string; origin: ThreadOrigin }>();
  constructor(private readonly created: Pick<IdIndex, "ids">, private readonly cleanRoom?: Pick<IdIndex, "ids">) {}

  async resolver(chats: ReadonlySet<string>): Promise<(row: OriginRow) => ThreadOrigin> {
    const own = new Set(await this.created.ids().catch(() => []));
    const tests = new Set(await this.cleanRoom?.ids().catch(() => []) ?? []);
    return row => {
      if (tests.has(row.sessionId)) return "agent";
      if (own.has(row.sessionId) || chats.has(row.sessionId)) return "user";
      if (!row.sessionFile) return "user";
      const read = this.byRow.get(row);
      if (read) return read;
      const origin = this.fileDecides(row, row.sessionFile);
      this.byRow.set(row, origin);
      return origin;
    };
  }

  /**
   * What the file said for each daemon row object, so a row listed unchanged is not looked up by path again: a roster update replaces only the
   * rows it changed, and the path lookups and key strings of every row (the Mac's 3,064 among them) were 3.7 of 54 ms of a projection's own
   * code on a bench over a copy of the live rows on 10-19.
   */
  private readonly byRow = new WeakMap<OriginRow, ThreadOrigin>();
  /** Each session file whose head decided, for the stop to save (chat-catalog.ts `HEADS_FILE`). */
  decisions(): ReadonlyMap<string, ThreadOrigin> { return this.decided; }
  /** Decisions a last run saved: a decided head never changes, since a session file only grows at its end. */
  take(saved: Iterable<readonly [string, ThreadOrigin]>): void { for (const [file, origin] of saved) if (!this.decided.has(file)) this.decided.set(file, origin); }
  private fileDecides(row: OriginRow, file: string): ThreadOrigin {
    const known = this.decided.get(file);
    if (known) return known;
    const key = `${row.modified ?? ""}|${row.messageCount ?? ""}|${row.lastActivityAt ?? ""}`;
    const pending = this.undecided.get(file);
    if (pending?.key === key) return pending.origin;
    const { origin, final } = fileOrigin(file);
    if (final) { this.decided.set(file, origin); this.undecided.delete(file); }
    else this.undecided.set(file, { key, origin });
    return origin;
  }
}
