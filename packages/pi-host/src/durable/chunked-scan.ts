/**
 * Entry scans that give pi-host's loop a turn between small reads. pi-durable reads a conversation's context in pages of 256 entries
 * (`scanRange`), and node:sqlite reads and parses each page in one synchronous call, whose promise resolves as a microtask, so a whole
 * context read runs in one loop turn. On 11-23 comm thread 5d50e997's root held 707 entries and 19.7 MB with no compaction; one page took
 * 45 to 120 ms and a whole read 100 to 300 ms of the loop on a copy rig, several times per turn (~/work/pi-host-stalls/l-untracked/report.md).
 *
 * A scan of more than CHUNK entries here reads them CHUNK at a time through the same storage call, each chunk from the cursor the last one
 * returned, and gives the loop a turn between chunks once 10 ms of work ran (`loopSlices`). The page it returns holds the same entries and
 * the same next cursor as one read: a chunk's cursor is its last entry's id, and the last chunk looks one entry past the page, as the page does.
 */
import type { Storage } from "@earendil-works/pi-durable";
import { loopSlices } from "./rlm.ts";

/** Entries per read: 32 of 5d50e997's average 28 KB is about 0.9 MB of JSON, a few ms to read and parse. */
const CHUNK = 32;

type Scan = Storage["scanEntries"];

/** `storage` with its `scanEntries` reading at most CHUNK entries per synchronous call; every other method stays as it was. */
export function chunkScans<T extends { scanEntries: Scan }>(storage: T): T {
  const scan: Scan = storage.scanEntries.bind(storage);
  storage.scanEntries = async (query, limit, cursor, context) => {
    if (limit <= CHUNK) return scan(query, limit, cursor, context);
    const next = loopSlices();
    const items: Awaited<ReturnType<Scan>>["items"][number][] = [];
    let at = cursor;
    for (;;) {
      const page = await scan(query, Math.min(CHUNK, limit - items.length), at, context);
      items.push(...page.items);
      at = page.next;
      if (at === undefined) return { items };
      if (items.length >= limit) return { items, next: at };
      await next();
    }
  };
  return storage;
}
