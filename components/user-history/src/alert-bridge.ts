import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALERT_ROUTES, OPS_ROUTE, routeAlert } from "./alert-routes.ts";
import { missing } from "./locked-json.ts";
import type { TurnSince } from "./held-turns.ts";
import { TICK_MS } from "./wakes.ts";

/**
 * The alert bridge: each Grafana alert rule that fires for a chat with a board gets one triage job of that chat, and a later fire of the same
 * rule goes to that job by message while it still works. The bridge puts nothing on the plan. The owner, 10-18: "stop being paranoid in plan
 * under p45, p221. these should be modeled separately, like in a doc tracking all the known vps infra risks and a duty that checks these."
 * At 16:00Z that day the bridge's steps were 14 open under ops guy's "Firing prod alerts" and about 30 under Crawler VP's p146, and they
 * came back after every cleanup. Each owning chat's duty reads its firing count from this state (`firingRules`, scripts/duties/prod-alerts.ts).
 */

export const ESCALATE_MS = 30 * 60_000;
/**
 * How long a rule may still fire after the bridge gave it to a job that has since ended before the bridge starts a new job for it. ops guy
 * set 24 h on 10-18, after prod backup alerts fired from 10-16 for over 3 days with nobody on them.
 */
export const REOPEN_MS = 24 * 3_600_000;
/**
 * How soon after it resolved a rule's fire counts as the same incident. Grafana resets a rule to "Normal (Updated)" each time an obs deploy
 * provisions a change to it, and the next evaluation fires it again with a new startsAt. On 10-18 b2-prod-growth went Normal (Updated) at
 * 12:47:50Z, 16:57:03Z and 17:02:00Z and fired again 3 to 4 min later each time, and each fire started a new triage job on the same
 * blocked cause (01:46 and 02:01 KST). The slowest Grafana rule group evaluates every 300 s (70 groups read 10-18), plus one bridge tick.
 */
export const REFIRE_MS = 300_000 + TICK_MS;
export const OWNERS_PATH = "ops/alert-relay/owners.json";
export const GRAFANA_ALERTS_PATH = "/api/alertmanager/grafana/api/v2/alerts?active=true";

export interface FiringAlert { fingerprint: string; startsAt: string; alertname: string; labels: Record<string, string>; summary: string; url: string; values?: string }
/** One firing label set of a rule, keyed in `Tracked.instances` by alertKey (fingerprint@startsAt). */
export interface Instance { startsAt: string; labels: Record<string, string>; resolvedAt?: number }
/** A triage job the bridge started for a rule: its session id and name. */
export interface AlertJob { id: string; name: string }
/**
 * The triage job of a rule, and when the bridge last gave the rule to it (started it, or sent it a fire). The job holds the rule's fire only
 * once a model turn of it ended after `at` (`held`): on 10-19 job 01a15416 for metal-prod-crawler-netns-ports started at 12:15:14Z, failed
 * its first call on a pi-pool slot wait and had no turn at 14:46Z, and the bridge counted it as holding the fire, so nothing escalated.
 */
export interface RuleJob extends AlertJob { at: number;
  /** When the bridge saw the job's latest model turn end, after `at` when it holds the fire. Absent: the job never had a turn. */
  ranAt?: number;
  /** The pool slot time of the job's failed first call for which the bridge last asked the resume pass to continue it (`AlertBridgeDeps.retryJob`). */
  retriedAt?: number }
/**
 * One alert rule firing in one owning chat. `rule` is the rule uid, or the alertname when the uid label is missing. The rule resolves when
 * every instance has resolved.
 */
export interface Tracked { chat: string; rule: string; alertname: string; startsAt: string;
  /** When the rule last fired: first seen, back after it resolved, or still firing REOPEN_MS after its job ended. A job whose `at` is older owes this fire. */
  wokeAt: number;
  /** When this entry first fired; the boardless tells count from it (`dueTells`). */
  firstWokeAt: number;
  /** When the bridge last escalated the rule to ops guy, or first told a boardless owner past ESCALATE_MS. */
  escalatedAt?: number;
  resolvedAt?: number; instances: Record<string, Instance>;
  /** When the bridge last told the rule's owner, a session with no board, that it fires (`dueTells`). */
  toldAt?: number;
  job?: RuleJob }
