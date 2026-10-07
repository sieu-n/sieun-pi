import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "prime-agent";

/**
 * Keeps the Prime Agent daemon running for the chat. After a reboot launchd starts the chat at login, but nothing started the daemon until a
 * terminal ran prime-agent. The chat now starts it the way the official CLI does when a command finds no daemon: the installed launcher with
 * `--mode daemon --daemon-socket <socket>`, detached. The daemon itself takes the `<socket>.lock` lease (proper-lockfile, refreshed every
 * second, stale after 5 s) and refuses a socket that answers, so a second start never makes a second daemon, and a lock left by a power-off is
 * taken over after 5 s.
 */

/** Variables a daemon worker hands its children. The official launcher drops them before it spawns a daemon (daemon-launch.js). */
const INTERNAL_PREFIX = "PRIME_AGENT_INTERNAL_";
/** Shell and launchd bookkeeping that names the process that read it, not the daemon, and this chat's own switch. */
const DROPPED = new Set(["SHLVL", "PWD", "OLDPWD", "_", "XPC_SERVICE_NAME", "SIEUN_PI_CHAT_START_DAEMON"]);
const MARKER = "__SIEUN_PI_CHAT_ENV__";

const homeOf = (env: NodeJS.ProcessEnv) => env.HOME || userInfo().homedir;

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

/**
 * Where the official installer puts the launcher (install.sh: `${PRIME_AGENT_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/prime-agent}/bin/prime-agent`,
 * a link it moves to each new release), then `prime-agent` on PATH. The link is not resolved here, so an update is followed at the next start.
 */
export function launcherCandidates(env: NodeJS.ProcessEnv): string[] {
  const root = env.PRIME_AGENT_INSTALL_DIR || join(env.XDG_DATA_HOME || join(homeOf(env), ".local", "share"), "prime-agent");
  const onPath = (env.PATH ?? "").split(":").filter(entry => entry.startsWith("/")).map(entry => join(entry, "prime-agent"));
  return [join(root, "bin", "prime-agent"), ...onPath].filter((entry, index, all) => all.indexOf(entry) === index);
}

export async function findLauncher(env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const candidate of launcherCandidates(env)) if (await executable(candidate)) return candidate;
  return null;
}

