import { DaemonClient, defaultDaemonSocketPath } from "prime-agent";

/**
 * Reads the daemon's session list for a script, as `prime-agent list --json` or `prime-agent sessions --json` reads it, with a longer wait for the
 * daemon's hello and a second read when the first fails. The CLI and `DaemonClient.request()` wait a fixed 3000 ms for the hello, with no option to
 * wait longer. On 10-22 the supervisor's busy main thread held its hello past that and failed the d9 runs of 02:21Z and 02:31Z, and from 02:44Z
 * to 02:54Z 65 of 108 probes got the hello after 3 to 7 s while the connect took at most 52 ms (~/work/d9-handshake-timeout/NATIVE.md).
 * The 30 s connect and hello waits are the Prime client's own default request timeout.
 */
export interface ListOptions {
  /** Saved sessions too, as `--all` adds them. */
  all?: boolean;
  /** How long the list answer may take once the hello came: 60 s, the old d9 CLI call's limit, unless the caller already had its own. */
  listMs?: number;
}

/** One read: connect, wait for the hello, ask for the list, and return the answer's data. */
export async function readListOnce(options: ListOptions = {}): Promise<unknown> {
  const client = new DaemonClient(defaultDaemonSocketPath());
  try {
    await client.connect(30_000);
    await client.waitForHello(30_000);
    const response = await client.request(options.all ? { type: "list", all: true } : { type: "list" }, options.listMs ?? 60_000, { recoverable: false });
    if (!response.success) throw new Error(response.error);
    return response.data;
  } finally { client.close(); }
}

/** The list answer's data, read a second time when the first read fails; two failures throw with both errors. */
export async function daemonList(options: ListOptions = {}, read: (options: ListOptions) => Promise<unknown> = readListOnce): Promise<unknown> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await read(options); } catch (error) { errors.push((error instanceof Error ? error.message : String(error)).slice(0, 300)); }
  }
  throw new Error(`reading the daemon's session list failed twice: ${errors.join("; ")}`);
}

/** The session rows of a list answer, which is either `{ sessions }` or the bare array. */
export function listRows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const sessions = (data as { sessions?: unknown } | null)?.sessions;
  return Array.isArray(sessions) ? sessions as T[] : [];
}
