import { open } from "node:fs/promises";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "prime-agent";

/**
 * How much of a session file a thread opens with. The feed draws every message the hub holds (Thread.svelte `turns`, chat-feed.ts `chatFeed`)
 * and marks each compaction with "Older messages were summarized to free space" (chat-feed.ts `linesOf`). Frontend bro's 64 MB transcript had
 * 10 compactions across 10,854 feed messages, about 1,000 per compaction, so 1,000 messages is one compaction's worth of the busiest chat.
 * 8 MiB caps the bytes when the messages are large: the VP chat averages 19 KB per message, and 64 MB took 1.28 s to parse.
 */
export const TAIL_MESSAGES = 1000;
export const TAIL_BYTES = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const HEADER_BYTES = 64 * 1024;

/** The entries the feed draws (`historyMessages`). */
const shown = (entry: SessionEntry): boolean => entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction";

export interface BranchTail {
  sessionId: string;
  /** The last entries of the current branch, oldest first. */
  entries: SessionEntry[];
  /** The tail reached the first entry, so nothing older is left in the file. */
  whole: boolean;
}

/**
 * The end of a session's current branch, read backwards from the end of the file in 1 MiB chunks: the leaf is the last entry, as SessionManager
 * takes it, and each entry's `parentId` leads to the one before. Reading stops once `limits.messages` feed entries are found, the first entry is
 * reached, or `limits.bytes` were read. Undefined for a file a full open must migrate (another version) or whose header does not fit 64 KiB.
 */
export async function readBranchTail(file: string, limits = { messages: TAIL_MESSAGES, bytes: TAIL_BYTES }): Promise<BranchTail | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, HEADER_BYTES));
    await handle.read(head, 0, head.length, 0);
    const headerEnd = head.indexOf(0x0a);
    if (headerEnd < 0) return undefined;
    const header = JSON.parse(head.subarray(0, headerEnd).toString("utf8")) as { type?: unknown; id?: unknown; version?: unknown };
    if (header.type !== "session" || typeof header.id !== "string" || header.version !== CURRENT_SESSION_VERSION) return undefined;

    const byId = new Map<string, SessionEntry>();
    const branch: SessionEntry[] = [];
    let cursor: string | null | undefined;
    let found = 0;
    let read = 0;
    let end = size;
    let carry = Buffer.alloc(0);
    const first = headerEnd + 1;
    while (end > first && cursor !== null && found < limits.messages && !(read >= limits.bytes && found > 0)) {
      const start = Math.max(first, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      read += chunk.length;
      end = start;
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // The bytes before the first newline may be the end of a line that starts in the next chunk back.
      const cut = start === first ? -1 : data.indexOf(0x0a);
      if (start !== first && cut < 0) { carry = data; continue; }
      carry = cut < 0 ? Buffer.alloc(0) : data.subarray(0, cut);
      const lines = data.subarray(cut + 1).toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        if (!line) continue;
        let entry: SessionEntry;
        try { entry = JSON.parse(line) as SessionEntry; } catch { continue; }
        if (typeof entry.id !== "string") continue;
        byId.set(entry.id, entry);
        if (cursor === undefined) cursor = entry.id;
      }
      for (let entry = cursor ? byId.get(cursor) : undefined; entry && found < limits.messages; entry = cursor ? byId.get(cursor) : undefined) {
        branch.push(entry);
        if (shown(entry)) found++;
        cursor = entry.parentId;
      }
    }
    return { sessionId: header.id, entries: branch.reverse(), whole: cursor === null || (cursor === undefined && end <= first) };
  } finally { await handle.close(); }
}
