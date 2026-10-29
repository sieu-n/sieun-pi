/**
 * The agent relay's config: relay.mjs's relay.json, whose `port` also serves `/v2/agents`, plus four keys.
 * `piHostSocket` is pi-host's socket (default `daemonSocket`, which pi-host-relay.service already points at pi-host).
 * `chatProxyPort` is the 127.0.0.1 port threads on this box use to reach the chat server (default 7792).
 * `box` is this box's name in ~/.config/sieun-pi/hosts.json (default the short hostname).
 * `agentsDir` is where agent folders live (default `~/.pi/agent/agents`).
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../relay.mjs";

export interface AgentRelayConfig {
  listen: string;
  port: number;
  daemonSocket: string;
  roots: string[];
  token: string;
  historySocket: string;
  piHostSocket: string;
  chatProxyPort: number;
  box: string;
  home: string;
  agentsDir: string;
}

export const DEFAULT_CHAT_PROXY_PORT = 7792;

const expand = (path: string): string => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export function loadAgentConfig(file: string): AgentRelayConfig {
  const base = loadConfig(file) as Omit<AgentRelayConfig, "piHostSocket" | "chatProxyPort" | "box" | "home" | "agentsDir">;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { piHostSocket?: unknown; chatProxyPort?: unknown; box?: unknown; agentsDir?: unknown };
  const piHostSocket = typeof raw.piHostSocket === "string" ? expand(raw.piHostSocket) : base.daemonSocket;
  const chatProxyPort = raw.chatProxyPort === undefined ? DEFAULT_CHAT_PROXY_PORT : Number(raw.chatProxyPort);
  const box = typeof raw.box === "string" && raw.box ? raw.box : hostname().split(".")[0]!;
  const agentsDir = resolve(expand(typeof raw.agentsDir === "string" ? raw.agentsDir : "~/.pi/agent/agents"));
  if (!isAbsolute(piHostSocket) || !Number.isInteger(chatProxyPort)) throw new Error(`${file}: piHostSocket must be absolute and chatProxyPort a port number`);
  return { ...base, piHostSocket, chatProxyPort, box, home: homedir(), agentsDir };
}

/** The relay's version: the pi-host release it runs from (`release-<sha7>`), else "dev" in a checkout. */
export function relayVersion(): string {
  try {
    const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
    const match = /^release-([0-9a-f]{7,40})$/.exec(basename(root));
    return match ? match[1]! : "dev";
  } catch {
    return "dev";
  }
}
