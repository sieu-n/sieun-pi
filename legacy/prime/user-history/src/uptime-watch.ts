import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ALERT_ROUTES, type AlertRoute, OPS_ROUTE } from "./alert-routes.ts";
import { missing } from "./locked-json.ts";
import { TICK_MS } from "./wakes.ts";

/**
 * An off-box uptime check of crawler.virev.ai and api.virev.ai from the chat service on us-metal02. Every Grafana rule runs on us-metal01, so
 * when that box was down from 02:55Z to 05:01Z on 10-29 (p197's Docker move) the crawler and every customer crawl call through api.virev.ai
 * failed for about 2 h and nothing paged. This check needs neither us-metal01 nor obs.virev.ai: it probes each URL every TICK_MS and, once a
 * target has had no good answer for DOWN_MS, sends one agent message to the owning chats and ops guy, and one more when it answers again.
 * `<dataDir>/uptime-targets.json` may map a target name to another URL, which a forced-failure test uses; the page then says so.
 */

/** measured: the longest normal failure run in the 7 d of prod Convex apiPortalHealthProbes rows to 10-29 05:34Z was crawler /health from 03:15:01 to 03:18:08Z on 10-28 (3 min 7 s); api.virev.ai/openapi.json failed no round. */
export const DOWN_MS = 5 * 60_000;
/** measured: caddy holds crawler requests up to 228 s through a prod promote (prod.Caddyfile :8098, promote 16, 2026-10-20), so a held probe still passes, as in the Convex probe. */
export const PROBE_TIMEOUT_MS = 5 * 60_000;

export interface UptimeTarget {
  name: string;
  url: string;
  /** The top-level field the JSON body must hold with this value, as crawler /health's status "ok". */
  expect?: { field: string; value: string };
  /** What else fails while this target fails, in plain words. */
  impact: string;
  routes: readonly AlertRoute[];
}

const route = (chat: string): AlertRoute => ALERT_ROUTES.find(entry => entry.chat === chat)!;

export const UPTIME_TARGETS: readonly UptimeTarget[] = [
  { name: "crawler", url: "https://crawler.virev.ai/health", expect: { field: "status", value: "ok" },
    impact: "every customer crawl call through api.virev.ai fails with it", routes: [route("Crawler VP"), route("api portal vp"), OPS_ROUTE] },
  { name: "api", url: "https://api.virev.ai/openapi.json", impact: "customers cannot reach the commercial API at all", routes: [route("api portal vp"), OPS_ROUTE] },
];

/** One probe's answer: when it started and ended, and the error text when it failed. */
export interface Probe { startedAt: number; at: number; error: string | null }
/** Per target: the end of its last good probe (or the watch's start), its first and newest failed probe since, and when it paged. */
export interface TargetState { lastPass: number; firstFail: Probe | null; lastFail: Probe | null; pagedAt: number | null }

