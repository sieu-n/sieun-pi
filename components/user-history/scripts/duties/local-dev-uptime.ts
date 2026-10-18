import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { loadHosts, roleUrl } from "../../src/hosts.ts";

/**
 * The local dev uptime duty's precheck (`node --import tsx scripts/duties/local-dev-uptime.ts`): how many of the 4 dev services gave no
 * 200 within 5 s, and pm2 restarts of search since the last run. Each service's answer and time goes into the flagged items as run detail.
 * No model call. The wiki is the one server at the wiki host of hosts.json (the llm-wiki app of the pm2 dev stack).
 * Convex and the crawler API may run on another box behind local port forwards; their URLs are the ones the search dev app uses (apps/search/.env.local).
 * When that file points a service away from this machine (`pnpm dev:crawler staging`), the local one is off by design and does not count as down.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
/** The owner's 200 check: an answer slower than 5 s counts as no answer. */
export const ANSWER_TIMEOUT_MS = 5000;

/** A service: its metric key prefix, and either a fixed URL or the search app's env key for its base URL plus the health path. */
export type Service = { key: string; url: string } | { key: string; envKey: string; path: string };
export const SERVICES: readonly Service[] = [
  { key: "search", url: "http://localhost:5174/" },
  { key: "convex", envKey: "PUBLIC_CONVEX_URL", path: "/version" },
  { key: "crawler", envKey: "CRAWLER_API_URL", path: "/health" },
];
/** pm2 processes whose restarts the duty counts. */
export const PM2_NAMES = ["search"] as const;

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[], env?: Record<string, string>) => Promise<string>;
/** `platform` is the OS of the host whose pm2 and localhost services this run measures; `read` gives a file's text or throws. */
export interface UptimeDeps { fetch: typeof fetch; exec: Exec; read: (path: string) => Promise<string>; platform: NodeJS.Platform; now: () => number;
  pm2: { bin: string; home: string }; env: Record<string, string>; wiki: string }
/** pm2's restart count per process name, kept between runs. */
export interface UptimeState { restarts: Record<string, { restartTime: number; at: number }> }
interface Pm2Process { name?: string; pid?: number; pm2_env?: { restart_time?: number; status?: string } }

/**
 * Whether the page answers 200, how long it took, and the first line of any other answer's body; a timeout or a network error is no answer.
 * The wiki is probed at its public URL, so the request carries the tailnet Host header that Vite's server.allowedHosts checks
 * (from 02:42Z on 10-18 it answered 403 "Blocked request. This host ... is not allowed" there while 127.0.0.1:5176 answered 200).
 */
export async function probe(deps: Pick<UptimeDeps, "fetch" | "now">, url: string): Promise<{ status: number; ms: number; error?: string; body?: string }> {
  const start = deps.now();
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS), redirect: "manual" });
    const text = await response.text();
    if (response.status === 200) return { status: 200, ms: deps.now() - start };
    return { status: response.status, ms: deps.now() - start, body: text.trim().split("\n")[0]!.slice(0, 200) };
  } catch (error) {
    return { status: 0, ms: deps.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The measured host's load averages and swap in use, for the line a down service gets: sysctl on macOS, /proc on Linux. */
export async function hostLoad(deps: Pick<UptimeDeps, "exec" | "read" | "platform">): Promise<string> {
  if (deps.platform === "darwin") return (await deps.exec("sysctl", ["-n", "vm.loadavg", "vm.swapusage"])).replace(/\s+/g, " ").trim();
  const [loadavg, meminfo] = await Promise.all([deps.read("/proc/loadavg"), deps.read("/proc/meminfo")]);
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1] ?? NaN);
  return `${loadavg.trim().split(/\s+/).slice(0, 3).join(" ")}, swap used ${Math.round((kb("SwapTotal") - kb("SwapFree")) / 1024)} MB of ${Math.round(kb("SwapTotal") / 1024)} MB`;
}

/** Restarts since the last run. A pm2 count lower than the saved one means pm2 itself started over, so all of today's count is new. */
export function restartsSince(previous: { restartTime: number } | undefined, restartTime: number): number {
  if (!previous) return 0;
  return restartTime >= previous.restartTime ? restartTime - previous.restartTime : restartTime;
}

