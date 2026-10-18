/**
 * How long a daemon create or reload waits for its answer. Both start a session worker. The bound sits above the longest create the daemon
 * finished, measured from session files: over 568 duty job creates of 10-09 to 10-13 the daemon wrote the session name 4.1 s after it took the
 * create at p50, 38.5 s at p90, 94.5 s at p99 and 1,388 s at most (check-in slack green guy 19:03, 10-12 10:30Z). The name lands 1.5 to 6.2 s
 * before the create answers (5 timed creates on 10-13 at load 24 to 37: 7.0 to 25.7 s; 10 reloads: 1.1 to 6.2 s). The old 180 s bound gave up
 * on 21 duty creates: 8 made a session the duty adopted, and for 10 of the other 13 a session with the job's name came up anyway; the old 60 s bound gave up on 9 reloads that a later retry finished.
 */
export const DAEMON_WORKER_START_MS = 1_500_000;

/**
 * Runs one daemon create or reload and writes how long it took to service.log, so the next look at this bound has every duration, and a
 * refusal's reason after it (10-18 11:40:09Z "daemon create visitors become paying users slack green guy 20:37: refused in 2.1 s" named none).
 */
export async function timedWorkerStart<T>(label: string, run: () => Promise<T>,
  log: (line: string) => void = line => { process.stderr.write(`${line}\n`); }, now: () => number = Date.now): Promise<T> {
  const started = now();
  const seconds = () => ((now() - started) / 1000).toFixed(1);
  try {
    const result = await run();
    const failed = typeof result === "object" && result !== null && "success" in result && result.success === false;
    const reason = failed && "error" in result && typeof result.error === "string" ? `: ${result.error}` : "";
    log(`${new Date(started).toISOString()} daemon ${label}: ${failed ? `refused in ${seconds()} s${reason}` : `answered in ${seconds()} s`}`);
    return result;
  } catch (error) {
    log(`${new Date(started).toISOString()} daemon ${label}: no answer after ${seconds()} s: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