/** `env -0` output after the marker as variables. Text the shell's startup files print before the marker is ignored. */
export function parseEnvOutput(output: string): Record<string, string> | null {
  const start = output.indexOf("\0" + MARKER + "\0");
  if (start < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(start + MARKER.length + 2).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

/** The chat's own variables under the login shell's, without daemon-internal and per-process ones. */
export function daemonEnvironment(base: NodeJS.ProcessEnv, shell: Record<string, string> | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...(shell ?? {}) };
  for (const key of Object.keys(env)) if (key.startsWith(INTERNAL_PREFIX) || DROPPED.has(key)) delete env[key];
  return env;
}

/**
 * The variables a terminal would give the daemon. launchd starts the chat with a bare PATH and none of the variables the owner's shell
 * startup files export (tool paths, API tokens), and a daemon inherits its starter's variables, so it reads them from an interactive login
 * shell, as a terminal does. On failure the chat's own variables are used and the reason is returned.
 */
export async function loginEnvironment(base: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<{ env: NodeJS.ProcessEnv; error?: string }> {
  const candidate = base.SHELL && base.SHELL.startsWith("/") ? base.SHELL : userInfo().shell ?? "/bin/zsh";
  const shell = await executable(candidate) ? candidate : "/bin/zsh";
  const clean = daemonEnvironment(base, null);
  const result = await new Promise<{ output: string; error?: string }>(resolve => {
    const child = spawn(shell, ["-i", "-l", "-c", `printf '\\0%s\\0' ${MARKER}; /usr/bin/env -0`],
      { cwd: homeOf(base), env: clean, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.once("error", error => { clearTimeout(timer); resolve({ output: "", error: error.message }); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(signal ? { output, error: `${shell} was stopped after ${timeoutMs / 1000} s (${signal})` } : code === 0 ? { output } : { output, error: `${shell} exited ${code}` });
    });
  });
  const parsed = parseEnvOutput(result.output);
  if (!parsed?.PATH) return { env: clean, error: result.error ?? `${shell} printed no environment` };
  return { env: daemonEnvironment(base, parsed) };
}

/** True when something accepts connections on the socket. A daemon still starting accepts before it greets, so it counts as running. */
export async function daemonAnswers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  const client = new DaemonClient(socketPath);
  try { await client.connect(timeoutMs); return true; } catch { return false; } finally { client.close(); }
}

export type DaemonKeeperState = { state: "up" | "starting" | "down" | "stopped"; attempts: number; message: string };

type Launch = (socketPath: string) => Promise<{ ok: boolean; message: string }>;

type KeeperOptions = {
  socketPath: string;
  log(line: string): void;
  env?: NodeJS.ProcessEnv;
  /** Milliseconds to wait after failed attempt 1, 2, ...; the last value repeats. */
  backoffMs?: readonly number[];
  /** Wait after the daemon went away before starting it, so a restart the daemon or an update runs itself wins. */
  restartDelayMs?: number;
  launch?: Launch;
  answers?: (socketPath: string) => Promise<boolean>;
  onUp?(): void;
};

const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/**
 * Starts `<launcher> --mode daemon --daemon-socket <socket>` the way the official CLI's `ensureDaemonRunning` does (cli/daemon-launch.js):
 * detached, no stdio (the daemon writes its own log), worker-internal variables dropped, then up to 30 s of socket probes; an early exit
 * gets a 2 s grace, because the child may have lost the socket lease to another starter whose daemon is still booting.
 */
export function officialLaunch(baseEnv: NodeJS.ProcessEnv, options: { startupMs?: number; graceMs?: number } = {}): Launch {
  const startupMs = options.startupMs ?? 30_000, graceMs = options.graceMs ?? 2_000;
  return async socketPath => {
    const launcher = await findLauncher(baseEnv);
    if (!launcher) return { ok: false, message: `no prime-agent launcher at ${launcherCandidates(baseEnv)[0]} or on PATH` };
    const { env, error: envError } = await loginEnvironment(baseEnv);
    const note = envError ? ` (login shell variables not read: ${envError})` : "";
    // The socket can start answering while the login shell ran; the daemon would refuse a socket in use, so do not start a second one.
    if (await daemonAnswers(socketPath)) return { ok: true, message: "the daemon was already answering" };
    let exited: string | undefined;
    const child = spawn(launcher, ["--mode", "daemon", "--daemon-socket", socketPath], { cwd: homeOf(baseEnv), env, detached: true, stdio: "ignore" });
    child.once("error", error => { exited ??= `could not start ${launcher}: ${error.message}`; });
    child.once("exit", (code, signal) => { exited ??= `${launcher} exited during startup (code ${code ?? "none"}${signal ? `, signal ${signal}` : ""})`; });
    child.unref();
    const deadline = Date.now() + startupMs;
    let exitDeadline: number | undefined;
    while (Date.now() < Math.min(deadline, exitDeadline ?? Infinity)) {
      if (await daemonAnswers(socketPath, 250)) return { ok: true, message: `spawned ${launcher} --mode daemon (pid ${child.pid}) and the socket answers${note}` };
      if (exited) exitDeadline ??= Date.now() + graceMs;
      await delay(100, undefined, { ref: false });
    }
    return { ok: false, message: (exited ?? `no answer on the socket within ${startupMs / 1000} s from ${launcher} (pid ${child.pid}), left running`) + note };
  };
}

/**
 * Starts the daemon when its socket does not answer, retries with backoff, and watches one connection so a daemon that exits (crash,
 * `prime-agent shutdown`) is started again. It never launches while the socket answers.
 */
export class DaemonKeeper {
  private snapshot: DaemonKeeperState = { state: "down", attempts: 0, message: "" };
  private closed = false;
  private stopWatch: (() => void) | undefined;
  private wake: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private readonly launch: Launch;
  private readonly answers: (socketPath: string) => Promise<boolean>;

  constructor(private readonly options: KeeperOptions) {
    this.launch = options.launch ?? officialLaunch(options.env ?? process.env);
    this.answers = options.answers ?? (socketPath => daemonAnswers(socketPath));
  }

  status(): DaemonKeeperState { return this.snapshot; }

  start(): Promise<void> { return this.running ??= this.loop(); }

  /** Stops watching and retrying. A launch in flight finishes on its own; the daemon it starts keeps running. */
  close(): void {
    this.closed = true;
    this.stopWatch?.();
    this.wake?.();
  }

  private async sleep(ms: number): Promise<void> {
    if (this.closed) return;
    const controller = new AbortController();
    this.wake = () => controller.abort();
    await delay(ms, undefined, { signal: controller.signal, ref: false }).catch(() => {});
    this.wake = undefined;
  }

  private async loop(): Promise<void> {
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    let failures = 0;
    while (!this.closed) {
      if (await this.answers(this.options.socketPath)) {
        failures = 0;
        this.snapshot = { state: "up", attempts: this.snapshot.attempts, message: "" };
        this.options.onUp?.();
        await this.watch();
        if (this.closed) break;
        this.snapshot = { state: "down", attempts: this.snapshot.attempts, message: "The daemon closed its socket." };
        this.options.log(`daemon: the daemon on ${this.options.socketPath} closed the connection. Checking again in ${seconds(this.options.restartDelayMs ?? 3_000)}.`);
        await this.sleep(this.options.restartDelayMs ?? 3_000);
        continue;
      }
      const attempt = ++this.snapshot.attempts;
      this.snapshot = { ...this.snapshot, state: "starting", message: `Starting the Prime Agent daemon (attempt ${attempt}).` };
      const result = await this.launch(this.options.socketPath).catch(error => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
      if (this.closed) break;
      if (result.ok && await this.answers(this.options.socketPath)) {
        this.options.log(`daemon: attempt ${attempt} started the daemon on ${this.options.socketPath}: ${result.message}`);
        continue;
      }
      const wait = backoff[Math.min(failures, backoff.length - 1)]!;
      failures++;
      this.snapshot = { ...this.snapshot, state: "down", message: result.message };
      this.options.log(`daemon: attempt ${attempt} failed on ${this.options.socketPath}: ${result.message}. Next attempt in ${seconds(wait)}.`);
      await this.sleep(wait);
    }
    this.snapshot = { ...this.snapshot, state: "stopped" };
  }

  /**
   * Resolves when the watched connection closes, at once if it cannot connect, or when the keeper closes. The socket and the timers are
   * unref'd, so the keeper alone never keeps the chat process alive.
   */
  private async watch(): Promise<void> {
    await new Promise<void>(resolve => {
      const socket = createConnection(this.options.socketPath);
      const done = () => { this.stopWatch = undefined; socket.destroy(); resolve(); };
      this.stopWatch = done;
      socket.unref();
      socket.resume();
      socket.once("error", done);
      socket.once("close", done);
      if (this.closed) done();
    });
  }
}