/** KEY=value lines of a dotenv file; quotes and a trailing ` # comment` are dropped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]!] = match[2]!.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

/** The URL to probe, or why the service is not probed: off by design (the app uses a remote one) or a config error. */
export function target(service: Service, env: Record<string, string>): { url: string } | { off: string } | { error: string } {
  if ("url" in service) return { url: service.url };
  const base = env[service.envKey];
  if (!base || base.startsWith("encrypted:")) return { error: `${service.envKey} is not set in plain text in apps/search/.env.local` };
  const host = URL.canParse(base) ? new URL(base).hostname : "";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return { off: `stopped by design: the search dev app uses ${service.envKey}=${base}, not a local ${service.key}` };
  return { url: base.replace(/\/+$/, "") + service.path };
}

export async function measureUptime(deps: UptimeDeps, previous: UptimeState | undefined): Promise<{ output: PrecheckOutput; state?: UptimeState }> {
  const flagged: FlaggedSlice[] = [];
  const metrics = { servers_not_answering: 0, restarts: 0 };
  const at = deps.now();
  const answers = await Promise.all([{ key: "wiki", url: deps.wiki + "/" }, ...SERVICES].map(async (service): Promise<FlaggedSlice> => {
    const where = target(service, deps.env);
    if ("off" in where) return { at, kind: "by_design", excerpt: `${service.key}: ${where.off}` };
    if ("error" in where) return { at, kind: "down", excerpt: `${service.key}: ${where.error}` };
    const answer = await probe(deps, where.url);
    if (answer.status === 200) return { at, kind: "answer", excerpt: `${service.key}: GET ${where.url} gave 200 in ${answer.ms} ms` };
    const body = answer.body ? `: ${answer.body}` : "";
    return { at, kind: "down", excerpt: `${service.key}: GET ${where.url} gave ${answer.error ?? `HTTP ${answer.status}`} after ${answer.ms} ms${body}` };
  }));
  metrics.servers_not_answering = answers.filter(answer => answer.kind === "down").length;
  flagged.push(...answers);
  if (metrics.servers_not_answering) {
    const load = await hostLoad(deps).catch((error: unknown) => `unread: ${String(error)}`);
    flagged.push({ at, kind: "mac", excerpt: `${deps.platform === "darwin" ? "Mac" : "Host"} at the probe: load ${load}`.slice(0, 300) });
  }

  let list: Pm2Process[];
  try {
    const text = await deps.exec(deps.pm2.bin, ["jlist"], { PM2_HOME: deps.pm2.home });
    list = JSON.parse(text.slice(text.indexOf("["))) as Pm2Process[];
  } catch (error) {
    flagged.push({ at, kind: "pm2", excerpt: `pm2 (PM2_HOME ${deps.pm2.home}): pm2 jlist failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    return { output: { metrics, flagged } };
  }
  const state: UptimeState = { restarts: {} };
  for (const name of PM2_NAMES) {
    const proc = list.find(candidate => candidate.name === name);
    if (!proc?.pid) { flagged.push({ at, kind: "pm2", excerpt: `pm2 has no live ${name} process (status ${proc?.pm2_env?.status ?? "missing"})` }); continue; }
    const restartTime = proc.pm2_env?.restart_time ?? 0;
    const before = previous?.restarts[name];
    const restarts = restartsSince(before, restartTime);
    metrics.restarts += restarts;
    state.restarts[name] = { restartTime, at };
    if (!before) flagged.push({ at, kind: "baseline", excerpt: `first run: pm2 restart count ${restartTime} of ${name} saved as the baseline` });
    else if (restarts > 0) flagged.push({ at, kind: "restarts", excerpt: `pm2 restarted ${name} ${restarts} times since ${new Date(before.at).toISOString()} (count ${before.restartTime} to ${restartTime})` });
  }
  return { output: { metrics, flagged }, state };
}

const exec: Exec = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("local-dev-uptime: OUTPUT_FILE is not set\n"); process.exit(2); }
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(text => JSON.parse(text) as UptimeState, () => undefined) : undefined;
  const env = await readFile(join(REPO, "apps/search/.env.local"), "utf8").then(parseEnv, () => ({}));
  const wiki = roleUrl(await loadHosts(), "wiki");
  if (!wiki) { process.stderr.write("local-dev-uptime: no host holds the wiki role in hosts.json\n"); process.exit(2); }
  const result = await measureUptime({ fetch, exec, read: path => readFile(path, "utf8"), platform: process.platform, now: Date.now, env, wiki, pm2: { bin: join(REPO, "node_modules/.bin/pm2"), home: join(REPO, ".cache/pm2-dev") } },
    previous?.restarts ? previous : undefined);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && result.state) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
