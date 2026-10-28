/** The small client of pi-history's socket that the chat server and the search_history tool use. Only node: builtins, so any process can load it. */
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/** The socket path: PI_HISTORY_SOCKET, else $XDG_RUNTIME_DIR/pi-history/history.sock on Linux and ~/.local/state/pi-history/history.sock on macOS. */
export function socketPath(): string {
  if (process.env.PI_HISTORY_SOCKET) return process.env.PI_HISTORY_SOCKET;
  if (process.platform === "linux") return join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, "pi-history", "history.sock");
  return join(homedir(), ".local", "state", "pi-history", "history.sock");
}

/**
 * The header a merged /v1/search answers with: how long, in ms, it waited on peer boxes after this box's own part was done. The chat proxies
 * the JSON unparsed, so it reads this to count that wait as another box's (user-history chat-latency.ts `waitedOnHost`). On 10-28 at
 * 03:45Z us-metal02's api/search took 2,005 ms, the 2 s peer timeout on the Mac, and d7 counted the minute as this box's slow read.
 */
export const PEER_WAIT_HEADER = "X-History-Peer-Wait-Ms";

export class HistoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type HistoryPath = "/v1/search" | "/v1/read" | "/v1/status";
export type HistoryParams = Record<string, string | number | null | undefined>;

/** One route's answer as it came: its status, its JSON text unparsed and, for a merged search that asked a peer, PEER_WAIT_HEADER's ms. */
export interface RawAnswer { status: number; body: string; peerWaitMs?: number }

/** GETs one route from the socket and returns its answer unparsed. A socket nobody listens on answers 503. */
export function historyRaw(path: HistoryPath, params: HistoryParams = {}, socket = socketPath()): Promise<RawAnswer> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: `${path}?${query}`, method: "GET" }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      const waited = Number(res.headers[PEER_WAIT_HEADER.toLowerCase()]);
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8"), ...Number.isFinite(waited) && waited >= 0 ? { peerWaitMs: waited } : {} }));
      res.on("error", reject);
    });
    req.on("error", (error: NodeJS.ErrnoException) => reject(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
      ? new HistoryError(503, `pi-history is not running here (no socket at ${socket}).`) : error));
    req.end();
  });
}

/** The error a non-2xx answer stands for, with pi-history's own message. */
export function historyError(status: number, body: string): HistoryError {
  let message = body.slice(0, 200);
  try { message = String((JSON.parse(body) as { error?: unknown }).error ?? message); } catch {}
  return new HistoryError(status, message);
}

/** GETs one route from the socket and parses its JSON; a route's own error keeps its status. */
export async function historyGet<T>(path: HistoryPath, params: HistoryParams = {}, socket = socketPath()): Promise<T> {
  const { status, body } = await historyRaw(path, params, socket);
  if (status >= 400) throw historyError(status, body);
  try { return JSON.parse(body) as T; } catch { throw new HistoryError(502, `pi-history answered ${status} with no JSON: ${body.slice(0, 200)}`); }
}
