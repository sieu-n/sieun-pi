import { stat } from "node:fs/promises";
import { CUT_CONFIRM_BYTES, CUT_TAIL_BYTES } from "../../src/cut-end.ts";
import { mirrorPath } from "../../src/host-catalogs.ts";
import { hostFileStamp, loadHosts, readHostFile } from "../../src/hosts.ts";
import { OPEN, walk } from "../../src/checkin-steps.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { fileSlotPark, poolPark, type PoolQueue, primePark, readFileSlotPark, type SlotPark } from "../../src/slot-park.ts";
import { stepSessions } from "../../src/unmoved-steps.ts";
import { treeSessions } from "../../src/wakes.ts";

/** A row of a box's catalog copy (`catalogCopyFiles`) as this read uses it; Prime's park fields go to `primePark` as they are. */
export type CopyRow = { sessionId: string; sessionFile?: string; parentSessionId?: string; activity?: string; lastActivityAt?: string };
/** One box's catalog copy: `host` null is this box's own, whose sessions `poolWaitingOwners` reads from disk. */
export type HostCopy = { host: string | null; rows: readonly CopyRow[] };
/** The last `bytes` of a file on another box, as lines, read through its relay. */
export type ReadTail = (host: string, path: string, bytes: number) => Promise<string[]>;

/** No other box's pi-pool queue is read here, so a park is open only while Prime holds it (`label`) or its resumeAt is still ahead (`poolPark`). */
const NO_POOL: PoolQueue = { queued: new Map(), working: new Set() };
const ms = (iso: string | undefined): number => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : 0; };

/** `ReadTail` through each box's relay (`readHostFile` from the size `hostFileStamp` gives); a box in `away` is not dialed and reads nothing. */
export function relayTail(away: ReadonlySet<string>): ReadTail {
  const registry = loadHosts().catch(() => null);
  return async (name, path, bytes) => {
    const host = (await registry)?.hosts.find(each => each.name === name);
    if (!host || away.has(name)) throw new Error(`${name} is not reachable`);
    const size = Number((await hostFileStamp(host, path)).split(" ")[0]);
    const lines = (await readHostFile(host, path, { from: Math.max(0, size - bytes) })).bytes.toString("utf8").split("\n");
    return size > bytes ? lines.slice(1) : lines;
  };
}

/**
 * The open wait of a session on another box: Prime's park on its row (`primePark`), else the park its transcript ends on (`fileSlotPark`). The
 * chat service copies another box's transcript only when someone reads it (`mirrorPath`), so a copy that is missing or older than the row's
 * last activity is read from the box's relay instead: at 14:55Z on 10-29 this box held no copy of 8 of the 39 sessions below designer bro's
 * chat, the jobs new campaign steps and first load styles and their builders, all started after 14:40Z.
 */
async function awayPark(host: string, row: CopyRow, readTail: ReadTail | null): Promise<SlotPark | undefined> {
  const prime = primePark(row);
  if (prime || !row.sessionFile) return prime;
  const copy = mirrorPath({ name: host }, row.sessionFile);
  const copied = await stat(copy).catch(() => null);
  if (readTail && (!copied || copied.mtimeMs < ms(row.lastActivityAt))) {
    try {
      for (const bytes of [CUT_TAIL_BYTES, CUT_CONFIRM_BYTES]) {
        const read = fileSlotPark(await readTail(host, row.sessionFile, bytes));
        if (read.complete || bytes === CUT_CONFIRM_BYTES) return read.park;
      }
    } catch { /* the box did not answer, so the copy this box has is all there is */ }
  }
  return (await readFileSlotPark(copy)).park;
}

/**
 * The step owners that run on another box and wait there for a slot or the provider's usage reset, they or a session below them at any depth
 * (`parentSessionId` in the catalog copies, `awayPark`). `poolWaitingOwners` reads only this box's disk, so from 12:43Z to 14:45Z on 10-29 d9
 * read designer bro's p385, p402, p403, p405, p406 and p407 as stuck while their Mac jobs and builders sat in provider_quota_park until 17:00Z,
 * and Prime woke each of them at 14:43 to 14:47Z. A row at work is read by its activity instead, and a session this box lists is left to the
 * disk read.
 */
export async function mirroredParkOwners(boards: ReadonlyMap<string, ChatBoard | null>, named: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  copies: readonly HostCopy[], now: number, readTail: ReadTail | null = null): Promise<Set<string>> {
  const here = new Set(copies.filter(copy => copy.host === null).flatMap(copy => copy.rows.map(row => row.sessionId)));
  const away = new Map<string, { host: string; row: CopyRow }>();
  const children = new Map<string, string[]>();
  for (const copy of copies) for (const row of copy.rows) {
    if (row.parentSessionId) children.set(row.parentSessionId, [...children.get(row.parentSessionId) ?? [], row.sessionId]);
    if (copy.host !== null && !here.has(row.sessionId) && !away.has(row.sessionId)) away.set(row.sessionId, { host: copy.host, row });
  }
  const parked = async (session: string): Promise<boolean> => {
    const found = away.get(session);
    return !!found && found.row.activity !== "working" && poolPark(await awayPark(found.host, found.row, readTail), session, now, NO_POOL) !== null;
  };
  const trees = new Map<string, Set<string>>();
  for (const [chat, board] of boards) {
    walk(board?.plan ?? [], item => {
      if (!OPEN.has(item.status)) return;
      for (const owner of stepSessions(item, named.get(chat) ?? new Map())) if (!trees.has(owner)) trees.set(owner, treeSessions(owner, id => children.get(id) ?? []));
    });
  }
  const sessions = [...new Set([...trees.values()].flatMap(tree => [...tree]))];
  const reads = await Promise.all(sessions.map(parked));
  const open = new Set(sessions.filter((_, index) => reads[index]));
  return new Set([...trees].filter(([, tree]) => [...tree].some(session => open.has(session))).map(([owner]) => owner));
}
