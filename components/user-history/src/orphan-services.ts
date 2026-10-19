import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The record of the detached services a session handed off before the idle unload freed its kernel: one file per session at
 * ~/.prime/agent/orphan-services/<session>.json. A service such as `nohup svc > log 2>&1 &` started through bash() lives in the shell's
 * process group, and the kernel's shutdown killpg()s that group (native run DU-fix, 10-18 17:51Z). Prime hands the group over with a lasting
 * receipt (`detached-handoff.ts`), the service moves into a systemd --user scope of its own, and this record keeps it listed for the watch
 * (d7) and the watchdog. Prime stops a transferred service itself on an owner stop or delete, re-checked from its receipt; the delete here also
 * stops the scope and removes the record.
 */
export const ORPHAN_SERVICES_DIR = join(homedir(), ".prime", "agent", "orphan-services");

/**
 * One handed-off service: the group Prime's receipt names, the scope that owns it, and where it writes. `pid` is the service and `pgid` its old
 * shell; `processStartId` is the service's `proc:<starttime>`, so a reader can tell it from a reused pid.
 */
export interface OrphanService { pid: number; pgid: number; processStartId: string; members: number[]; unit: string; cgroup: string; log: string | null; command: string; committedAt: string }

/** A group prepare listed, kept so a rerun after a crash still knows the command; the move and the commit always use a fresh prepare. */
export interface PreparedGroup { pgid: number; command: string }

/** A group as commit names it once it sits in its scope (`detached-handoff.ts` MovedGroup), kept so a rerun can replay the commit. */
export interface MovedGroupRecord { pgid: number; leader: { pid: number; startTime: string }; members: { pid: number; startTime: string }[]; cgroup: string }

/**
 * One handoff, in the order a crash can stop it. `pending` is written before Prime is asked, so every call reuses its handoffId. `moving`
 * follows prepare: the groups are being moved into their scopes and committed, and `moved` holds what commit is sent once every group sits in
 * its scope. `received` holds Prime's receipt, written only from the
 * receipt, and `unloaded` follows once the idle kill freed the kernel.
 */
export type Handoff =
  | { state: "pending"; handoffId: string; activeSessionId: string; at: string }
  | { state: "moving"; handoffId: string; activeSessionId: string; at: string; prepared: PreparedGroup[]; moved?: MovedGroupRecord[] }
  | { state: "received"; handoffId: string; activeSessionId: string; at: string; receiptId: string; bootId: string; services: OrphanService[] }
  | { state: "unloaded"; handoffId: string; activeSessionId: string; at: string; receiptId: string; bootId: string; services: OrphanService[]; unloadedAt: string };

export interface OrphanRecord { version: 1; sessionId: string; handoffs: Handoff[] }

/** The scope of one group: named by session and old pgid, so a retried handoff finds the scope it made instead of making a second one. */
export const unitName = (sessionId: string, pgid: number): string => `orphan-${sessionId.slice(0, 13)}-${pgid}.scope`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SESSION_ID = /^[0-9a-zA-Z-]{8,64}$/;

/** A record file's contents, or null when it is not one. */
export function parseRecord(value: unknown): OrphanRecord | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.sessionId !== "string" || !Array.isArray(value.handoffs)) return null;
  const handoffs = value.handoffs.filter((entry): entry is Handoff => isRecord(entry) && typeof entry.handoffId === "string" &&
    typeof entry.activeSessionId === "string" && (entry.state === "pending" || (entry.state === "moving" && Array.isArray(entry.prepared)) || ((entry.state === "received" || entry.state === "unloaded") && Array.isArray(entry.services))));
  return { version: 1, sessionId: value.sessionId, handoffs };
}

export const recordFile = (dir: string, sessionId: string): string => join(dir, `${sessionId}.json`);

export async function readRecord(dir: string, sessionId: string): Promise<OrphanRecord | null> {
  const text = await readFile(recordFile(dir, sessionId), "utf8").catch(() => null);
  if (text === null) return null;
  try { return parseRecord(JSON.parse(text)); } catch { return null; }
}

