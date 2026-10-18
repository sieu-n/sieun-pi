import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALERT_ROUTES, OPS_ROUTE, routeAlert } from "./alert-routes.ts";
import { missing } from "./locked-json.ts";
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
/** The triage job that holds a rule, and when the bridge last gave the rule to it (started it, or sent it a fire). */
export interface RuleJob extends AlertJob { at: number }
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
 * The rules of chats with a board whose fire no job took ESCALATE_MS after it, once per fire. ops guy's own rules never escalate, since the
 * escalation goes to ops guy.
 */
export function dueEscalations(state: BridgeState, boarded: ReadonlySet<string>, now: number): string[] {
  return Object.entries(state.rules).flatMap(([key, rule]) => owed(rule) && boarded.has(rule.chat) && rule.chat !== OPS_ROUTE.session &&
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

export function escalationText(lines: readonly (AlertLine & { chat: string })[]): string {
  return `[alert-escalation] ${lines.length === 1 ? "A firing rule has" : `${lines.length} firing rules have`} no triage job ${ESCALATE_MS / 60_000} min after ` +
    `${lines.length === 1 ? "it" : "they"} fired, because the alert bridge could not start one: ${lines.map(line => `${ruleText(line)} on ${line.chat}`).join("; ")}. ` +
    "Find why the job start fails, and start a job for each or get that chat to.";
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
  now?: () => number;
  log: (line: string) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class AlertBridge {
  private readonly now: () => number;
  constructor(private readonly deps: AlertBridgeDeps) { this.now = deps.now ?? Date.now; }

  async tick(): Promise<void> {
    const alerts = await this.deps.alerts();
    if (!alerts) return;
    const route = routerFor(await this.ownerMap());
    const now = this.now();
    const before = await this.read();
    const advanced = advance(alerts, before, route, now);
    let state = advanced.state;
    if (JSON.stringify(state) !== JSON.stringify(before)) await this.write(state);
    if (advanced.fired.size) this.deps.log(`alerts: fired ${[...advanced.fired].map(key => state.rules[key]!.rule).join(", ")}`);
    const boarded = new Set<string>();
    const boardless = new Set<string>();
    for (const chat of new Set(Object.values(state.rules).filter(rule => !isResolved(rule)).map(rule => rule.chat))) {
      (await this.deps.hasBoard?.(chat) ?? true ? boarded : boardless).add(chat);
    }
    state = await this.reopen(state, boarded, now);
    if (this.deps.startJob) state = await this.dispatch(state, boarded, new Map(alerts.map(alert => [alertKey(alert), alert])), now);
    state = await this.tell(state, boardless, now);
    await this.escalate(state, boarded, alerts, now);
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
    state = { ...state, rules };
    await this.write(state);
    return state;
  }

  /**
   * Gives each owed fire (`owed`) to its rule's triage job: by message while that job still works, or else to a new job. A start or message
   * that fails leaves the fire owed, so it goes again next tick and escalates at ESCALATE_MS.
   */
  private async dispatch(state: BridgeState, boarded: ReadonlySet<string>, firing: ReadonlyMap<string, FiringAlert>, now: number): Promise<BridgeState> {
    const due = Object.keys(state.rules).filter(key => owed(state.rules[key]!) && boarded.has(state.rules[key]!.chat));
    if (!due.length) return state;
    const rules = { ...state.rules };
    for (const key of due) {
      const rule = rules[key]!;
      const line = alertLine(rule, firing);
      try {
        if (rule.job && await this.deps.jobWorking?.(rule.job)) {
          await this.deps.deliver(rule.job.id, firedAgainText(line));
          rules[key] = { ...rule, job: { ...rule.job, at: now } };
          this.deps.log(`alerts: ${rule.chat.slice(0, 8)}: sent the fire of ${rule.rule} to job ${rule.job.name} (${rule.job.id.slice(0, 8)})`);
        } else {
          const job = await this.deps.startJob!(rule.chat, line, rule.job);
          rules[key] = { ...rule, job: { id: job.id, name: job.name, at: now } };
          this.deps.log(`alerts: ${rule.chat.slice(0, 8)}: started job ${job.name} (${job.id.slice(0, 8)}) for ${rule.rule}`);
        }
      } catch (error) { this.deps.log(`alerts: job for ${rule.rule} on ${rule.chat.slice(0, 8)}: ${message(error)}; tried again next tick`); }
    }
    state = { ...state, rules };
    await this.write(state);
    return state;
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
    state = { ...state, rules };
    await this.write(state);
    return state;
  }

  private async escalate(state: BridgeState, boarded: ReadonlySet<string>, alerts: readonly FiringAlert[], now: number): Promise<void> {
    const due = dueEscalations(state, boarded, now);
    if (!due.length) return;
    const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
    try {
      await this.deps.deliver(OPS_ROUTE.session, escalationText(due.map(key => ({ ...alertLine(state.rules[key]!, firing), chat: chatName(state.rules[key]!.chat) }))), OPS_ROUTE.session);
      const rules = { ...state.rules };
      for (const key of due) rules[key] = { ...rules[key]!, escalatedAt: now };
      await this.write({ ...state, rules });
      this.deps.log(`alerts: escalated ${due.length} rules with no triage job to ops guy`);
    } catch (error) { this.deps.log(`alerts: escalation: ${message(error)}; tried again next tick`); }
  }

  private async ownerMap(): Promise<OwnerMap | null> {
    try { return (await this.deps.owners?.()) ?? null; }
    catch (error) {
      this.deps.log(`alerts: owners.json: ${message(error)}; routed by keywords`);
      return null;
    }
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

export function startAlertBridge(deps: AlertBridgeDeps, everyMs = TICK_MS): () => void {
  const bridge = new AlertBridge(deps);
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void bridge.tick().catch(error => deps.log(`alerts: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
  const timer = setInterval(run, everyMs);
  run();
  timer.unref();
  return () => clearInterval(timer);
}
