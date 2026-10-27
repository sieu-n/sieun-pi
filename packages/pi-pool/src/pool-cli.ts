import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi-pool's credential hook, the same file Prime's models.json runs. `PI_POOL_TOKEN_BIN` points a rig at a stand-in. */
export function defaultPoolBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_POOL_TOKEN_BIN) return env.PI_POOL_TOKEN_BIN;
  return join(env.PI_POOL_DIR || join(homedir(), ".config", "pi-pool"), "bin", "pi-pool-token");
}

/** The session tree a pool call speaks for. pi-pool's registry.session_key() reads it from PI_POOL_SESSION_KEY. */
export interface TreeKey {
  /** The root session's id, which keys the tree in state.json and turns.json. */
  root: string;
  /** The session that makes the call, the root itself or an RLM child. */
  session: string;
}

/** Prime sets this when it reads exit 75 with {"retryAt", "message"} as "no credential until retryAt". */
const PROTOCOL_ENV = "PRIME_CREDENTIAL_COMMAND_PROTOCOL";
const SLOT_WAIT_EXIT = 75;

/**
 * The environment of one pool call. Prime's worker variables are dropped, so a pi-host started from a Prime session
 * never speaks for that Prime session, and the agent dir tells `adopt-logins` which auth.json to read.
 */
export function poolEnv(key: TreeKey | undefined, agentDir: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (!name.startsWith("PRIME_AGENT_INTERNAL_")) env[name] = value;
  delete env.PI_POOL_SESSION_KEY;
  if (key) env.PI_POOL_SESSION_KEY = JSON.stringify({ key: key.root, uuid: key.root, active: key.session });
  if (agentDir) env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
  return env;
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the pool hook once. Never throws: a spawn failure or a kill comes back as a null code. */
export function runPool(bin: string, args: string[], env: NodeJS.ProcessEnv, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Run> {
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout: opts.timeoutMs ?? 10_000, signal: opts.signal, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && code === null ? error.message : "") });
    });
  });
}

/** One `pi-pool-token --provider <p>` answer. */
export type Vend =
  | { kind: "token"; token: string }
  | { kind: "wait"; retryAt: number; message: string }
  | { kind: "failed"; reason: string };

/** Reads one token-hook run: a token, the exit-75 slot wait, or the hook's own `no token (<reason>)` line. */
export function readVend(run: Run): Vend {
  if (run.code === 0 && run.stdout.trim()) return { kind: "token", token: run.stdout.trim() };
  if (run.code === SLOT_WAIT_EXIT) {
    try {
      const reply = JSON.parse(run.stdout) as { retryAt?: unknown; message?: unknown };
      if (typeof reply.retryAt === "number") return { kind: "wait", retryAt: reply.retryAt, message: typeof reply.message === "string" ? reply.message : "waiting for an account slot" };
    } catch {
      // An unreadable exit-75 answer is a failure like any other.
    }
  }
  const said = /no token \((\w+)\)/.exec(run.stderr)?.[1];
  const reason = said ?? (run.code === 0 ? "empty_result" : run.code === null ? (run.stderr.split("\n")[0] || "killed") : `exit ${run.code}`);
  return { kind: "failed", reason };
}

export async function vendOnce(bin: string, provider: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Vend> {
  return readVend(await runPool(bin, ["--provider", provider], { ...env, [PROTOCOL_ENV]: "1" }, { timeoutMs: 30_000, signal }));
}

/** Resolves after `ms`, or at once when `signal` aborts. Returns false on an abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** How often a slot wait asks the pool again, so a slot that frees early starts the request early. */
export const WAIT_ASK_MS = 30_000;
/** Tries per request when the hook gives no token for a reason other than a slot wait. */
export const VEND_TRIES = 3;

export type Credential = { kind: "token"; token: string } | { kind: "aborted" } | { kind: "failed"; reason: string };

/**
 * One request's credential. A slot wait (exit 75) waits inside this call until the slot, asking again every
 * WAIT_ASK_MS, with no time limit; this replaces Prime's exit-75 credential wait. `onWait` gets each wait and
 * a final undefined. An abort of `signal`, such as Escape, ends the wait at once.
 */
export async function credential(
  vend: (signal?: AbortSignal) => Promise<Vend>,
  signal: AbortSignal | undefined,
  onWait: (wait: { retryAt: number; message: string } | undefined) => void,
  now: () => number = Date.now,
): Promise<Credential> {
  let failures = 0;
  let waited = false;
  const done = (result: Credential): Credential => {
    if (waited) onWait(undefined);
    return result;
  };
  for (;;) {
    if (signal?.aborted) return done({ kind: "aborted" });
    const answer = await vend(signal);
    if (signal?.aborted) return done({ kind: "aborted" });
    if (answer.kind === "token") return done(answer);
    if (answer.kind === "wait") {
      failures = 0;
      waited = true;
      onWait({ retryAt: answer.retryAt, message: answer.message });
      const ms = Math.min(Math.max(1000, answer.retryAt * 1000 - now()), WAIT_ASK_MS);
      if (!(await sleep(ms, signal))) return done({ kind: "aborted" });
      continue;
    }
    failures++;
    if (failures >= VEND_TRIES) return done(answer);
    if (!(await sleep(1000 * 2 ** (failures - 1), signal))) return done({ kind: "aborted" });
  }
}