/** Writes the record through a temp file and a rename, so a reader or a crash never sees half a file. */
export async function writeRecord(dir: string, record: OrphanRecord): Promise<void> {
  if (!SESSION_ID.test(record.sessionId)) throw new Error(`orphan-services: bad session id ${record.sessionId}`);
  await mkdir(dir, { recursive: true });
  const file = recordFile(dir, record.sessionId);
  const draft = `${file}.${process.pid}.tmp`;
  await writeFile(draft, JSON.stringify(record, null, 1) + "\n");
  await rename(draft, file);
}

/** The sessions whose records hold a handoff that has not reached `unloaded`, with the active session id that handoff began on. */
export async function unfinishedHandoffs(dir = ORPHAN_SERVICES_DIR): Promise<{ sessionId: string; activeSessionId: string }[]> {
  return (await readRecords(dir)).flatMap(record => {
    const open = record.handoffs.find(handoff => handoff.state !== "unloaded");
    return open ? [{ sessionId: record.sessionId, activeSessionId: open.activeSessionId }] : [];
  });
}

export async function readRecords(dir = ORPHAN_SERVICES_DIR): Promise<OrphanRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records = await Promise.all(names.filter(name => name.endsWith(".json")).map(name => readRecord(dir, name.slice(0, -".json".length))));
  return records.filter((record): record is OrphanRecord => record !== null);
}

/** A process's start id as Prime journals it (`proc:<starttime>`), null when it is gone. */
export async function processStartId(pid: number): Promise<string | null> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (stat === null) return null;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ? `proc:${fields[19]}` : null;
}

/** The file a process writes its stdout to, as `nohup svc > log` leaves it; null for a pipe, a socket or a device. */
export async function logPath(pid: number): Promise<string | null> {
  const target = await readlink(`/proc/${pid}/fd/1`).catch(() => null);
  return target && target.startsWith("/") && !target.startsWith("/dev/") ? target.replace(/ \(deleted\)$/, "") : null;
}

/** A handed-off service the watch and the watchdog list: its session, scope, pid, whether the same process still runs, and its handoff's state. */
export interface OrphanServiceLine { session: string; unit: string; pid: number; live: boolean; state: Handoff["state"]; command: string; log: string | null }

/** Every service the records name, with `live` read from /proc. */
export async function listOrphanServices(dir = ORPHAN_SERVICES_DIR, started = processStartId): Promise<OrphanServiceLine[]> {
  const lines: OrphanServiceLine[] = [];
  for (const record of await readRecords(dir)) {
    for (const handoff of record.handoffs) {
      if (handoff.state === "pending" || handoff.state === "moving") continue;
      for (const service of handoff.services)
        lines.push({ session: record.sessionId, unit: service.unit, pid: service.pid, live: await started(service.pid) === service.processStartId,
          state: handoff.state, command: service.command, log: service.log });
    }
  }
  return lines;
}

/** Stops a scope; resolves once systemd answered, whether or not the unit was still there. */
export const stopUnit = (unit: string): Promise<void> => new Promise(resolve => {
  execFile("systemctl", ["--user", "stop", unit], { timeout: 30_000 }, () => resolve());
});

/**
 * Stops the handed-off services of deleted sessions and removes their records. The scope stop reaches only the processes in that scope, so a
 * reused pid is never hit. Returns the units it stopped.
 */
export async function stopOrphanServices(sessions: readonly string[], dir = ORPHAN_SERVICES_DIR, stop = stopUnit): Promise<string[]> {
  const stopped: string[] = [];
  for (const session of new Set(sessions)) {
    if (!SESSION_ID.test(session)) continue;
    const record = await readRecord(dir, session);
    if (!record) continue;
    const units = [...new Set(record.handoffs.flatMap(handoff => handoff.state === "received" || handoff.state === "unloaded" ? handoff.services.map(service => service.unit)
      : handoff.state === "moving" ? handoff.prepared.map(group => unitName(session, group.pgid)) : []))];
    for (const unit of units) { await stop(unit); stopped.push(unit); }
    await rm(recordFile(dir, session), { force: true });
  }
  return stopped;
}
