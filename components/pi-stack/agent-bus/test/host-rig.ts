import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostClient } from "../../host/src/client.ts";
import { until } from "./rig.ts";

export const STACK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunningHost {
  proc: ChildProcess;
  socket: string;
  log: () => string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Starts pi-host as its own process on scratch dirs under `root`, with only pi-agent-bus and the busy fixture loaded and a clean
 * environment, so nothing from the calling Prime kernel (such as RLM_SESSION_DIR) reaches the host and no live store is read.
 */
export async function startHost(root: string, name = "host", extraEnv: Record<string, string> = {}): Promise<RunningHost> {
  const dir = join(root, name);
  for (const sub of ["agent", "sessions", "ws", "home"]) mkdirSync(join(dir, sub), { recursive: true });
  const socket = join(dir, "host.sock");
  let log = "";
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", "host/src/main.ts", "--socket", socket, "--agent-dir", join(dir, "agent"), "--session-dir", join(dir, "sessions"), "--cwd", join(dir, "ws"),
      "--no-default-extensions", "--extension", "agent-bus/index.ts", "--extension", "agent-bus/test/fixtures/busy.ts", "--model", "busy/m", "--idle-unload-min", "0"],
    {
      cwd: STACK,
      env: { HOME: join(dir, "home"), PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout!.on("data", chunk => (log += chunk));
  proc.stderr!.on("data", chunk => (log += chunk));
  const exited = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  await until(() => existsSync(socket) && /listening on/.test(log), 30_000, `${name} socket`);
  const client = await HostClient.connect(socket);
  client.close();
  return {
    proc,
    socket,
    log: () => log,
    async stop(signal = "SIGTERM") {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      await exited;
    },
  };
}

export interface RunningRelay {
  url: string;
  tokenFile: string;
  log: () => string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Starts a scratch prime-relay (components/prime-relay/relay.mjs, unchanged) on 127.0.0.1 that tunnels to `socket`. */
export async function startRelay(root: string, name: string, socket: string): Promise<RunningRelay> {
  const dir = join(root, `relay-${name}`);
  mkdirSync(join(dir, "home"), { recursive: true });
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
  const port = await freePort();
  const config = join(dir, "relay.json");
  writeFileSync(config, JSON.stringify({ listen: "127.0.0.1", port, daemonSocket: socket, tokenFile, roots: [dir] }));
  let log = "";
  const proc = spawn(process.execPath, [join(STACK, "..", "prime-relay", "relay.mjs"), config], {
    env: { HOME: join(dir, "home"), PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", chunk => (log += chunk));
  proc.stderr!.on("data", chunk => (log += chunk));
  const exited = new Promise<void>(resolve => proc.once("exit", () => resolve()));
  await until(() => /prime-relay \d+ on/.test(log) || proc.exitCode !== null, 30_000, `relay ${name}`);
  if (proc.exitCode !== null) throw new Error(`relay ${name} exited: ${log}`);
  return {
    url: `http://127.0.0.1:${port}`,
    tokenFile,
    log: () => log,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
      await exited;
    },
  };
}
