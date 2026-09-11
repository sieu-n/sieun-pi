import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { contentSecurityPolicy } from "./page.ts";

export type CloseStatus = "consumed" | "timeout" | "closed" | "error";
type Delivery = Readonly<{ url: string; closed: Promise<CloseStatus>; close(): void }>;

export async function oneShotPage(html: string): Promise<Delivery> {
  const path = '/' + randomBytes(24).toString('hex');
  const connections = new Set<Socket>();
  let host = '';
  let state: 'waiting' | 'responding' | 'draining' | CloseStatus = 'waiting';
  let complete: (status: CloseStatus) => void = () => {};
  const closed = new Promise<CloseStatus>(resolve => { complete = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    const reject = (status: number) => { res.writeHead(status); res.end(); };
    if (req.headers.host !== host) return reject(421);
    if (req.method !== 'GET') return reject(405);
    if (req.url !== path) return reject(404);
    if (state !== 'waiting') return reject(410);
    state = 'responding';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Content-Security-Policy': contentSecurityPolicy,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.once('finish', () => {
      if (state !== 'responding') return;
      state = 'draining';
      server.close();
      for (const socket of connections) {
        if (socket !== req.socket) socket.destroy();
      }
    });
    res.once('close', () => { if (!res.writableFinished) stop('error'); });
    res.end(html);
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.once('close', () => {
    clearTimeout(timer);
    if (state === 'draining') state = 'consumed';
    if (state === 'waiting' || state === 'responding') state = 'error';
    complete(state);
  });
  function stop(status: Exclude<CloseStatus, 'consumed'>) {
    if (state !== 'waiting' && state !== 'responding' && state !== 'draining') return;
    state = status;
    server.close();
    server.closeAllConnections();
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => stop('error'));
  const address = server.address();
  if (!address || typeof address === 'string') {
    stop('error');
    throw new Error('Expected a loopback TCP address');
  }
  host = '127.0.0.1:' + address.port;
  timer = setTimeout(() => stop('timeout'), 30000);
  return { url: `http://${host}${path}`, closed, close: () => stop('closed') };
}
