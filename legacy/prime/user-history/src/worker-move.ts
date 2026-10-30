/**
 * A daemon refusal because the session's worker is stopping or starting, or its session is closing. The move ends on its own: at 12:32:33.591Z
 * on 10-18 us-metal02's supervisor refused the attach of job 01a14efc with "Session worker is stopping" and that worker exited 0.24 s later,
 * and the outbox's five such waits from 12:06Z to 12:22Z ended 6 to 63 s after the first refusal (src/agent-outbox.ts).
 */
export const MOVING = /Session worker is (stopping|starting)|Active session \S+ is (closing)/;

const text = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** What the worker was doing ("stopping", "starting" or "closing") when the daemon refused with `error`, or undefined for any other error. */
export function moveOf(error: unknown): string | undefined {
  const found = MOVING.exec(text(error));
  return found ? found[1] ?? found[2] : undefined;
}

/** How often a wait reads get_state. The 12:32:33Z stop ended 0.24 s after its refusal, so most waits end at the first read. */
export const MOVE_READ_MS = 1_000;

/** One get_state answer as `DaemonClient.request` resolves it. */
export type StateAnswer = { success: true; data?: unknown } | { success: false; error: string };

/**
 * Runs `act`, and when the daemon refuses it because the worker moves, reads get_state until it answers anything but another move refusal (the
 * worker runs, or the session is gone with it), then runs `act` again, until `act` meets no move. `waited` hears what the worker was doing and
 * how long each wait took. get_state can read a closing session fine while the attach is still refused: at 18:57:35Z on 10-30 on us-metal02
 * the idle unload was stopping job 01a18e22 while its wake opened it, get_state answered after 174 ms, the one retry met "Active session
 * 73eb82401fc1 is closing" again, and the wake failed, a dirty d7 minute. So a retry that meets a move waits MOVE_READ_MS before it reads again.
 */
export async function afterMove<T>(act: () => Promise<T>, getState: () => Promise<StateAnswer>, waited?: (doing: string, ms: number) => void,
  sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms)), now: () => number = Date.now): Promise<T> {
  const still = async (): Promise<boolean> => moveOf(await getState().then(answer => answer.success ? "" : answer.error, (error: unknown) => text(error))) !== undefined;
  for (let retry = false; ; retry = true) {
    let doing: string | undefined;
    try { return await act(); } catch (error) { if ((doing = moveOf(error)) === undefined) throw error; }
    const from = now();
    if (retry) await sleep(MOVE_READ_MS);
    while (await still()) await sleep(MOVE_READ_MS);
    waited?.(doing, now() - from);
  }
}
