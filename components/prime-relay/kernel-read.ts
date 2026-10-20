import { type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/**
 * Reads of this box's own kernel files, one at a time in each of two lanes, and the `bounded` guard each read of the usable watch runs under.
 * On 10-20 an exiting clickhouse thread stalled the kernel's RCU grace periods from 11:22Z to 13:08Z and another from 13:11Z to 13:15Z
 * (journalctl -k: rcu_preempt expedited stalls on P1786742 and P2268635), cgroup file reads hung behind them, and us-metal02's watch wrote no
 * line from 11:44:30Z to 13:08:29Z and from 13:11:30Z to 13:16:30Z. A read in flight holds one libuv thread-pool thread of the 4 Node gives
 * the chat service for all its file reads, its session and board files too, so a lane makes a hung file hold one thread and leaves the other reads waiting in the
 * lane instead of on threads. The cgroup lane takes /sys/fs/cgroup and every /proc/<pid>/cgroup; the proc lane takes the rest of /proc.
 */
type Lane = { tail: Promise<unknown> };
const lanes: Record<"cgroup" | "proc", Lane> = { cgroup: { tail: Promise.resolve() }, proc: { tail: Promise.resolve() } };
const laneOf = (path: string): Lane => path.startsWith("/sys/fs/cgroup") || path.endsWith("/cgroup") ? lanes.cgroup : lanes.proc;
function inLane<T>(path: string, read: () => Promise<T>): Promise<T> {
  const lane = laneOf(path);
  const next = lane.tail.then(read);
  lane.tail = next.catch(() => {});
  return next;
}
/** A kernel file's text, read in its lane; rejects as readFile does. */
export const kernelFile = (path: string): Promise<string> => inLane(path, () => readFile(path, "utf8"));
/** A kernel directory's entries, read in its lane; rejects as readdir does. */
export const kernelDir = (path: string): Promise<Dirent[]> => inLane(path, () => readdir(path, { withFileTypes: true }));

const out = new Map<string, Promise<unknown>>();
const CUT = Symbol("cut");
/**
 * `read()`'s answer, or undefined with `kind` added to `unread` when `cut` comes first. A call while the last read of `kind` is still out joins
 * that read instead of making another, so a read that never returns is made once and its lane is not filled again each minute. With no cut it
 * waits as long as the read does.
 */
export async function bounded<T>(kind: string, read: () => Promise<T>, cut?: Promise<unknown>, unread?: string[]): Promise<T | undefined> {
  let settled = out.get(kind) as Promise<T> | undefined;
  if (!settled) {
    settled = Promise.resolve().then(read).finally(() => out.delete(kind));
    settled.catch(() => {});
    out.set(kind, settled);
  }
  if (!cut) return await settled;
  const answer = await Promise.race([settled, cut.then(() => CUT)]);
  if (answer !== CUT) return answer as T;
  unread?.push(kind);
  return undefined;
}