export interface BridgeState { v: 3; rules: Record<string, Tracked> }
export interface OwnerRoute { name: string; match: Record<string, string>; owner: string }
export interface OwnerMap { owners: Record<string, string>; fallback: string; routes: OwnerRoute[] }
export type Router = (alert: FiringAlert) => string;
/** One firing rule as its triage job reads it. */
export interface AlertLine { rule: string; alertname: string; startsAt: string; firedAt: number; sets: number; summary: string; url: string; values?: string }

export const emptyState = (): BridgeState => ({ v: 3, rules: {} });
export const alertKey = (alert: Pick<FiringAlert, "fingerprint" | "startsAt">): string => `${alert.fingerprint}@${alert.startsAt}`;
export const ruleOf = (alert: FiringAlert): string => alert.labels.__alert_rule_uid__ ?? alert.alertname;
export const ruleKey = (chat: string, rule: string): string => `${chat}/${rule}`;
export const alertChat = (alert: FiringAlert): string => routeAlert([alert.alertname, ...Object.values(alert.labels)]).session;

export function ownerRoute(labels: Record<string, string>, map: OwnerMap): { owner: string; session: string } | null {
  const route = map.routes.find(route => Object.entries(route.match).every(([key, pattern]) => new RegExp(pattern).test(labels[key] ?? "")));
  return route ? { owner: route.owner, session: map.owners[route.owner]! } : null;
}

export const routerFor = (map: OwnerMap | null): Router => alert => (map && ownerRoute(alert.labels, map)?.session) ?? alertChat(alert);

export function parseOwners(value: unknown): OwnerMap {
  if (!isRecord(value) || !isRecord(value.owners) || typeof value.fallback !== "string" || !Array.isArray(value.routes)) throw new Error("owners.json needs owners, fallback and routes");
  const owners = strings(value.owners);
  const known = (name: unknown, where: string): string => {
    if (typeof name !== "string" || !owners[name]) throw new Error(`owners.json: ${where} names owner ${JSON.stringify(name)}, which has no session`);
    return name;
  };
  known(value.fallback, "fallback");
  const routes = value.routes.map((route: unknown, index): OwnerRoute => {
    if (!isRecord(route) || !isRecord(route.match)) throw new Error(`owners.json: route ${index} has no match`);
    const name = typeof route.name === "string" ? route.name : `route ${index}`;
    const match = strings(route.match);
    if (!Object.keys(match).length) throw new Error(`owners.json: route ${JSON.stringify(name)} matches nothing`);
    for (const pattern of Object.values(match)) new RegExp(pattern);
    return { name, match, owner: known(route.owner, `route ${JSON.stringify(name)}`) };
  });
  return { owners, fallback: value.fallback, routes };
}

const git = promisify(execFile);

export async function readOwners(repo: string, refs: readonly string[]): Promise<OwnerMap | null> {
  const text = await readFile(join(repo, OWNERS_PATH), "utf8").catch(async (error: unknown) => {
    if (!missing(error)) throw error;
    for (const ref of refs) {
      const shown = await git("git", ["-C", repo, "show", `${ref}:${OWNERS_PATH}`], { env: { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined } })
        .then(({ stdout }) => stdout, () => null);
      if (shown) return shown;
    }
    return null;
  });
  return text === null ? null : parseOwners(JSON.parse(text));
}

