import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { loadHosts, roleUrl } from "../../src/hosts.ts";
import { treeMb, treePids } from "./demo-sandbox.ts";
import { readWatch, type UsableMiss, unusable, type WatchLine } from "../../src/mac-usable-watch.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import { hostViews } from "./whole-system.ts";

/**
 * The local dev uptime duty's precheck (`node --import tsx scripts/duties/local-dev-uptime.ts`): how many of the 5 dev services gave no
 * 200 within 5 s, the wiki's real memory against its cap, and restarts of the wiki and search since the last run. Each service's answer and time
 * goes into the flagged items as run detail. No model call. The wiki is the one server at the wiki host of hosts.json. On us-metal02 it runs as
 * llm-wiki.service under systemd (deploy/linux/llm-wiki.service) and elsewhere as the llm-wiki app of the pm2 dev stack, so its memory and
 * restarts come from whichever of the two holds it.
 * Convex and the crawler API may run on another box behind local port forwards; their URLs are the ones the search dev app uses (apps/search/.env.local).
 * When that file points a service away from this machine (`pnpm dev:crawler staging`), the local one is off by design and does not count as down.
 * It also reads the owner's Mac: mac_servers_not_answering counts which of its search app, design demo, Vent and crawler API gave no 200 over ssh,
 * mac_convex_push_stale is 1 when its Convex watcher's newest push failed and no push succeeded after the newest convex/ change, mac_unusable_min
 * counts the minutes of the last 24 h that the Mac usable watch read unusable (src/mac-usable-watch.ts USABLE, the same line d7 judges a minute
 * by), and mac_unreachable is 1 when ssh cannot reach it (asleep), which fails no check.
 * store_box_swap_used_mb reads the M2 Air store box that hosts local Convex and the dev stores over ssh, with its memory pressure level and
 * its three biggest processes as run detail.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
/** The owner's 200 check: an answer slower than 5 s counts as no answer. */
export const ANSWER_TIMEOUT_MS = 5000;
/** The wiki's memory cap, the one dev-guard kills it over. */
export const CAP_MB = 4096;
export const WIKI_UNIT = "llm-wiki.service";

/** A service: its metric key prefix, and either a fixed URL or the search app's env key for its base URL plus the health path. */
export type Service = { key: string; url: string } | { key: string; envKey: string; path: string };
export const SERVICES: readonly Service[] = [
  { key: "search", url: "http://localhost:5174/" },
  { key: "api-portal", url: "http://localhost:5175/" },
  { key: "convex", envKey: "PUBLIC_CONVEX_URL", path: "/version" },
  { key: "crawler", envKey: "CRAWLER_API_URL", path: "/health" },
];
/** The owner's Mac (the `mac` alias of ~/.ssh/config.d/mac.conf), its dev servers, and the targets that keep it usable (owner, 10-09: "have it your duty to have usable mac"). */
export const MAC_HOST = "mac";
/**
 * Vent :8791 carries every Clerk call of the search app; it answers 401 on / and 200 only on /healthz. :8787 is the Mac's forward to the
 * local crawler on the M2 Air store box, which restarted from 10-26 04:40Z to 10-27 17:51Z on a squashed Alembic revision while no d1 metric
 * read it.
 */
export const MAC_PORTS = [{ port: 5174, name: "search app", path: "/" }, { port: 5180, name: "design demo", path: "/" },
  { port: 8791, name: "Vent", path: "/healthz" }, { port: 8787, name: "crawler API", path: "/health" }] as const;
/**
 * The window mac_unusable_min covers, one day, so a daily run reads every minute since the last one. A single 1-min load sample said nothing
 * about the owner's Mac: from 04:28Z to 08:27Z on 10-23, 174 of 312 30-s samples read load 20 or more, and the watch read 2 of those minutes
 * unusable (~/work/mac-load-root-cause/metric-findings.md on us-metal02).
 */
