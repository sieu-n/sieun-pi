import { isPrepareRefusal } from "./prime-update.ts";

/**
 * How long a daemon create or reload waits for its answer. Both start a session worker. The bound sits above the longest create the daemon
 * finished, measured from session files: over 568 duty job creates of 10-09 to 10-13 the daemon wrote the session name 4.1 s after it took the
 * create at p50, 38.5 s at p90, 94.5 s at p99 and 1,388 s at most (check-in slack green guy 19:03, 10-12 10:30Z). The name lands 1.5 to 6.2 s
 * before the create answers (5 timed creates on 10-13 at load 24 to 37: 7.0 to 25.7 s; 10 reloads: 1.1 to 6.2 s). The old 180 s bound gave up
 * on 21 duty creates: 8 made a session the duty adopted, and for 10 of the other 13 a session with the job's name came up anyway; the old 60 s bound gave up on 9 reloads that a later retry finished.
 */
export const DAEMON_WORKER_START_MS = 1_500_000;

/** The words a refused start's line ends with when it waits out the daemon's update prepare (src/daemon-faults.ts reads them). */
export const PREPARE_WAIT = "it starts again once the prepare ends";

/**
 * Runs one daemon create or reload and writes how long it took to service.log, so the next look at this bound has every duration, and a
 * refusal's reason after it (10-18 11:40:09Z "daemon create visitors become paying users slack green guy 20:37: refused in 2.1 s" named none).
 */
export async function timedWorkerStart<T>(label: string, run: () => Promise<T>,
  log: (line: string) => void = line => { process.stderr.write(`${line}\n`); }, now: () => number = Date.now, waits: (result: T) => boolean = () => false): Promise<T> {
  const started = now();
  const seconds = () => ((now() - started) / 1000).toFixed(1);
  try {
    const result = await run();
    const failed = typeof result === "object" && result !== null && "success" in result && result.success === false;
    const reason = failed && "error" in result && typeof result.error === "string" ? `: ${result.error}` : "";
    const after = failed && waits(result) ? `; ${PREPARE_WAIT}` : "";
    log(`${new Date(started).toISOString()} daemon ${label}: ${failed ? `refused in ${seconds()} s${reason}${after}` : `answered in ${seconds()} s`}`);
    return result;
  } catch (error) {
    log(`${new Date(started).toISOString()} daemon ${label}: no answer after ${seconds()} s: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** A daemon create or reload's answer, as far as the wait reads it. */
type StartAnswer = { success: boolean; error?: string; errorInfo?: { code?: string } };

/**
 * Runs a worker start with `timedWorkerStart`, and again each time the daemon refused it because it was preparing an update restart, once that
 * prepare ended (`ended`, src/prime-update.ts `prepareEnd`). The start stays one call to its caller, so a second ask for the same session joins
 * it rather than sending its own (`ThreadHub.resume`). `dropped` names a newer owner stop or archive that ends the wait, and the refusal then
 * stands. On 10-20 the daemons' prepares refused a resume of Mac chat 01a15503 at 15:46:05Z and 15:46:35Z and the create of "alert triage
 * Crawler VP 01:13" at 16:13:12Z, and each refusal made a d7 minute dirty.
 */
export async function workerStartThroughUpdates<T extends StartAnswer>(label: string, run: () => Promise<T>, ended: () => Promise<string>,
  dropped: () => Promise<string | null> = async () => null, refusedStart: (answer: T) => boolean = isPrepareRefusal,
  log: (line: string) => void = line => { process.stderr.write(`${line}\n`); }, now: () => number = Date.now): Promise<T> {
  for (;;) {
    const answer = await timedWorkerStart(label, run, log, now, refusedStart);
    if (!refusedStart(answer)) return answer;
    const since = now();
    const end = await ended();
    const stop = await dropped();
    const waited = `${new Date(now()).toISOString()} daemon ${label}: the update prepare ended (${end}) after ${((now() - since) / 1000).toFixed(1)} s`;
    if (stop) { log(`${waited}; ${stop}, so it does not start again`); return answer; }
    log(`${waited}; it starts again`);
  }
}
