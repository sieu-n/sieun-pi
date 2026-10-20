import { watch } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DaemonClient } from "prime-agent";
import { processStartId } from "./orphan-services.ts";

/** The phases after which an update restart coordinator no longer restores sessions. */
const ENDED_PHASES: ReadonlySet<string> = new Set(["complete", "failed", "skipped"]);

/** A Prime update that is restoring the daemon's sessions now, from its coordinator's status record. */
export interface PrimeUpdate { requestId: string; phase: string; startedAt: string; file: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const real = (path: string) => realpath(path).catch(() => resolve(path));

/** Whether the coordinator a record names still runs: the same `proc:<starttime>` on Linux, a live pid where /proc is absent. */
async function coordinatorRuns(coordinator: unknown, startId: (pid: number) => Promise<string | null>): Promise<boolean> {
  if (!isRecord(coordinator) || typeof coordinator.pid !== "number" || coordinator.pid <= 0) return false;
  const now = await startId(coordinator.pid);
  if (now !== null) return typeof coordinator.processStartId !== "string" || coordinator.processStartId === now;
  if (process.platform === "linux") return false;
  try { process.kill(coordinator.pid, 0); return true; } catch { return false; }
}

/**
 * The Prime update restart that works on `socketPath`'s daemon now, or null. Each coordinator writes its status record under
 * `<agent dir>/update-restarts/` (the ctl's `ctl-<pid>-<time>.json` and `prime-agent update`'s own), with its phase (preparing, stopping,
 * starting_daemon, restoring, then complete, failed or skipped) and its own pid and start id. A record whose phase has not ended counts only
 * while that coordinator still runs, so a coordinator that died mid-update holds nothing up.
 */
export async function primeUpdateRunning(agentDir: string, socketPath: string, startId: (pid: number) => Promise<string | null> = processStartId): Promise<PrimeUpdate | null> {
  const dir = join(agentDir, "update-restarts");
  const names = await readdir(dir).catch(() => [] as string[]);
  const socket = await real(socketPath);
  for (const name of names.filter(entry => entry.endsWith(".json") && !entry.endsWith(".planned.json"))) {
    const file = join(dir, name);
    const record: unknown = await readFile(file, "utf8").then(text => JSON.parse(text) as unknown, () => null);
    if (!isRecord(record) || typeof record.phase !== "string" || ENDED_PHASES.has(record.phase)) continue;
    if (typeof record.socketPath === "string" && await real(record.socketPath) !== socket) continue;
    if (!await coordinatorRuns(record.coordinator, startId)) continue;
    return { requestId: typeof record.requestId === "string" ? record.requestId : name, phase: record.phase, startedAt: typeof record.startedAt === "string" ? record.startedAt : "", file };
  }
  return null;
}

/** The daemon's answer to a mutation it fenced out while it prepares an update restart (prime-agent's UPDATE_RESTART_PREPARING_MESSAGE). */
const PREPARING = "Daemon is preparing an update restart";

/** Whether a daemon answer is the refusal of a call made while the daemon prepared an update restart; older daemons send only the text. */
export const isPrepareRefusal = (answer: { success: boolean; error?: string; errorInfo?: { code?: string } }): boolean =>
  !answer.success && (answer.errorInfo?.code === "update_restarting" || answer.error === PREPARING);

/**
 * The longest a daemon's update prepare runs: prime-agent's supervisor rolls a prepare back once UPDATE_RESTART_PREPARE_DEADLINE_MS, 100 s,
 * passed (daemon-supervisor.js), and then takes calls again. On 10-20 us-metal02's prepare ran from 15:46:51Z to its refusal at 15:48:21Z,
 * 90 s, and the Mac's ran from 15:45:55Z to its new daemon at 15:46:45Z, 50 s. A wait reads it only for a daemon whose update records this box
 * cannot read, another box's.
 */
export const DAEMON_PREPARE_DEADLINE_MS = 100_000;

/** This box's update records, read and watched: `running` is `primeUpdateRunning`, and `watch` calls back on each change of the folder. */
export interface UpdateRecords { running(): Promise<PrimeUpdate | null>; watch(changed: () => void): () => void }

export function updateRecords(agentDir: string, socketPath: string): UpdateRecords {
  const dir = join(agentDir, "update-restarts");
  return {
    running: () => primeUpdateRunning(agentDir, socketPath),
    watch: changed => {
      try {
        const watcher = watch(dir, () => changed());
        watcher.on("error", () => {});
        watcher.unref();
        return () => watcher.close();
      } catch { return () => {}; }
    },
  };
}

/**
 * The longest a caller waits out one daemon's update window before its call fails as it did before: the longest update measured, us-metal02's
 * second one on 10-20, ran 189 s from its ctl start at 16:11:37Z to result=ok at 16:14:46Z; the first ran 97 s, 15:46:44Z to its refused
 * prepare at 15:48:21Z.
 */
export const UPDATE_WAIT_MS = 189_000;

/**
 * How the update window a call met ended: the daemon came back under a new supervisor (its next hello names a new generation), this box's
 * update record of it ended (the prepare was refused, or the update finished), for a daemon whose records this box cannot read the daemon's
 * own prepare deadline passed, or the wait ended with no prepare end: past UPDATE_WAIT_MS, or cancelled by the caller.
 */
export type PrepareEnd = "restarted" | "update ended" | "deadline passed" | "gave up" | "cancelled";

/** Whether a wait ended because the daemon's window ended, so the call goes again; "gave up" and "cancelled" leave the call failed. */
export const windowEnded = (end: PrepareEnd): boolean => end !== "gave up" && end !== "cancelled";

/** An update window a daemon call met: the daemon refused it while it prepared, or this box's daemon was down while its update ran. */
export interface UpdateWindow { kind: "prepare" | "restart"; ended: Promise<PrepareEnd> }

/**
 * Resolves once the update window a call on `client` met ended (`PrepareEnd`). `records` are this box's update records, given only for this
 * box's daemon: a prepare that no running record names, such as another box's, ends by `deadlineMs` (DAEMON_PREPARE_DEADLINE_MS) at the
 * latest. The wait ends unended after `waitMs` or when `signal` aborts.
 */
export async function prepareEnd(client: Pick<DaemonClient, "hello" | "onMessage">, records: UpdateRecords | null,
  options: { deadlineMs?: number; waitMs?: number; signal?: AbortSignal } = {}): Promise<PrepareEnd> {
  const { deadlineMs = DAEMON_PREPARE_DEADLINE_MS, waitMs = UPDATE_WAIT_MS, signal } = options;
  if (signal?.aborted) return "cancelled";
  const generation = client.hello?.supervisorGeneration;
  let finish: (end: PrepareEnd) => void = () => {};
  const ended = new Promise<PrepareEnd>(resolve => { finish = resolve; });
  const offHello = client.onMessage(message => { if (message.type === "daemon_hello" && message.supervisorGeneration !== generation) finish("restarted"); });
  const cancel = () => finish("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const gaveUp = setTimeout(() => finish("gave up"), Math.max(0, waitMs));
  let offRecords = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = records ? await records.running().catch(() => null) : null;
  if (records && update) {
    const check = () => { void records.running().then(now => { if (now?.requestId !== update.requestId) finish("update ended"); }, () => {}); };
    offRecords = records.watch(check);
    check();
  } else if (deadlineMs < waitMs) timer = setTimeout(() => finish("deadline passed"), deadlineMs);
  try { return await ended; } finally { offHello(); offRecords(); clearTimeout(timer); clearTimeout(gaveUp); signal?.removeEventListener("abort", cancel); }
}