const minute = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)}Z`;
const span = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** The state after one probe, and the page it calls for. A target pages once it failed and has had no good probe for DOWN_MS. */
export function uptimeStep(state: TargetState, probe: Probe): { state: TargetState; send: "down" | "up" | null } {
  if (probe.error === null) {
    const next: TargetState = { lastPass: probe.at, firstFail: null, lastFail: null, pagedAt: null };
    return { state: next, send: state.pagedAt === null ? null : "up" };
  }
  const next: TargetState = { ...state, firstFail: state.firstFail ?? probe, lastFail: probe };
  if (state.pagedAt !== null || probe.at - state.lastPass < DOWN_MS) return { state: next, send: null };
  return { state: { ...next, pagedAt: probe.at }, send: "down" };
}

const forced = (target: UptimeTarget, url: string): string =>
  url === target.url ? "" : ` This probe points at ${url} from uptime-targets.json instead of ${target.url}, so this is a test.`;

export function downText(target: UptimeTarget, url: string, state: TargetState): string {
  const first = state.firstFail!, last = state.lastFail!;
  return `[uptime-down] ${url} has given no good answer since ${minute(state.lastPass)} (${span(last.at - state.lastPass)}), so ${target.impact}. ` +
    `The first failed probe at ${minute(first.startedAt)} got ${first.error}, and the newest at ${minute(last.startedAt)} got ${last.error}. ` +
    `This comes from the chat service on us-metal02, which needs neither us-metal01 nor obs.virev.ai, and one more line follows when it answers again.${forced(target, url)}`;
}

export function upText(target: UptimeTarget, url: string, before: TargetState, now: TargetState): string {
  return `[uptime-up] ${url} answers again at ${minute(now.lastPass)}; it gave no good answer from ${minute(before.lastPass)} (${span(now.lastPass - before.lastPass)}).${forced(target, url)}`;
}

/** One GET of the target: null when it passed, else what failed in plain words. */
export async function probeOnce(target: UptimeTarget, url: string, fetcher: typeof fetch = fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "sieun-pi-uptime-watch" } });
    if (!response.ok) { await response.body?.cancel(); return `HTTP ${response.status}`; }
    if (!target.expect) { await response.arrayBuffer(); return null; }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const actual = body?.[target.expect.field];
    return actual === target.expect.value ? null : `HTTP 200 with ${target.expect.field}=${JSON.stringify(actual)}`;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `no answer in ${timeoutMs / 1000} s`;
    const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
    return `${error instanceof Error ? error.message : String(error)}${cause?.code ? ` (${cause.code})` : ""}`;
  }
}

export interface UptimeDeps {
  /** `<dataDir>/uptime-watch.json`, which keeps a paged target's state over a restart, so its answer-again line still follows. */
  stateFile: string;
  /** `<dataDir>/uptime-targets.json`, an optional map of target name to URL. */
  overrideFile: string;
  deliver: (session: string, text: string, root?: string) => Promise<void>;
  log: (line: string) => void;
  targets?: readonly UptimeTarget[];
  probe?: (target: UptimeTarget, url: string) => Promise<string | null>;
  now?: () => number;
}

async function readJson(file: string, log: (line: string) => void): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; } catch (error) {
    if (!missing(error)) log(`uptime: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, file);
}

const fresh = (now: number): TargetState => ({ lastPass: now, firstFail: null, lastFail: null, pagedAt: null });

export class UptimeWatch {
  private states: Promise<Record<string, TargetState>> | null = null;
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private readonly targets: readonly UptimeTarget[];
  constructor(private readonly deps: UptimeDeps) {
    this.now = deps.now ?? Date.now;
    this.targets = deps.targets ?? UPTIME_TARGETS;
  }

  /** Starts a probe of each target that has none running, and resolves when they all end. */
  async tick(): Promise<void> {
    const states = await (this.states ??= this.restore(this.now()));
    const overrides = await readJson(this.deps.overrideFile, this.deps.log);
    const due = this.targets.filter(target => !this.running.has(target.name));
    await Promise.all(due.map(target => this.run(states, target, typeof overrides[target.name] === "string" ? overrides[target.name] as string : target.url)));
  }

  /** Only a target that paged keeps its state over a restart; any other starts fresh, so a lastPass from before the restart never pages at once. */
  private async restore(now: number): Promise<Record<string, TargetState>> {
    const kept = await readJson(this.deps.stateFile, this.deps.log) as Record<string, TargetState | undefined>;
    return Object.fromEntries(this.targets.map(target => {
      const state = kept[target.name];
      return [target.name, state && state.pagedAt !== null ? state : fresh(now)];
    }));
  }

  private async run(states: Record<string, TargetState>, target: UptimeTarget, url: string): Promise<void> {
    this.running.add(target.name);
    try {
      const startedAt = this.now();
      const error = await (this.deps.probe ?? probeOnce)(target, url);
      const before = states[target.name]!;
      const step = uptimeStep(before, { startedAt, at: this.now(), error });
      states[target.name] = step.state;
      if (!step.send) return;
      await writeJson(this.deps.stateFile, states);
      await this.page(target, step.send === "down" ? downText(target, url, step.state) : upText(target, url, before, step.state));
    } finally { this.running.delete(target.name); }
  }

  private async page(target: UptimeTarget, text: string): Promise<void> {
    for (const to of target.routes) {
      await this.deps.deliver(to.session, text, to.session)
        .catch(error => this.deps.log(`uptime: send to ${to.chat}: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.deps.log(`uptime: told ${target.routes.map(to => to.chat).join(", ")}: ${text.slice(0, 160)}`);
  }
}

export function startUptimeWatch(deps: UptimeDeps, everyMs = TICK_MS): () => void {
  const watch = new UptimeWatch(deps);
  const tick = () => void watch.tick().catch(error => deps.log(`uptime: ${error instanceof Error ? error.message : String(error)}`));
  const timer = setInterval(tick, everyMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