export const MAC_WINDOW_MS = 24 * 60 * 60_000;
/**
 * The Mac's Convex watcher: `convex-watcher.mjs status --json` gives its newest push and last good push from the pm2 log, and the newest
 * mtime under convex/ says whether a change came after that good push. Both are local times in the same format, so they compare as text.
 */
export const MAC_REPO = "$HOME/Documents/Github/auto-sns-agent";
export const MAC_CONVEX_COMMAND = `(cd "${MAC_REPO}" && echo "convex-push $("$HOME/.hermes/node/bin/node" scripts/repo/agent/convex-watcher.mjs status --json 2>/dev/null | tr -d '\\n')"; `
  + `echo "convex-src $(find convex -type f -not -path 'convex/_generated/*' -not -path '*/node_modules/*' -exec stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' {} + | sort | tail -1)")`;
/** One read-only shell line on the Mac: load averages and free memory as run detail, each dev server's HTTP code within the owner's 5 s (000 is no answer), and the Convex watcher's push state. */
export const MAC_COMMAND = ["sysctl -n vm.loadavg", "memory_pressure -Q",
  ...MAC_PORTS.map(({ port, path }) => `curl -s -o /dev/null -m ${ANSWER_TIMEOUT_MS / 1000} -w 'port ${port} %{http_code}\\n' http://localhost:${port}${path}`),
  MAC_CONVEX_COMMAND, "exit 0"].join("; ");

/** The M2 Air store box, the m2-air target of auto-sns-agent ops/dev-boxes/install.sh (ops/runbooks/local-runtime.md there). */
export const STORE_BOX = "a.@100.84.91.26";
/**
 * The store box's swap ceiling.
 * measured: from 10-13 to 10-27 the Mac's Convex watcher pushed 58 times while node_memory_swap_used_bytes{box="m2-air"} read under 6.0 GB and
 * no schema eval passed its 1 s limit, and 27 times at 6.0 GB or more with 4 that did (first at 6.16 GB on 10-22), as the box's swap grew from
 * 3.8 to 8.9 GB with sandboxd at 5.4 GB and System Events at 1.2 GB (board step p560).
 */
export const STORE_SWAP_MB = 6000;
/** Swap use and the macOS memory pressure level (1 normal, 2 warn, 4 critical), then the three processes with the most memory, swapped and compressed pages included. */
export const STORE_COMMAND = "sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level; top -l 1 -o mem -n 3 -stats command,mem,cmprs | tail -3";
export const PRESSURE_NAMES: Record<number, string> = { 1: "normal", 2: "warn", 4: "critical" };

/** Parses STORE_COMMAND's output: `total = 9216.00M  used = 8525.44M  free = 690.56M  (encrypted)`, the pressure level, then the top lines. */
export function parseStoreBox(text: string): { swapUsedMb: number; pressureLevel: number; top: string[] } {
  const lines = text.trim().split("\n");
  const swapUsedMb = Number(/used = ([\d.]+)M/.exec(lines[0] ?? "")?.[1]);
  const pressureLevel = Number(lines[1]?.trim());
  if (!Number.isFinite(swapUsedMb) || !Number.isInteger(pressureLevel) || !lines[1]?.trim()) throw new Error(`unparsed store box reading: ${text.trim().slice(0, 200)}`);
  return { swapUsedMb: Math.round(swapUsedMb), pressureLevel, top: lines.slice(2).map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean) };
}

