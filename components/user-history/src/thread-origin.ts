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
const TYPE = /^\{"type":"([a-z_]+)"/;
/** The entry type of one JSONL line. The session writer puts `type` first, so the line is not parsed. */
function entryType(line: string): string | undefined { return TYPE.exec(line)?.[1]; }

/**
 * The origin of every listed session, for one catalog projection. Rule, in order: a thread this server created (`threads.json`, both kinds, or
 * `chats.json`) is the person's; else the session file decides; else the person's. File decisions are kept once final, so each file is read once.
 */
export class ThreadOrigins {
  private readonly decided = new Map<string, ThreadOrigin>();
  constructor(private readonly created: Pick<IdIndex, "ids">) {}

  async resolver(chats: ReadonlySet<string>): Promise<(row: { sessionId: string; sessionFile?: string }) => ThreadOrigin> {
    const own = new Set(await this.created.ids().catch(() => []));
    return row => {
      if (own.has(row.sessionId) || chats.has(row.sessionId)) return "user";
      if (!row.sessionFile) return "user";
      const known = this.decided.get(row.sessionFile);
      if (known) return known;
      const { origin, final } = fileOrigin(row.sessionFile);
      if (final) this.decided.set(row.sessionFile, origin);
      return origin;
    };
  }
}
