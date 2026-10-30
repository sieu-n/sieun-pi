#!/usr/bin/env node
/**
 * The agent relay: relay.mjs's v1 routes and byte pipe, plus the `/v2/agents` WebSocket on the same port and the local chat proxy on
 * 127.0.0.1:chatProxyPort (apps/chat/docs/agent-model.md, section 4 and phase 6). It runs from the pi-host release tree, where `ws` resolves
 * from the repo's node_modules.
 *
 *   node components/prime-relay/agents/main.ts ~/.config/pi-host-relay/relay.json
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createRelay } from "../relay.mjs";
import { holdAwakeForPiHost, type AwakeOptions } from "./awake.ts";
import { createChatProxy } from "./chat-proxy.ts";
import { loadAgentConfig, relayVersion, type AgentRelayConfig } from "./config.ts";
import { AgentLink } from "./link.ts";
import { AGENT_RELAY_PATH } from "./protocol.ts";

const digest = (text: string) => createHash("sha256").update(text).digest();
const authorized = (request: IncomingMessage, token: string): boolean => {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7).trim()), digest(token));
};

export interface AgentRelay {
  relay: Server;
  proxy: Server;
  links: Set<AgentLink>;
  close(): Promise<void>;
}

/**
 * Builds the relay without listening. relay.mjs refuses every upgrade but `/v1/daemon`, so its upgrade listener moves behind this one, which
 * takes `/v2/agents` and hands every other path to it.
 */
export function createAgentRelay(config: AgentRelayConfig, log: (line: string) => void, relayOptions?: Parameters<typeof createRelay>[2], awakeOptions?: AwakeOptions): AgentRelay {
  const relay = createRelay(config, log, relayOptions) as Server;
  const v1Upgrades = relay.listeners("upgrade") as ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  relay.removeAllListeners("upgrade");
  const wss = new WebSocketServer({ noServer: true });
  const links = new Set<AgentLink>();
  const version = relayVersion();
  const awake = holdAwakeForPiHost(config.piHostSocket, log, awakeOptions);
  relay.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(request.url ?? "/", "http://relay").pathname !== AGENT_RELAY_PATH) {
      for (const listener of v1Upgrades) listener.call(relay, request, socket, head);
      return;
    }
    if (!authorized(request, config.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      log(`agents link opened from ${request.socket.remoteAddress}`);
      const link: AgentLink = new AgentLink(ws, { box: config.box, home: config.home, agentsDir: config.agentsDir, piHostSocket: config.piHostSocket, version, log, onSubmit: () => void awake.check() }, () => links.delete(link));
      links.add(link);
    });
  });
  const liveLink = () => [...links].reverse().find(link => link.state === "live");
  const proxy = createChatProxy(liveLink, log);
  return {
    relay, proxy, links,
    async close() {
      awake.stop();
      for (const link of links) link.close("relay stopping");
      wss.close();
      await Promise.all([relay, proxy].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const arg = process.argv[2] ?? "~/.config/pi-host-relay/relay.json";
  const config = loadAgentConfig(arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg);
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const { relay, proxy } = createAgentRelay(config, log);
  relay.listen(config.port, config.listen, () => log(`agent relay ${relayVersion()} for ${config.box} on ${config.listen}:${config.port}${AGENT_RELAY_PATH}, pi-host ${config.piHostSocket}`));
  proxy.listen(config.chatProxyPort, "127.0.0.1", () => log(`chat proxy on 127.0.0.1:${config.chatProxyPort}`));
}
