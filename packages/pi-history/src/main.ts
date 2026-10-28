import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { defaultDbPath, openDb } from "./core/db.ts";
import { ToolOutputPolicy } from "./core/exclude.ts";
import { defaultDirs, Indexer, type IndexStatus } from "./core/indexer.ts";

export interface ServerContext {
  dbPath: string;
  socket: string;
  box: string;
  indexer: { status(): IndexStatus };
}

export interface RunningServer {
  close(): Promise<void>;
}

export function defaultSocketPath(): string {
  if (process.env.PI_HISTORY_SOCKET) return process.env.PI_HISTORY_SOCKET;
  if (platform() !== "darwin" && process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, "pi-history/history.sock");
  return join(homedir(), ".local/state/pi-history/history.sock");
}

export function boxName(): string {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".config/pi-history/settings.json"), "utf8")) as { box?: unknown };
    if (typeof settings.box === "string" && settings.box) return settings.box;
  } catch {}
  return platform() === "darwin" ? "mac" : hostname();
}

function listen(server: Server, socket: string): Promise<void> {
  mkdirSync(dirname(socket), { recursive: true });
  if (existsSync(socket)) rmSync(socket);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
}

/** Serves only /v1/status, for a build that does not have the api worker's server.ts yet. */
async function startStatusServer(ctx: ServerContext): Promise<RunningServer> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://pi-history");
    if (req.method === "GET" && url.pathname === "/v1/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ box: ctx.box, ...ctx.indexer.status(), peers: {} }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no route ${url.pathname}` }));
  });
  await listen(server, ctx.socket);
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}

type StartServer = (ctx: ServerContext) => Promise<RunningServer>;

async function loadStartServer(): Promise<StartServer> {
  const file = new URL("./server.ts", import.meta.url);
  if (!existsSync(file)) return startStatusServer;
  const mod = (await import(file.href)) as { startServer?: StartServer };
  return mod.startServer ?? startStatusServer;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" }, socket: { type: "string" }, dir: { type: "string", multiple: true } } });
  const dbPath = values.db ?? defaultDbPath();
  const socket = values.socket ?? defaultSocketPath();
  const db = openDb(dbPath);
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const dirs = values.dir ?? defaultDirs();
  const policy = new ToolOutputPolicy(db, dirs.find((d) => basename(d) === "sessions") ?? dirs[0]!);
  const indexer = new Indexer({ db, dbPath, dirs, log, policy });
  const started = indexer.start();
  const server = await (await loadStartServer())({ dbPath, socket, box: boxName(), indexer });
  log(`pi-history: serving ${socket}, database ${dbPath}`);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  setInterval(() => {
    const ms = (ns: number) => Math.round(ns / 1e6);
    const st = indexer.status();
    log(`pi-history: event loop p50 ${ms(loop.percentile(50))} ms, p99 ${ms(loop.percentile(99))} ms, max ${ms(loop.max)} ms; lag p50 ${st.lagP50Ms} ms, p99 ${st.lagP99Ms} ms; step p99 ${st.stepP99Ms} ms`);
    loop.reset();
  }, 60_000).unref();
  const shutdown = async () => {
    await server.close();
    await indexer.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await started;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
