/**
 * The unix socket in front of `PiHost`: one JSON object per line each way, a `daemon_hello` on connect, then responses and events.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Connection, PiHost } from "./host.ts";
import { fail, parseCommandLine, PROTOCOL, SCHEMA_ID, SCHEMA_REVISION, SERVER_CAPABILITIES, type Hello, type Outbound } from "./protocol.ts";

export const HOST_VERSION = "0.1.0";

/** True when a process answers on the socket, so a second host never unlinks a live one's socket. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

class SocketConnection implements Connection {
  readonly clientId = `pi-host-client:${randomUUID()}`;
  roster = false;
  private buffer = "";

  constructor(private readonly socket: Socket, private readonly host: PiHost) {}

  write(line: Outbound): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    this.socket.write(`${JSON.stringify(line)}\n`);
  }

  receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) void this.run(line);
    }
  }

  private async run(line: string): Promise<void> {
    const parsed = parseCommandLine(line);
    if ("error" in parsed) {
      this.write(fail(parsed.id, "unknown", parsed.error));
      return;
    }
    try {
      const response = await this.host.handle(parsed.command, this);
      if (response) this.write(response);
    } catch (error) {
      this.write(fail(parsed.id, parsed.command.type, error));
    }
  }
}

export async function listen(host: PiHost, socketPath: string, options: { scratchChatMark?: boolean } = {}): Promise<Server> {
  if (existsSync(socketPath)) {
    if (await answers(socketPath)) throw new Error(`Another process answers on ${socketPath}; pi-host does not take over a live socket.`);
    unlinkSync(socketPath);
  }
  const server = createServer(socket => {
    const connection = new SocketConnection(socket, host);
    host.addConnection(connection);
    socket.setEncoding("utf8");
    socket.on("data", chunk => connection.receive(chunk as unknown as string));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => host.removeConnection(connection));
    const hello: Hello = {
      type: "daemon_hello", socketPath, protocol: PROTOCOL, schemaId: SCHEMA_ID, schemaRevision: SCHEMA_REVISION, appVersion: HOST_VERSION,
      supervisorGeneration: host.generation, supervisorPid: process.pid, clientId: connection.clientId, serverCapabilities: SERVER_CAPABILITIES,
      ...(options.scratchChatMark ? { replay: true as const } : {}), host: "pi-host",
    };
    connection.write(hello);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  host.socketPath = socketPath;
  return server;
}
