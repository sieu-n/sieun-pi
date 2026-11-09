import { setTimeout as sleep } from "node:timers/promises";

/**
 * One more try for a read that never reached its server, shared by slack green guy's services duty (d6) and its deploy reader. At 00:07Z on
 * 11-09 one d6 run lost three reads to a connection that dropped (page.goto net::ERR_CONNECTION_ABORTED on /en/pricing, gh "error connecting
 * to api.github.com", and fetch failed on POST /api/teams/heartbeat) while the pages read between them rendered, and a rerun minutes later read
 * every metric on target. An HTTP answer, an uncaught page error or an error screen is never retried, so a real outage still counts on the first run.
 */
export const CONNECTION_FAILURE = /net::ERR_|fetch failed|error connecting to|error sending request|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/;
/** The reads between the three failures of the 11-09 00:07Z run rendered, so the drops were seconds long and a 5 s pause clears one. */
export const RETRY_PAUSE_MS = 5_000;

const text = (error: unknown): string => error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
export const isConnectionFailure = (error: unknown): boolean => CONNECTION_FAILURE.test(text(error));

/** Runs `attempt` once more after `pauseMs` when it throws a connection failure or gives a value `unreached` marks as one. */
export async function retryUnreached<T>(attempt: () => Promise<T>, unreached: (value: T) => boolean = () => false, pauseMs = RETRY_PAUSE_MS): Promise<T> {
  try {
    const value = await attempt();
    if (!unreached(value)) return value;
  } catch (error) {
    if (!isConnectionFailure(error)) throw error;
  }
  await sleep(pauseMs);
  return attempt();
}

export const retryingFetch = (fetcher: typeof fetch, pauseMs = RETRY_PAUSE_MS): typeof fetch =>
  (input, init) => retryUnreached(() => fetcher(input, init), undefined, pauseMs);

export const retryingExec = <A extends unknown[], R>(run: (...args: A) => Promise<R>, pauseMs = RETRY_PAUSE_MS) =>
  (...args: A): Promise<R> => retryUnreached(() => run(...args), undefined, pauseMs);