function alertValues(text: string | undefined): string {
  try {
    const values: unknown = JSON.parse(text ?? "");
    return isRecord(values) ? Object.entries(values).map(([name, value]) => `${name}=${String(value)}`).join(", ") : "";
  } catch { return ""; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

export function parseAlerts(value: unknown): FiringAlert[] {
  if (!Array.isArray(value)) throw new Error("Grafana's alert list is not a list");
  return value.flatMap(item => {
    if (!isRecord(item) || !isRecord(item.status) || item.status.state !== "active" || (isRecord(item.labels) && item.labels.severity === "test")) return [];
    const at = typeof item.startsAt === "string" ? Date.parse(item.startsAt) : NaN;
    if (typeof item.fingerprint !== "string" || !/^[\w-]{1,64}$/.test(item.fingerprint) || !Number.isFinite(at)) return [];
    const labels = strings(item.labels);
    const annotations = strings(item.annotations);
    return [{ fingerprint: item.fingerprint, startsAt: new Date(at).toISOString(), alertname: labels.alertname ?? labels.__alert_rule_uid__ ?? item.fingerprint, labels,
      summary: annotations.summary ?? "", url: typeof item.generatorURL === "string" ? item.generatorURL : "", values: alertValues(annotations.__values__) }];
  });
}

/**
 * The saved state. A version 2 state (10-15 to 10-18) also held each rule's board step, which goes; a rule that a job held through its step
 * carries that job as `job` (scripts/alert-bridge-unstep.ts wrote it before the release).
 */
export function parseState(value: unknown): BridgeState {
  if (!isRecord(value) || (value.v !== 2 && value.v !== 3) || !isRecord(value.rules)) throw new Error("Alert bridge state file is malformed.");
  if (value.v === 3) return value as unknown as BridgeState;
  const rules = value.rules as Record<string, Tracked & { step?: unknown; closedAt?: unknown }>;
  return { v: 3, rules: Object.fromEntries(Object.entries(rules).map(([key, old]) => {
    const { step: _step, closedAt: _closed, ...rule } = old;
    return [key, rule];
  })) };
}

const isResolved = (rule: Tracked): boolean => rule.resolvedAt !== undefined;
const firingSets = (rule: Tracked): number => Object.values(rule.instances).filter(instance => instance.resolvedAt === undefined).length;

/** The rules of `chat` that fire now: the count its duty reads. */
export const firingRules = (state: BridgeState, chat: string): Tracked[] => Object.values(state.rules).filter(rule => rule.chat === chat && !isResolved(rule));

/** Whether the rule's last fire still waits for a job: it has none, or the bridge gave it to its job before that fire. */
export const owed = (rule: Tracked): boolean => !isResolved(rule) && (rule.job === undefined || rule.job.at < rule.wokeAt);

/** Whether the rule's job took its last fire and had a model turn end since, so someone works the fire. */
export const held = (rule: Tracked): boolean => rule.job !== undefined && rule.job.at >= rule.wokeAt && rule.job.ranAt !== undefined && rule.job.ranAt >= rule.job.at;

/** Whether the rule's job took its last fire within REOPEN_MS and has had no model turn since: the bridge watches it for its first turn. */
const waiting = (rule: Tracked, now: number): boolean => rule.job !== undefined && rule.job.at >= rule.wokeAt && !held(rule) && now - rule.wokeAt < REOPEN_MS;

/**
 * The state after this tick's firing list, and the rules that fired: new, or back after they resolved. Each alert rule firing in an owning
 * chat is one entry, and every label set of it (lane, env and so on) is an instance of that entry. On 10-18 one proxy rule firing in 6 lanes
 * had opened 6 steps on crawler ops' board, one per Grafana fingerprint.
 *
 * 1. A firing whose instance key is already on a rule goes back to it, so a resolved rule whose same firing returns fires again on its entry.
 *    At 06:20:35Z on 10-15 one poll dropped 25 alerts at once and they came back with the same startsAt.
 * 2. Any other firing joins the open rule of its chat and rule, or opens a new one, which replaces the chat's resolved entry of that rule and
 *    keeps its job, so a live job gets the next fire.
 * 3. An instance missing from the list resolves, and the rule resolves once every instance has.
 * 4. A rule that fired sets `wokeAt`, so its job owes the fire (`owed`). A new label set on a rule that still fires is the same incident, and
 *    so is a fire within REFIRE_MS of the rule resolving, which keeps the rule's entry and its job and fires nothing.
 */
export function advance(alerts: readonly FiringAlert[], state: BridgeState, route: Router, now: number): { state: BridgeState; fired: Set<string> } {
  const rules: Record<string, Tracked> = structuredClone(state.rules);
  const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
  const fired = new Set<string>();
  const owner = new Map<string, string>();
  for (const [key, rule] of Object.entries(rules)) for (const instance of Object.keys(rule.instances)) owner.set(instance, key);
  const rest: FiringAlert[] = [];
  for (const [id, alert] of firing) {
    const key = owner.get(id);
    if (!key) { rest.push(alert); continue; }
    const rule = rules[key]!;
    if (isResolved(rule) && now - rule.resolvedAt! > REFIRE_MS) fired.add(key);
    delete rule.resolvedAt;
    rule.rule = ruleOf(alert);
    rule.instances[id] = { startsAt: alert.startsAt, labels: alert.labels };
  }
  for (const alert of rest) {
    const chat = route(alert);
    const name = ruleOf(alert);
    let key = Object.keys(rules).find(key => rules[key]!.chat === chat && rules[key]!.rule === name && !isResolved(rules[key]!));
    if (!key) {
      let job: RuleJob | undefined;
      let blip: Tracked | undefined;
      for (const [old, rule] of Object.entries(rules)) {
        if (rule.chat !== chat || !isResolved(rule) || (rule.rule !== name && rule.rule !== alert.alertname)) continue;
        job ??= rule.job;
        if (now - rule.resolvedAt! <= REFIRE_MS) blip ??= rule;
        delete rules[old];
      }
      key = ruleKey(chat, name);
      if (blip) {
        const { resolvedAt: _resolved, ...same } = blip;
        rules[key] = { ...same, rule: name, alertname: alert.alertname };
      } else {
        rules[key] = { chat, rule: name, alertname: alert.alertname, startsAt: alert.startsAt, wokeAt: now, firstWokeAt: now, instances: {}, ...job ? { job } : {} };
        fired.add(key);
      }
    }
    const rule = rules[key]!;
    for (const [id, instance] of Object.entries(rule.instances)) if (instance.resolvedAt !== undefined && id.startsWith(`${alert.fingerprint}@`)) delete rule.instances[id];
    rule.instances[alertKey(alert)] = { startsAt: alert.startsAt, labels: alert.labels };
    if (fired.has(key) && alert.startsAt < rule.startsAt) rule.startsAt = alert.startsAt;
  }
  for (const rule of Object.values(rules)) {
    if (isResolved(rule)) continue;
    for (const [id, instance] of Object.entries(rule.instances)) if (!firing.has(id) && instance.resolvedAt === undefined) rule.instances[id] = { ...instance, resolvedAt: now };
    if (Object.values(rule.instances).every(instance => instance.resolvedAt !== undefined)) rule.resolvedAt = now;
  }
  for (const key of fired) if (rules[key] && !isResolved(rules[key]!)) rules[key]!.wokeAt = now;
  return { state: { v: 3, rules }, fired: new Set([...fired].filter(key => rules[key] && !isResolved(rules[key]!))) };
}

/**
 * The firing rules whose owner has no board (`boardless`) that the bridge tells that session now: once when it first sees the rule, again at
 * ESCALATE_MS, and every REOPEN_MS after while the rule still fires. A tell that failed left `toldAt` as it was, so it goes again next tick.
 * On 10-18 prod Postgres, ClickHouse and Redis backup alerts routed to metal box owner, a root session with no board, had fired for over 3
 * days with nobody told.
 */
export function dueTells(state: BridgeState, boardless: ReadonlySet<string>, now: number): string[] {
  return Object.entries(state.rules).flatMap(([key, rule]) => !isResolved(rule) && boardless.has(rule.chat) && (rule.toldAt === undefined ||
    (rule.escalatedAt === undefined && now - rule.firstWokeAt >= ESCALATE_MS) || now - rule.toldAt >= REOPEN_MS) ? [key] : []);
}

/** The message that tells a boardless owner its firing rules. */
export const tellText = (rules: readonly Tracked[]): string =>
  `[alert] ${rules.length === 1 ? "A Grafana rule you own is" : `${rules.length} Grafana rules you own are`} firing, and this session has no board, so the alert ` +
  `bridge tells you here: ${rules.map(rule => `${rule.rule} (${ruleIn(rule.rule, rule.alertname)}firing since ${rule.startsAt.slice(0, 16)}Z${firingSets(rule) > 1 ? `, ${firingSets(rule)} label sets` : ""})`).join("; ")}. ` +
  `Find the cause and fix it. The bridge tells you again in ${ESCALATE_MS / 60_000} min and then every ${REOPEN_MS / 3_600_000} h while ${rules.length === 1 ? "it fires" : "they fire"}.`;

/**
 * The rules that still fire REOPEN_MS after the bridge last gave them to a job, with a job at hand: `reopen` checks that job has ended. On
 * 10-16 prod backup alerts fired for over 3 days while nobody worked them.
 */
export const dueReopens = (state: BridgeState, now: number): string[] =>
  Object.entries(state.rules).flatMap(([key, rule]) => !isResolved(rule) && rule.job && !owed(rule) && now - rule.job.at >= REOPEN_MS ? [key] : []);

/**
 * The rules of chats with a board whose fire no job holds (`held`) ESCALATE_MS after it, once per fire: no job took it, or the job that took it
 * has had no model turn. A fire that resolved before its job had a turn escalates too, since nobody looked at it: metal-prod-crawler-netns-ports
 * fired at 12:14:30Z on 10-19, resolved at 12:28:42Z, and its job had no turn by 14:46Z. ops guy's own rules never escalate, since the
 * escalation goes to ops guy.
 */
export function dueEscalations(state: BridgeState, boarded: ReadonlySet<string>, now: number): string[] {
  return Object.entries(state.rules).flatMap(([key, rule]) => (owed(rule) || waiting(rule, now)) && boarded.has(rule.chat) && rule.chat !== OPS_ROUTE.session &&
    now - rule.wokeAt >= ESCALATE_MS && !(rule.escalatedAt !== undefined && rule.escalatedAt >= rule.wokeAt) ? [key] : []);
}

const ruleIn = (title: string, alertname: string): string => title.includes(alertname) ? "" : `${alertname}, `;
const minute = (at: string | number): string => `${new Date(at).toISOString().slice(0, 16)}Z`;

/** The rule as its job reads it, from its first firing label set in this tick's list. */
export function alertLine(rule: Tracked, firing: ReadonlyMap<string, FiringAlert>): AlertLine {
  const alert = Object.keys(rule.instances).map(id => firing.get(id)).filter(alert => alert !== undefined).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  return { rule: rule.rule, alertname: rule.alertname, startsAt: rule.startsAt, firedAt: rule.wokeAt, sets: firingSets(rule), summary: alert?.summary ?? "", url: alert?.url ?? "",
    ...alert?.values ? { values: alert.values } : {} };
}

/** One rule in a line of text: its uid, its title when that differs, and since when it fires. */
export const ruleText = (line: Pick<AlertLine, "rule" | "alertname" | "startsAt" | "sets">): string =>
  `${line.rule} (${ruleIn(line.rule, line.alertname)}firing since ${minute(line.startsAt)}${line.sets > 1 ? `, ${line.sets} label sets` : ""})`;

/** The message that gives a working triage job the next fire of its rule. */
export const firedAgainText = (line: AlertLine): string =>
  `[alert] Your rule ${ruleText(line)} fired again at ${minute(line.firedAt)}.${line.summary ? ` Summary: ${line.summary}` : ""} It is the same rule you work on, so ` +
  "take it into the same cause, and say in your report whether the fix you have covers it.";

/** The words Prime puts before the token hook's own answer, which say nothing the hook's words do not. */
const TOKEN_HOOK_PREFIX = /^Failed to resolve API key for provider "[^"]+" from shell command: \S+ /;

/** One rule to escalate: `job` names the job that took its fire and has had no model turn, and `error` its last failed call. */
export type EscalationLine = AlertLine & { chat: string; job?: string; error?: string };

export function escalationText(lines: readonly EscalationLine[]): string {
  const failed = (error: string): string => error.replace(TOKEN_HOOK_PREFIX, "").slice(0, 200);
  const why = (line: EscalationLine): string => line.job ? `, whose job ${line.job} has had no model turn` : ", for which the alert bridge could not start a job";
  const error = lines.find(line => line.job && line.error)?.error;
  return `[alert-escalation] ${lines.length === 1 ? "A rule has" : `${lines.length} rules have`} nobody working ${lines.length === 1 ? "its" : "their"} fire ` +
    `${ESCALATE_MS / 60_000} min after it: ${lines.map(line => `${ruleText(line)} on ${line.chat}${why(line)}`).join("; ")}.` +
    `${error ? ` ${lines.length === 1 ? "Its" : "The first such job's"} last call failed: ${failed(error)}.` : ""} ` +
    "Find why the job does not start or gets no turn, and get each fire worked.";
}

const chatName = (session: string): string => ALERT_ROUTES.find(route => route.session === session)?.chat ?? session;

export interface AlertBridgeDeps {
  file: string;
  alerts: () => Promise<FiringAlert[] | null>;
  /** Hands the session the text on disk (src/agent-outbox.ts); `root` is started when the daemon does not find the session. */
  deliver: (session: string, text: string, root?: string) => Promise<void>;
  owners?: () => Promise<OwnerMap | null>;
  hasBoard?: (session: string) => Promise<boolean>;
  /** Starts a triage job of `chat` for one firing rule; `previous` is the rule's last job, which has ended. Absent, fires escalate to ops guy. */
  startJob?: (chat: string, line: AlertLine, previous?: RuleJob) => Promise<AlertJob>;
  /** Whether a job the bridge started still works its turn. */
  jobWorking?: (job: AlertJob) => Promise<boolean>;
  /** Whether a model turn of the job ended after `since` (`readTurnSince`). Absent, every job that took a fire holds it. */
  jobTurn?: (job: AlertJob, since: number) => Promise<TurnSince>;
  /** Asks the resume pass to continue a job whose first call pi-pool held, once the slot its error names has passed. */
  retryJob?: (job: AlertJob) => void;
  now?: () => number;
  log: (line: string) => void;
}

/**
 * The error's message with the code of its cause: undici's fetch rejects with "fetch failed" and keeps the reason (ENOTFOUND, ECONNREFUSED,
 * ECONNRESET, UND_ERR_CONNECT_TIMEOUT) in `cause`. On 10-19 the bridge logged a bare "fetch failed" at 14:19, 14:25, 14:31, 14:38 and 14:47Z.
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const code = cause instanceof Error ? (cause as { code?: unknown }).code ?? cause.name : undefined;
  return cause instanceof Error ? `${error.message} (${typeof code === "string" ? code : "cause"}: ${cause.message})` : error.message;
}
const message = errorText;

/**
 * Polls and dispatches apart: `poll` reads Grafana, advances the state, reopens, watches the jobs that took a fire for their first turn,
 * tells and escalates, and `dispatch` starts or messages the triage jobs. A job start waits in the duty job queue behind other creates, and on
 * 10-19 the start for vent-health-failure-rate-stg queued from 14:41:36Z to 14:46:50Z behind about 30 creates of 9.5 s each while the one
 * `running` guard skipped every poll, so the bridge read stale. Every change to the state goes through `update`, so the two never write over
 * each other.
 */
export class AlertBridge {
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private firing: ReadonlyMap<string, FiringAlert> = new Map();
  private boarded: ReadonlySet<string> = new Set();
  constructor(private readonly deps: AlertBridgeDeps) { this.now = deps.now ?? Date.now; }

  /** One poll and then one dispatch, as one timer tick did before they ran apart. */
  async tick(): Promise<void> {
    if (await this.poll()) await this.dispatch();
  }

  /** Reads the firing list and does everything but job starts and fire messages; false when Grafana is not configured. */
  async poll(): Promise<boolean> {
    const alerts = await this.deps.alerts();
    if (!alerts) return false;
    const route = routerFor(await this.ownerMap());
    await this.update(async before => {
      const now = this.now();
      const advanced = advance(alerts, before, route, now);
      let state = advanced.state;
      if (advanced.fired.size) this.deps.log(`alerts: fired ${[...advanced.fired].map(key => state.rules[key]!.rule).join(", ")}`);
      const boarded = new Set<string>();
      const boardless = new Set<string>();
      for (const chat of new Set(Object.values(state.rules).filter(rule => !isResolved(rule) || waiting(rule, now)).map(rule => rule.chat))) {
        (await this.deps.hasBoard?.(chat) ?? true ? boarded : boardless).add(chat);
      }
      this.firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
      this.boarded = boarded;
      state = await this.reopen(state, boarded, now);
      const watched = await this.watch(state, now);
      state = await this.tell(watched.state, boardless, now);
      return this.escalate(state, boarded, watched.errors, now);
    });
    return true;
  }

  /**
   * Gives each owed fire (`owed`) to its rule's triage job: by message while that job still works, to the same job while it has never had a
   * turn, or else to a new job. A start or message that fails leaves the fire owed, so it goes again next dispatch and escalates at
   * ESCALATE_MS. The slow calls run outside `update`, so polls go on meanwhile.
   */
  async dispatch(): Promise<void> {
    if (!this.deps.startJob) return;
    const snapshot = await this.update(async state => state);
    for (const key of Object.keys(snapshot.rules).filter(key => owed(snapshot.rules[key]!) && this.boarded.has(snapshot.rules[key]!.chat))) {
      const rule = snapshot.rules[key]!;
      const line = alertLine(rule, this.firing);
      try {
        const job = await this.give(rule, line);
        await this.update(async state => {
          const now = state.rules[key];
          if (!now || now.job?.id !== rule.job?.id || (now.job && rule.job && now.job.at !== rule.job.at)) return state;
          return { ...state, rules: { ...state.rules, [key]: { ...now, job } } };
        });
      } catch (error) { this.deps.log(`alerts: job for ${rule.rule} on ${rule.chat.slice(0, 8)}: ${message(error)}; tried again next tick`); }
    }
  }

  /**
   * The job that takes the rule's fire now. A job that never had a turn keeps the rule: on 10-19 the bridge read such jobs as ended and
   * started another for each fire, until 25 jobs for hyperdx-error-logs sat in pi-pool's queue with no turn.
   */
  private async give(rule: Tracked, line: AlertLine): Promise<RuleJob> {
    const now = this.now();
    const job = rule.job;
    if (job && await this.deps.jobWorking?.(job)) {
      await this.deps.deliver(job.id, firedAgainText(line));
      this.deps.log(`alerts: ${rule.chat.slice(0, 8)}: sent the fire of ${rule.rule} to job ${job.name} (${job.id.slice(0, 8)})`);
      return { ...job, at: now };
    }
    if (job && job.ranAt === undefined && this.deps.jobTurn) {
      const turn = await this.deps.jobTurn(job, job.at);
      if (!turn.ran) {
        this.deps.log(`alerts: ${rule.chat.slice(0, 8)}: kept job ${job.name} (${job.id.slice(0, 8)}) for the fire of ${rule.rule}, since it has had no turn yet`);
        return { ...job, at: now };
      }
    }
    const started = await this.deps.startJob!(rule.chat, line, job);
    this.deps.log(`alerts: ${rule.chat.slice(0, 8)}: started job ${started.name} (${started.id.slice(0, 8)}) for ${rule.rule}`);
    return { id: started.id, name: started.name, at: now };
  }

  /**
   * Reads each job that took a fire and has had no turn since (`waiting`): a turn that ended marks `ranAt`, so the job holds the fire. A job
   * whose failed call names a pool slot that has passed, and that does not work, gets one retry per slot through the resume pass, which
   * continues it once pi-pool admits its tree. The errors go with the escalation.
   */
  private async watch(state: BridgeState, now: number): Promise<{ state: BridgeState; errors: Map<string, string> }> {
    const errors = new Map<string, string>();
    const rules = { ...state.rules };
    for (const [key, rule] of Object.entries(rules)) {
      if (!waiting(rule, now)) continue;
      const job = rule.job!;
      const turn: TurnSince | null = this.deps.jobTurn ? await this.deps.jobTurn(job, job.at).catch(() => null) : { ran: true, at: now };
      if (!turn) continue;
      if (turn.ran) {
        rules[key] = { ...rule, job: { ...job, ranAt: turn.at } };
        continue;
      }
      if (turn.error) errors.set(key, turn.error);
      if (!this.deps.retryJob || turn.slotAt === undefined || turn.slotAt > now || (job.retriedAt ?? -1) >= turn.slotAt) continue;
      if (await this.deps.jobWorking?.(job).catch(() => true)) continue;
      this.deps.retryJob(job);
      rules[key] = { ...rule, job: { ...job, retriedAt: turn.slotAt } };
      this.deps.log(`alerts: job ${job.name} (${job.id.slice(0, 8)}) for ${rule.rule} has had no turn and its pool slot ${minute(turn.slotAt)} passed; asked the resume pass to continue it`);
    }
    return { state: { ...state, rules }, errors };
  }

  /** Marks each rule that still fires REOPEN_MS after its job took it, and whose job has ended, as fired now, so `dispatch` starts a new job. */
  private async reopen(state: BridgeState, boarded: ReadonlySet<string>, now: number): Promise<BridgeState> {
    const due = dueReopens(state, now).filter(key => boarded.has(state.rules[key]!.chat));
    if (!due.length) return state;
    const rules = { ...state.rules };
    for (const key of due) {
      if (await (this.deps.jobWorking?.(rules[key]!.job!) ?? Promise.resolve(false)).catch(() => true)) continue;
      rules[key] = { ...rules[key]!, wokeAt: now };
      this.deps.log(`alerts: ${rules[key]!.rule} still fires ${REOPEN_MS / 3_600_000} h after job ${rules[key]!.job!.name} took it, and that job ended`);
    }
    return { ...state, rules };
  }

  /** Tells each boardless owner its rules that `dueTells` names, and records when, so a tell that fails goes again next tick. */
  private async tell(state: BridgeState, boardless: ReadonlySet<string>, now: number): Promise<BridgeState> {
    const due = dueTells(state, boardless, now);
    if (!due.length) return state;
    const rules = { ...state.rules };
    for (const chat of boardless) {
      const keys = due.filter(key => rules[key]!.chat === chat);
      if (!keys.length) continue;
      try {
        await this.deps.deliver(chat, tellText(keys.map(key => rules[key]!)), chat);
        for (const key of keys) {
          const rule = rules[key]!;
          rules[key] = { ...rule, toldAt: now, ...rule.escalatedAt === undefined && now - rule.firstWokeAt >= ESCALATE_MS ? { escalatedAt: now } : {} };
        }
        this.deps.log(`alerts: told ${chat.slice(0, 8)}, which has no board, of ${keys.map(key => rules[key]!.rule).join(", ")}`);
      } catch (error) { this.deps.log(`alerts: tell ${chat.slice(0, 8)}: ${message(error)}; tried again next tick`); }
    }
    return { ...state, rules };
  }

  private async escalate(state: BridgeState, boarded: ReadonlySet<string>, errors: ReadonlyMap<string, string>, now: number): Promise<BridgeState> {
    const due = dueEscalations(state, boarded, now);
    if (!due.length) return state;
    try {
      await this.deps.deliver(OPS_ROUTE.session, escalationText(due.map(key => {
        const rule = state.rules[key]!;
        const error = errors.get(key);
        return { ...alertLine(rule, this.firing), chat: chatName(rule.chat), ...rule.job && !owed(rule) ? { job: rule.job.name } : {}, ...error ? { error } : {} };
      })), OPS_ROUTE.session);
      const rules = { ...state.rules };
      for (const key of due) rules[key] = { ...rules[key]!, escalatedAt: now };
      this.deps.log(`alerts: escalated ${due.length} rules nobody works to ops guy`);
      return { ...state, rules };
    } catch (error) {
      this.deps.log(`alerts: escalation: ${message(error)}; tried again next tick`);
      return state;
    }
  }

  private async ownerMap(): Promise<OwnerMap | null> {
    try { return (await this.deps.owners?.()) ?? null; }
    catch (error) {
      this.deps.log(`alerts: owners.json: ${message(error)}; routed by keywords`);
      return null;
    }
  }

  /** Runs `change` on the saved state, one at a time, and saves what it returns when that differs. */
  private update(change: (state: BridgeState) => Promise<BridgeState>): Promise<BridgeState> {
    const next = this.queue.then(async () => {
      const before = await this.read();
      const after = await change(before);
      if (JSON.stringify(after) !== JSON.stringify(before)) await this.write(after);
      return after;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<BridgeState> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.deps.file, "utf8")); }
    catch (error) { if (missing(error)) return emptyState(); throw error; }
    const state = parseState(value);
    if (isRecord(value) && value.v !== state.v) await this.write(state);
    return state;
  }

  private async write(state: BridgeState): Promise<void> {
    const temporary = `${this.deps.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.deps.file);
  }
}

/** The firing rules of `chat` in the state file, for a duty's precheck; a missing file means none fire. */
export async function readFiringRules(file: string, chat: string): Promise<Tracked[]> {
  const text = await readFile(file, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  return text === null ? [] : firingRules(parseState(JSON.parse(text)), chat);
}

export class GrafanaError extends Error {
  constructor(readonly status: number) { super(`Grafana answered ${status} for the alert list`); }
}

export async function readGrafanaAlerts(configFile: string): Promise<FiringAlert[] | null> {
  const text = await readFile(configFile, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (text === null) return null;
  const config = JSON.parse(text) as unknown;
  if (!isRecord(config) || typeof config.url !== "string" || typeof config.token !== "string") throw new Error(`${configFile} needs a url and a token`);
  const response = await fetch(new URL(GRAFANA_ALERTS_PATH, config.url), { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new GrafanaError(response.status);
  return parseAlerts(await response.json());
}

export async function readOwnersFor(configFile: string, home: string): Promise<OwnerMap | null> {
  const text = await readFile(configFile, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  const config = text === null ? {} : JSON.parse(text) as unknown;
  const repo = isRecord(config) && typeof config.ownersRepo === "string" ? config.ownersRepo : join(home, "Documents/Github/auto-sns-agent");
  const refs = isRecord(config) && Array.isArray(config.ownersRefs) ? config.ownersRefs.filter((ref): ref is string => typeof ref === "string") : [];
  return readOwners(repo, ["origin/main", ...refs]);
}

/** Starts the bridge: a poll each `everyMs`, and after each poll a dispatch unless one still runs, so a slow job start never skips a poll. */
export function startAlertBridge(deps: AlertBridgeDeps, everyMs = TICK_MS): () => void {
  const bridge = new AlertBridge(deps);
  let polling = false;
  let dispatching = false;
  const dispatch = () => {
    if (dispatching) return;
    dispatching = true;
    void bridge.dispatch().catch(error => deps.log(`alerts: dispatch: ${errorText(error)}`)).finally(() => { dispatching = false; });
  };
  const run = () => {
    if (polling) return;
    polling = true;
    void bridge.poll().then(ok => { if (ok) dispatch(); }).catch(error => deps.log(`alerts: ${errorText(error)}`)).finally(() => { polling = false; });
  };
  const timer = setInterval(run, everyMs);
  run();
  timer.unref();
  return () => clearInterval(timer);
}
