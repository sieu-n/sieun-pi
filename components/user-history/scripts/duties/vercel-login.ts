import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Vercel token a duty precheck sends: VERCEL_TOKEN when set, else the Vercel CLI login. The CLI login is an OAuth login whose access
 * token lives 8 h (a `vercel whoami` at 19:13Z on 10-25 wrote expiresAt 03:13Z on 10-26), and only a CLI run refreshes it from its
 * refreshToken. On 10-25 at 18:00Z Slack green deploys read a login nobody had refreshed for 8 h and Vercel answered 403 invalidToken,
 * so this reads the login, runs `vercel whoami` when the token has expired, and reads it again. Callers read the token once per API
 * call, so a token that expires during a run is refreshed by the next call.
 */

export interface VercelLogin { token?: string; expiresAt?: number }
export interface VercelLoginDeps {
  env: NodeJS.ProcessEnv;
  authPath: string;
  now: () => number;
  read: (path: string) => Promise<string>;
  refresh: () => Promise<void>;
}

/** Where the Vercel CLI keeps its login: ~/Library/Application Support on macOS, $XDG_DATA_HOME or ~/.local/share elsewhere. */
export function vercelAuthPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dataDir = platform === "darwin" ? join(home, "Library/Application Support") : env.XDG_DATA_HOME || join(home, ".local/share");
  return join(dataDir, "com.vercel.cli/auth.json");
}

/** The CLI's own rule (isValidAccessToken): a token with no numeric expiresAt never expires, else it is valid through that second. */
export const liveToken = (login: VercelLogin, nowMs: number): login is VercelLogin & { token: string } =>
  Boolean(login.token) && (typeof login.expiresAt !== "number" || login.expiresAt >= Math.floor(nowMs / 1000));

const run = (file: string, args: readonly string[]) => new Promise<void>((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8" }, (error, _stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve());
});

/** Any Vercel CLI command refreshes an expired login in auth.json. npx covers a box with no global `vercel` on PATH. */
export async function refreshVercelLogin(): Promise<void> {
  try { await run("vercel", ["whoami"]); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await run("npx", ["--yes", "vercel", "whoami"]);
  }
}

const defaults = (): VercelLoginDeps => ({
  env: process.env, authPath: vercelAuthPath(), now: Date.now, read: path => readFile(path, "utf8"), refresh: refreshVercelLogin,
});

export async function vercelToken(deps: VercelLoginDeps = defaults()): Promise<string> {
  if (deps.env.VERCEL_TOKEN) return deps.env.VERCEL_TOKEN;
  const read = async (): Promise<VercelLogin> => JSON.parse(await deps.read(deps.authPath)) as VercelLogin;
  const login = await read().catch(() => ({}) as VercelLogin);
  if (liveToken(login, deps.now())) return login.token;
  let failure = "";
  await deps.refresh().catch((error: unknown) => { failure = `: ${error instanceof Error ? error.message : String(error)}`; });
  const refreshed = await read().catch(() => ({}) as VercelLogin);
  if (liveToken(refreshed, deps.now())) return refreshed.token;
  throw new Error(`no live Vercel token: VERCEL_TOKEN is unset and \`vercel whoami\` did not refresh the login in ${deps.authPath}${failure}; run \`vercel login\``);
}
