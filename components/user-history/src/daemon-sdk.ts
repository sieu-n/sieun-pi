import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonAgentConnection as PrimeConnection, DaemonClient as PrimeClient, defaultDaemonSocketPath as primeSocketPath } from "prime-agent";
import { HostAgentConnection, HostClient } from "./pi-host-client.ts";

/**
 * The one place the chat takes its daemon client from. `SIEUN_CHAT_BACKEND=pi-host` puts the chat on pi-host (components/pi-stack/host)
 * through the client in src/pi-host-client.ts; unset or `prime`, the chat runs on Prime's SDK exactly as before.
 *
 * The types stay Prime's while Prime is the default, so every caller type-checks against one shape. The pi-host classes carry the subset of
 * methods the chat calls (test/pi-host-client.test.ts checks the list), and the cutover drops the Prime side of this file.
 */
export type ChatBackend = "prime" | "pi-host";

export function chatBackend(env: NodeJS.ProcessEnv = process.env): ChatBackend {
  const value = env.SIEUN_CHAT_BACKEND?.trim() || "prime";
  if (value !== "prime" && value !== "pi-host") throw new Error(`SIEUN_CHAT_BACKEND is "${value}"; use "prime" or "pi-host".`);
  return value;
}

export const CHAT_BACKEND: ChatBackend = chatBackend();
export const onPiHost = CHAT_BACKEND === "pi-host";

export const DaemonClient: typeof PrimeClient = onPiHost ? HostClient as unknown as typeof PrimeClient : PrimeClient;
export type DaemonClient = PrimeClient;
export const DaemonAgentConnection: typeof PrimeConnection = onPiHost ? HostAgentConnection as unknown as typeof PrimeConnection : PrimeConnection;
export type DaemonAgentConnection = PrimeConnection;

/** pi-host's socket: PI_HOST_SOCKET, else the one its systemd unit opens under the runtime dir. */
export function piHostSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_HOST_SOCKET) return env.PI_HOST_SOCKET;
  return join(env.XDG_RUNTIME_DIR ?? join(homedir(), ".local", "state"), "pi-host", "host.sock");
}

export const defaultDaemonSocketPath = (): string => onPiHost ? piHostSocketPath() : primeSocketPath();
