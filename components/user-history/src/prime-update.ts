import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
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
