import { DaemonClient, defaultDaemonSocketPath } from "./daemon-sdk.ts";

/**
 * Reads and writes the daemon for a script with a longer wait for the daemon's hello and a second try when the first fails. The prime-agent CLI
 * and `DaemonClient.request()` wait a fixed 3000 ms for the hello, with no option to wait longer. On 10-22 the supervisor's busy main thread held
 * its hello past that and failed the d9 runs of 02:21Z and 02:31Z, and from 02:44Z to 02:54Z 65 of 108 probes got the hello after 3 to 7 s while
 * the connect took at most 52 ms (~/work/d9-handshake-timeout/NATIVE.md). The 30 s connect and hello waits are the Prime client's own default
 * request timeout. `daemon-cli.mjs` gives the Python scripts the same reads and sends.
 */
export interface ListOptions {
  /** Saved sessions too, as `--all` adds them. */
  all?: boolean;
  /** How long the list answer may take once the hello came: 60 s, the old d9 CLI call's limit, unless the caller already had its own. */
  listMs?: number;
}

/** A client on `socket` that has the daemon's hello. */
export async function openDaemon(socket: string = defaultDaemonSocketPath()): Promise<DaemonClient> {
  const client = new DaemonClient(socket);
  try {
    await client.connect(30_000);
    await client.waitForHello(30_000);
    return client;
  } catch (error) { client.close(); throw error; }
}

/** `attempt`'s result, tried a second time when the first try throws; two failures throw with both errors. */
export async function twice<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (let tries = 0; tries < 2; tries++) {
    try { return await attempt(); } catch (error) { errors.push((error instanceof Error ? error.message : String(error)).slice(0, 300)); }
  }
  throw new Error(`${what} failed twice: ${errors.join("; ")}`);
}

/** One read: open a client, ask for the list, and return the answer's data. */
export async function readListOnce(options: ListOptions = {}): Promise<unknown> {
  const client = await openDaemon();
  try {
    const response = await client.request(options.all ? { type: "list", all: true } : { type: "list" }, options.listMs ?? 60_000, { recoverable: false });
    if (!response.success) throw new Error(response.error);
    return response.data;
  } finally { client.close(); }
}

/** The list answer's data, read a second time when the first read fails. */
export async function daemonList(options: ListOptions = {}, read: (options: ListOptions) => Promise<unknown> = readListOnce): Promise<unknown> {
  return twice("reading the daemon's session list", () => read(options));
}

/**
 * Sends `message` to `target` as `prime-agent send --json` does and returns the answer's data. Only opening the client is tried twice: a send
 * whose answer never came may have gone through, so it is never sent again.
 */
export async function daemonSend(target: string, message: string, open: () => Promise<DaemonClient> = () => openDaemon()): Promise<unknown> {
  const client = await twice("opening the daemon", open);
  try {
    const response = await client.request({ type: "send_message", targetActiveSessionId: target, message });
    if (!response.success) throw new Error(response.error);
    return response.data;
  } finally { client.close(); }
}

/** The queue modes Prime reads from settings.json once, when it loads a session, and the daemon command that changes a loaded session's. */
export const SESSION_MODES = { steeringMode: "set_steering_mode", followUpMode: "set_follow_up_mode" } as const;
export type SessionMode = keyof typeof SESSION_MODES;
export type ModeValue = "all" | "one-at-a-time";
export type ModesResult = { sessions: number; set: number; failed: { activeSessionId: string; error: string }[] };

/**
 * Sets `modes` on every session this box's daemon holds loaded, since a loaded session keeps the modes settings.json had when it loaded.
 * prime-sync runs it after it changes one of them in settings.json, so a long-running chat takes the new mode at once.
 */
export async function daemonSetModes(modes: Partial<Record<SessionMode, ModeValue>>, open: () => Promise<DaemonClient> = () => openDaemon()): Promise<ModesResult> {
  const client = await twice("opening the daemon", open);
  try {
    const listed = await client.request({ type: "list" }, 60_000, { recoverable: false });
    if (!listed.success) throw new Error(listed.error);
    const rows = listRows<{ activeSessionId?: string; workerState?: string }>(listed.data).filter(row => row.activeSessionId && row.workerState !== "failed");
    const failed: ModesResult["failed"] = [];
    await Promise.all(rows.map(async ({ activeSessionId }) => {
      for (const [mode, value] of Object.entries(modes) as [SessionMode, ModeValue][]) {
        const answer = await client.request({ type: SESSION_MODES[mode], activeSessionId: activeSessionId!, mode: value }).catch((error: unknown) =>
          ({ success: false as const, error: error instanceof Error ? error.message : String(error) }));
        if (!answer.success) { failed.push({ activeSessionId: activeSessionId!, error: String(answer.error).slice(0, 200) }); return; }
      }
    }));
    return { sessions: rows.length, set: rows.length - failed.length, failed };
  } finally { client.close(); }
}

/** The session rows of a list answer, which is either `{ sessions }` or the bare array. */
export function listRows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const sessions = (data as { sessions?: unknown } | null)?.sessions;
  return Array.isArray(sessions) ? sessions as T[] : [];
}
