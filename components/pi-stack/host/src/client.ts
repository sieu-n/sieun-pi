/**
 * A minimal client for pi-host's socket, for tests, probes and scripts. It waits for the hello, sends bare commands with ids and collects every
 * other line.
 */

import { createConnection, type Socket } from "node:net";
import type { Hello, HostCommand, Outbound, Response } from "./protocol.ts";

type Line = Outbound & { id?: string };

export class HostClient {
  readonly lines: Line[] = [];
  hello!: Hello;
  private socket!: Socket;
  private buffer = "";
  private next = 0;
  private readonly pending = new Map<string, (response: Response) => void>();
  private readonly waiters = new Set<{ test: (line: Line) => boolean; resolve: (line: Line) => void }>();

  static async connect(socketPath: string): Promise<HostClient> {
    const client = new HostClient();
    await client.open(socketPath);
    return client;
  }

  private open(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(socketPath);
      this.socket.setEncoding("utf8");
      this.socket.once("error", reject);
      this.socket.on("data", chunk => this.receive(chunk as unknown as string));
      this.waitFor(line => line.type === "daemon_hello", 5000).then(line => { this.hello = line as Hello; resolve(); }, reject);
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = JSON.parse(this.buffer.slice(0, newline)) as Line;
      this.buffer = this.buffer.slice(newline + 1);
      if (line.type === "response" && line.id && this.pending.has(line.id)) {
        this.pending.get(line.id)!(line);
        this.pending.delete(line.id);
        continue;
      }
      this.lines.push(line);
      for (const waiter of [...this.waiters]) if (waiter.test(line)) { this.waiters.delete(waiter); waiter.resolve(line); }
    }
  }

  request(command: HostCommand, timeoutMs = 30_000): Promise<Response> {
    const id = `t${++this.next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${command.type} timed out`)); }, timeoutMs);
      this.pending.set(id, response => { clearTimeout(timer); resolve(response); });
      this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /** Sends and throws on a failed response; returns its data. */
  async call<T = unknown>(command: HostCommand, timeoutMs?: number): Promise<T> {
    const response = await this.request(command, timeoutMs);
    if (!response.success) throw new Error(`${command.type}: ${response.error}`);
    return response.data as T;
  }

  waitFor(test: (line: Line) => boolean, timeoutMs = 30_000): Promise<Line> {
    const seen = this.lines.find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve: (line: Line) => { clearTimeout(timer); resolve(line); } };
      const timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error("waitFor timed out")); }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Waits for the `agent_end` event of a session after `afterSequence`. */
  waitForAgentEnd(activeSessionId: string, afterSequence = 0, timeoutMs = 60_000): Promise<Line> {
    return this.waitFor(line => line.type === "session_event" && line.activeSessionId === activeSessionId && line.event.type === "agent_end" && line.meta.sequence > afterSequence, timeoutMs);
  }

  close(): void {
    this.socket.destroy();
  }
}
