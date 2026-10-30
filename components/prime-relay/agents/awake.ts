/**
 * What keeps the Mac awake while pi-host runs a turn: relay.mjs's `holdAwake`, which runs `caffeinate -i -s -w <relay pid>` on macOS and does
 * nothing elsewhere, fed by `piHostWorking` instead of the Prime daemon's `list`.
 */
import { holdAwake } from "../relay.mjs";
import { PiHostSocket } from "./pi-host-socket.ts";

/**
 * How long one reading waits for pi-host before it counts as no answer. `durable_threads` answered in 0.1 to 0.7 ms on the Mac (3 threads) and
 * 1.7 to 3.1 ms on metal (68 threads) on 10-30, and relay.mjs's `daemonWorking` waits the same 10 s for the Prime daemon.
 */
const READ_TIMEOUT_MS = 10_000;

/** One `durable_threads` over its own pi-host connection: true when a durable thread runs a turn, null when pi-host did not answer in time. */
export function piHostWorking(socketPath: string): Promise<boolean | null> {
  let late = false;
  let timer: NodeJS.Timeout | undefined;
  const reading = async (): Promise<boolean | null> => {
    const socket = await PiHostSocket.open(socketPath).catch(() => null);
    if (!socket) return null;
    if (late) return (socket.close(), null);
    try {
      const answer = await socket.call("durable_threads");
      if (!answer.ok) return null;
      const threads = (answer.data as { threads?: { status?: unknown }[] }).threads;
      return Array.isArray(threads) ? threads.some(thread => thread.status === "running") : null;
    } finally {
      socket.close();
    }
  };
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { late = true; resolve(null); }, READ_TIMEOUT_MS); });
  return Promise.race([reading(), timeout]).finally(() => clearTimeout(timer));
}

export interface AwakeHold {
  /** Reads pi-host now, so a turn that just started gets its hold without waiting for the next poll. */
  check(): Promise<void>;
  stop(): void;
}

export type AwakeOptions = { platform?: string; spawn?: unknown };

export function holdAwakeForPiHost(socketPath: string, log: (line: string) => void, options: AwakeOptions = {}): AwakeHold {
  return holdAwake(socketPath, log, { ...options, working: () => piHostWorking(socketPath) }) as AwakeHold;
}
