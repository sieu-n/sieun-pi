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

export class HistoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type HistoryPath = "/v1/search" | "/v1/read" | "/v1/status";
export type HistoryParams = Record<string, string | number | null | undefined>;

/** GETs one route from the socket and parses its JSON. A socket nobody listens on answers 503, a route's own error keeps its status. */
export function historyGet<T>(path: HistoryPath, params: HistoryParams = {}, socket = socketPath()): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  return new Promise<T>((resolve, reject) => {
    const req = request({ socketPath: socket, path: `${path}?${query}`, method: "GET" }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try { body = JSON.parse(text); } catch { return reject(new HistoryError(502, `pi-history answered ${res.statusCode} with no JSON: ${text.slice(0, 200)}`)); }
        if ((res.statusCode ?? 500) >= 400) return reject(new HistoryError(res.statusCode ?? 500, String((body as { error?: unknown }).error ?? text)));
        resolve(body as T);
      });
      res.on("error", reject);
    });
    req.on("error", (error: NodeJS.ErrnoException) => reject(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
      ? new HistoryError(503, `pi-history is not running here (no socket at ${socket}).`) : error));
    req.end();
  });
}
