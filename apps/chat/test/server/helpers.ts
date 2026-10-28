/**
 * Starts the chat server in this process on a free port, on the fixture host or on a real pi-host socket, and gives a plain HTTP and
 * WebSocket client for the specs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { LiveEvent } from "../../web/src/lib/api/types.ts";
import { App } from "../../server/app.ts";
import { fixtureFolders, readConfig } from "../../server/config.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { PiHost } from "../../server/host/pi-host.ts";
import { serve } from "../../server/http.ts";
import { seedFixture } from "../../server/fixture/seed.ts";

export interface Running {
  base: string;
  app: App;
  host: FixtureHost | PiHost;
  get<T = any>(path: string): Promise<T>;
  send<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  live(): Promise<LiveClient>;
  close(): Promise<void>;
}

export interface LiveClient {
  events: LiveEvent[];
  watch(conversation: string): void;
  waitFor<E extends LiveEvent>(match: (event: LiveEvent) => event is E, timeoutMs?: number): Promise<E>;
  waitFor(match: (event: LiveEvent) => boolean, timeoutMs?: number): Promise<LiveEvent>;
  close(): void;
}

/**
 * With `url`, the specs run against a server that already runs there, such as the installed service on :5184. With `dataDir`, the server
 * uses that dir and leaves it on close, so a spec can start a second server on it as a restart.
 */
export async function start(opts: { real?: boolean; wordMs?: number; url?: string; dataDir?: string } = {}): Promise<Running> {
  if (opts.url) return remote(opts.url);
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "apps-chat-test-"));
  const config = { ...readConfig([]), dataDir, port: 0, fixture: !opts.real, box: "test-box", ...(opts.real ? {} : fixtureFolders(dataDir)) };
  const host = opts.real ? new PiHost(config.socket) : new FixtureHost();
  if (host instanceof FixtureHost) {
    host.wordMs = opts.wordMs ?? 0;
    seedFixture(host, dataDir);
  }
  const app = new App(config, host, () => {});
  await app.start();
  const server = serve(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  return {
    base, app, host, ...client(base, sockets),
    async close() {
      for (const socket of sockets) socket.close();
      server.closeAllConnections();
      server.close();
      await app.stop();
      if (!opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function client(base: string, sockets: WebSocket[]) {
  return {
    async get(path: string) {
      const response = await fetch(base + path);
      const body = await response.json();
      if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
      return body;
    },
    async send(method: string, path: string, body?: unknown) {
      const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async live(): Promise<LiveClient> {
      const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/live`);
      sockets.push(socket);
      const events: LiveEvent[] = [];
      const waiters: { match: (event: LiveEvent) => boolean; resolve: (event: LiveEvent) => void }[] = [];
      socket.on("message", data => {
        const event = JSON.parse(String(data)) as LiveEvent;
        events.push(event);
        for (const waiter of [...waiters]) {
          if (waiter.match(event)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        }
      });
      await new Promise(resolve => socket.once("open", resolve));
      return {
        events,
        watch: (conversation: string) => socket.send(JSON.stringify({ type: "watch", conversation })),
        waitFor: (match: (event: LiveEvent) => boolean, timeoutMs = 20_000) => {
          const seen = events.find(match);
          if (seen) return Promise.resolve(seen);
          return new Promise<LiveEvent>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no matching live event in ${timeoutMs} ms`)), timeoutMs);
            waiters.push({ match, resolve: event => { clearTimeout(timer); resolve(event); } });
          });
        },
        close: () => socket.close(),
      } as LiveClient;
    },
  };
}

async function remote(base: string): Promise<Running> {
  const sockets: WebSocket[] = [];
  return {
    base, app: undefined as never, host: undefined as never, ...client(base, sockets),
    async close() {
      for (const socket of sockets) socket.close();
    },
  } as Running;
}

export const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`condition not met in ${timeoutMs} ms: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