/** Reads the store box over ssh. ssh exit 255 means it could not reach the box, which leaves store_box_swap_used_mb unmeasured. */
export async function measureStoreBox(deps: Pick<UptimeDeps, "exec">, at: number): Promise<{ metrics: Record<string, number>; flagged: FlaggedSlice[] }> {
  let reading: ReturnType<typeof parseStoreBox>;
  try {
    reading = parseStoreBox(await deps.exec("ssh", ["-o", "BatchMode=yes", STORE_BOX, STORE_COMMAND]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = (error as { code?: unknown }).code === 255 ? "store_box_unreachable" : "store_box_read";
    return { metrics: {}, flagged: [{ at, kind, excerpt: `Store box ${STORE_BOX}: read failed: ${message}`.slice(0, 300) }] };
  }
  const over = reading.swapUsedMb > STORE_SWAP_MB;
  const pressure = PRESSURE_NAMES[reading.pressureLevel] ?? `level ${reading.pressureLevel}`;
  return { metrics: { store_box_swap_used_mb: reading.swapUsedMb },
    flagged: [{ at, kind: over ? "store_box_swap" : "store_box", excerpt: `Store box: ${reading.swapUsedMb} MB swap used${over ? `, over the ${STORE_SWAP_MB} MB line where local Convex schema evals start to pass 1 s` : ""}, memory pressure ${pressure}, top ${reading.top.join("; ")}`.slice(0, 300) }] };
}

/**
 * A Mac read with a dev server that gave no 200 is read again after this wait, so a normal pm2 restart is not a miss.
 * measured: after one pm2 restart of :5180 at 16:58:57 KST on 10-26, / refused for 11 s, timed out twice behind the seed and answered 200 from 24 s on (5180 cold answer fix, board step p506).
 */
export const MAC_RETRY_MS = 30_000;

/** The watcher's newest push as convex-push-state.mjs reads it: `ok`, `failed`, `running` or `unknown`, with local times. */
export interface ConvexPush { outcome: string; at: string | null; reason: string | null; lastGoodAt: string | null }
export interface MacReading { load1: number; freePct: number; ports: Record<number, string>; convexPush?: ConvexPush; convexSrc?: string }

/**
 * Parses MAC_COMMAND's output: `{ 7.26 6.95 7.77 }`, `System-wide memory free percentage: 37%`, one `port <n> <code>` line per server, and
 * `convex-push <status json>` and `convex-src <newest mtime>`, which stay unset when the Mac gave no readable value.
 */
export function parseMacReading(text: string): MacReading {
  const load1 = Number(/\{\s*([\d.]+)/.exec(text)?.[1]);
  const freePct = Number(/memory free percentage:\s*(\d+)%/.exec(text)?.[1]);
  if (!Number.isFinite(load1) || !Number.isFinite(freePct)) throw new Error(`unparsed Mac reading: ${text.trim().slice(0, 200)}`);
  const ports = Object.fromEntries([...text.matchAll(/^port (\d+) (\d{3})$/gm)].map(match => [Number(match[1]), match[2]!]));
  const status = /^convex-push (\{.*\})\s*$/m.exec(text)?.[1];
  let push: ConvexPush | undefined;
  try { push = status ? (JSON.parse(status) as { push?: ConvexPush }).push : undefined; } catch { push = undefined; }
  const convexSrc = /^convex-src (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\s*$/m.exec(text)?.[1];
  return { load1, freePct, ports, ...(push ? { convexPush: push } : {}), ...(convexSrc ? { convexSrc } : {}) };
}

/**
 * Whether the local Convex backend serves functions older than convex/: the watcher's newest push failed and no push succeeded after the
 * newest change under convex/. From 10-22 17:49Z to 10-27 every push failed while status read healthy, and the backend served 4-day-old
 * functions. Undefined when the Mac gave no push state or no source time.
 */
export function convexPushStale(reading: MacReading): { stale: boolean; detail: string } | undefined {
  const push = reading.convexPush;
  if (!push || !reading.convexSrc) return undefined;
  const stale = push.outcome === "failed" && (!push.lastGoodAt || push.lastGoodAt < reading.convexSrc);
  const reason = push.reason ? `: ${push.reason.split("\n")[0]}` : "";
  return { stale, detail: `Convex watcher: newest push ${push.outcome} at ${push.at ?? "?"}${push.outcome === "failed" ? reason : ""}, last good push ${push.lastGoodAt ?? "none in the log tail"}, newest convex/ change ${reading.convexSrc} (Mac local time)` };
}

/** Each Mac dev server that gave no 200, in plain words. */
export function macDown(reading: MacReading): string[] {
  return MAC_PORTS.filter(({ port }) => reading.ports[port] !== "200")
    .map(({ port, name }) => `${name} :${port} gave ${reading.ports[port] === "000" || !reading.ports[port] ? "no answer" : `HTTP ${reading.ports[port]}`}`);
}

/** The minutes of `lines` that carry a Mac reading, how many of them read unusable, and how many each miss caused. */
export function macUnusableMinutes(lines: readonly WatchLine[]): { read: number; unusable: number; by: Partial<Record<UsableMiss, number>> } {
  const by: Partial<Record<UsableMiss, number>> = {};
  let read = 0, bad = 0;
  for (const line of lines) {
    const usable = hostViews(line).find(view => view.name === MAC_HOST)?.usable;
    if (!usable) continue;
    read++;
    const missed = unusable(usable);
    if (missed.length) bad++;
    for (const miss of missed) by[miss] = (by[miss] ?? 0) + 1;
  }
  return { read, unusable: bad, by };
}

/**
 * Reads the Mac over ssh (or in place when this run is on the Mac). ssh exits 255 when it cannot reach the host, which is a sleeping or
 * offline Mac: that sets mac_unreachable and leaves mac_servers_not_answering unmeasured. mac_unusable_min comes from the watch lines either way.
 */
export async function measureMac(deps: Pick<UptimeDeps, "exec" | "platform" | "watch" | "wait">, at: number): Promise<{ metrics: Record<string, number>; flagged: FlaggedSlice[] }> {
  const day = macUnusableMinutes(await deps.watch().catch(() => []));
  const usable: FlaggedSlice = day.read
    ? { at, kind: day.unusable ? "mac_unusable" : "mac_usable", excerpt: `Mac: ${day.unusable} of ${day.read} watched minutes in the last 24 h read unusable${day.unusable ? ` (${Object.entries(day.by).map(([miss, n]) => `${miss} ${n}`).join(", ")})` : ""}` }
    : { at, kind: "mac_read", excerpt: "Mac: the usable watch holds no Mac minute in the last 24 h" };
  const watched = day.read ? { mac_unusable_min: day.unusable } : {};
  const read = () => deps.platform === "darwin" ? deps.exec("sh", ["-c", MAC_COMMAND]) : deps.exec("ssh", [MAC_HOST, MAC_COMMAND]);
  let text: string;
  try {
    text = await read();
    if (macDown(parseMacReading(text)).length) {
      await deps.wait(MAC_RETRY_MS);
      text = await read();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { code?: unknown }).code === 255) return { metrics: { ...watched, mac_unreachable: 1 }, flagged: [usable, { at, kind: "mac_unreachable", excerpt: `Mac: ssh ${MAC_HOST} could not reach it (asleep or offline), so its dev servers were not read: ${message}`.slice(0, 300) }] };
    return { metrics: watched, flagged: [usable, { at, kind: "mac_read", excerpt: `Mac: read failed: ${message}`.slice(0, 300) }] };
  }
  const reading = parseMacReading(text);
  const down = macDown(reading);
  const summary = `load ${reading.load1}, ${reading.freePct}% memory free, ${MAC_PORTS.map(({ port }) => `:${port} ${reading.ports[port] ?? "unread"}`).join(", ")}`;
  const convex = convexPushStale(reading);
  const convexFlag: FlaggedSlice = convex
    ? { at, kind: convex.stale ? "mac_convex_stale" : "mac_convex", excerpt: convex.detail.slice(0, 300) }
    : { at, kind: "mac_read", excerpt: `Mac: no Convex watcher push state or convex/ mtime in the read: ${(/^convex-(push|src).*$/gm.exec(text)?.[0] ?? "no convex lines").slice(0, 200)}` };
  return { metrics: { ...watched, mac_servers_not_answering: down.length, mac_unreachable: 0, ...(convex ? { mac_convex_push_stale: convex.stale ? 1 : 0 } : {}) },
    flagged: [usable, { at, kind: down.length ? "mac_down" : "mac_answer", excerpt: (down.length ? `Mac dev servers not answering 200: ${down.join(", ")} (${summary})` : `Mac dev servers answer: ${summary}`).slice(0, 300) }, convexFlag] };
}

/** pm2 processes whose restarts the duty counts. The wiki counts here only where pm2 runs it. */
export const PM2_NAMES = ["llm-wiki", "search"] as const;

/** Runs a program with no shell and gives its stdout. */
export type Exec = (file: string, args: readonly string[], env?: Record<string, string>) => Promise<string>;
/** `platform` is the OS of the host whose pm2 and localhost services this run measures; `read` gives a file's text or throws; `watch` gives the last 24 h of Mac usable watch lines; `wait` sleeps. */
export interface UptimeDeps { fetch: typeof fetch; exec: Exec; read: (path: string) => Promise<string>; platform: NodeJS.Platform; now: () => number; watch: () => Promise<WatchLine[]>; wait: (ms: number) => Promise<void>;
  pm2: { bin: string; home: string }; env: Record<string, string>; wiki: string }
/** The restart count per pm2 process name or systemd unit, kept between runs; a unit also keeps its InvocationID, which changes at each start. */
export interface UptimeState { restarts: Record<string, { restartTime: number; at: number; invocation?: string }> }
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

/** `systemctl show` output as a map: one `Key=value` per line. */
export function parseShow(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

/**
 * Restarts of a systemd unit since the last run. NRestarts counts the automatic restarts and goes back to 0 at a manual start, and the
 * InvocationID changes at every start, so a new InvocationID with no NRestarts rise is one manual restart.
 */
export function unitRestartsSince(previous: { restartTime: number; invocation?: string } | undefined, nRestarts: number, invocation: string): number {
  if (!previous || previous.invocation === invocation) return 0;
  return Math.max(1, nRestarts >= previous.restartTime ? nRestarts - previous.restartTime : nRestarts + 1);
}

/** The wiki's systemd unit when this host loads it: its pids from the unit's cgroup, its restart count and its InvocationID. */
export async function wikiUnit(deps: Pick<UptimeDeps, "exec" | "read" | "platform">): Promise<{ pids: number[]; nRestarts: number; invocation: string; memoryCurrentMb: number } | undefined> {
  if (deps.platform !== "linux") return undefined;
  const show = parseShow(await deps.exec("systemctl", ["--user", "show", WIKI_UNIT, "-p", "LoadState,ActiveState,ControlGroup,NRestarts,InvocationID,MemoryCurrent"]));
  if (show.LoadState !== "loaded") return undefined;
  if (show.ActiveState !== "active" || !show.ControlGroup) throw new Error(`${WIKI_UNIT} is ${show.ActiveState}`);
  const pids = (await deps.read(`/sys/fs/cgroup${show.ControlGroup}/cgroup.procs`)).split("\n").filter(Boolean).map(Number);
  return { pids, nRestarts: Number(show.NRestarts), invocation: show.InvocationID ?? "", memoryCurrentMb: Math.round(Number(show.MemoryCurrent) / 1024 / 1024) };
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
  const metrics: Record<string, number> & { servers_not_answering: number; restarts: number } = { servers_not_answering: 0, restarts: 0 };
  const at = deps.now();
  const mac = measureMac(deps, at).catch((error: unknown): Awaited<ReturnType<typeof measureMac>> =>
    ({ metrics: {}, flagged: [{ at, kind: "mac_read", excerpt: `Mac: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }] }));
  const store = measureStoreBox(deps, at);
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
  const macResult = await mac;
  Object.assign(metrics, macResult.metrics);
  flagged.push(...macResult.flagged);
  const storeResult = await store;
  Object.assign(metrics, storeResult.metrics);
  flagged.push(...storeResult.flagged);
  if (metrics.servers_not_answering) {
    const load = await hostLoad(deps).catch((error: unknown) => `unread: ${String(error)}`);
    flagged.push({ at, kind: "mac", excerpt: `${deps.platform === "darwin" ? "Mac" : "Host"} at the probe: load ${load}`.slice(0, 300) });
  }

  const state: UptimeState = { restarts: {} };
  const memory = (where: string, pids: readonly number[], mb: number, extra = "") => {
    metrics.wiki_footprint_mb = mb;
    flagged.push({ at, kind: mb > CAP_MB ? "memory" : "wiki_memory", excerpt: `wiki: ${where} (pids ${pids.join(", ")}) holds ${mb} MB of Pss and SwapPss${extra}${mb > CAP_MB ? `, over the ${CAP_MB} MB cap` : ""}`.slice(0, 300) });
  };
  const count = (name: string, restarts: number, before: { restartTime: number; at: number } | undefined, restartTime: number, what: string) => {
    metrics.restarts += restarts;
    if (!before) flagged.push({ at, kind: "baseline", excerpt: `first run: ${what} restart count ${restartTime} of ${name} saved as the baseline` });
    else if (restarts > 0) flagged.push({ at, kind: "restarts", excerpt: `${what} restarted ${name} ${restarts} times since ${new Date(before.at).toISOString()} (count ${before.restartTime} to ${restartTime})` });
  };
  let unit: Awaited<ReturnType<typeof wikiUnit>>;
  try {
    unit = await wikiUnit(deps);
    if (unit) {
      memory(WIKI_UNIT, unit.pids, await treeMb(deps, unit.pids), `, memory.current ${unit.memoryCurrentMb} MB with page cache`);
      const before = previous?.restarts[WIKI_UNIT];
      count(WIKI_UNIT, unitRestartsSince(before, unit.nRestarts, unit.invocation), before, unit.nRestarts, "systemd");
      state.restarts[WIKI_UNIT] = { restartTime: unit.nRestarts, at, invocation: unit.invocation };
    }
  } catch (error) {
    flagged.push({ at, kind: "wiki_memory", excerpt: `${WIKI_UNIT}: read failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
  }

  let list: Pm2Process[];
  try {
    const text = await deps.exec(deps.pm2.bin, ["jlist"], { PM2_HOME: deps.pm2.home });
    list = JSON.parse(text.slice(text.indexOf("["))) as Pm2Process[];
  } catch (error) {
    flagged.push({ at, kind: "pm2", excerpt: `pm2 (PM2_HOME ${deps.pm2.home}): pm2 jlist failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    return { output: { metrics, flagged }, state };
  }
  for (const name of PM2_NAMES) {
    if (name === "llm-wiki" && unit) continue;
    const proc = list.find(candidate => candidate.name === name);
    if (!proc?.pid) { flagged.push({ at, kind: "pm2", excerpt: `pm2 has no live ${name} process (status ${proc?.pm2_env?.status ?? "missing"})` }); continue; }
    const restartTime = proc.pm2_env?.restart_time ?? 0;
    const before = previous?.restarts[name];
    count(name, restartsSince(before, restartTime), before, restartTime, "pm2");
    state.restarts[name] = { restartTime, at };
    if (name !== "llm-wiki") continue;
    try {
      const pids = treePids(await deps.exec("ps", ["-axo", "pid=,ppid="]), proc.pid);
      memory(`pm2 ${name}`, pids, await treeMb(deps, pids));
    } catch (error) {
      flagged.push({ at, kind: "wiki_memory", excerpt: `pm2 ${name}: memory read failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
    }
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
  const watch = () => readWatch(chatDataDir(), Date.now() - MAC_WINDOW_MS, Date.now());
  const result = await measureUptime({ fetch, exec, read: path => readFile(path, "utf8"), platform: process.platform, now: Date.now, watch, wait: ms => delay(ms), env, wiki, pm2: { bin: join(REPO, "node_modules/.bin/pm2"), home: join(REPO, ".cache/pm2-dev") } },
    previous?.restarts ? previous : undefined);
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && result.state) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
