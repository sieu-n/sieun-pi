import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALERT_ROUTES, OPS_ROUTE, routeAlert } from "./alert-routes.ts";
import { missing } from "./locked-json.ts";
import type { TurnSince } from "./held-turns.ts";
import type { QueuePlace } from "./shared/types.ts";
import { transientTurnError } from "./turn-error.ts";
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
/** Every rule with its last evaluation and no alert instances: 527 KB for 309 rules on 10-19, against 1.3 MB with the instances. */
export const GRAFANA_RULES_PATH = "/api/prometheus/grafana/api/v1/rules?limit_alerts=0";

export interface FiringAlert { fingerprint: string; startsAt: string; alertname: string; labels: Record<string, string>; summary: string; url: string; values?: string }
/** One firing label set of a rule, keyed in `Tracked.instances` by alertKey (fingerprint@startsAt). */
export interface Instance { startsAt: string; labels: Record<string, string>; resolvedAt?: number }
/** A triage job the bridge started for a chat: its session id and name. */
export interface AlertJob { id: string; name: string }
/** The triage job a rule's fire went to, and when the bridge gave it (started the job with it, or sent it by message). */
export interface RuleJob extends AlertJob { at: number }
/**
 * A triage job the bridge started for one owner chat, which carries every fire of that chat while it lives. On 10-19 one job per rule had
 * made 78 fires into 78 jobs across 4 chats, most of them waiting in pi-pool's queue with no turn. The job holds a fire only once a model turn
 * of it ended after it took the fire (`held`): job 01a15416 for metal-prod-crawler-netns-ports started at 12:15:14Z, failed its first call on a
 * pi-pool slot wait and had no turn at 14:46Z, and the bridge counted it as holding the fire, so nothing escalated.
 */
export interface TriageJob extends AlertJob { chat: string;
  /** When the bridge started it. */
  at: number;
  /** When the bridge saw the job's latest model turn end. Absent: the job never had a turn. */
  ranAt?: number;
  /** The pool slot time of the job's failed first call for which the bridge last asked the resume pass to continue it (`AlertBridgeDeps.retryJob`). */
  retriedAt?: number;
  /** When the bridge moved this job's fires to a live or fresh job, since it ended with no model turn after it took them (`replaceEnded`). */
  replacedAt?: number }
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
/** The rules, the triage jobs any rule names (by session id), and each owner chat's current triage job. */
export interface BridgeState { v: 4; rules: Record<string, Tracked>; jobs: Record<string, TriageJob>; chats: Record<string, string> }
export interface OwnerRoute { name: string; match: Record<string, string>; owner: string }
export interface OwnerMap { owners: Record<string, string>; fallback: string; routes: OwnerRoute[] }
export type Router = (alert: FiringAlert) => string;
/** One firing rule as its triage job reads it. */
export interface AlertLine { rule: string; alertname: string; startsAt: string; firedAt: number; sets: number; summary: string; url: string; values?: string }

export const emptyState = (): BridgeState => ({ v: 4, rules: {}, jobs: {}, chats: {} });
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
    if (!isRecord(item) || !isRecord(item.status) || item.status.state !== "active" || (isRecord(item.labels) && (item.labels.severity === "test" || item.labels.notify === "none"))) return [];
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
 * carries that job as `job` (scripts/alert-bridge-unstep.ts wrote it before the release). A version 3 state (to 10-19) kept one job per rule
 * with its turn marks on the rule: each job becomes a TriageJob, and each chat's current job is the one that took a firing rule last.
 */
export function parseState(value: unknown): BridgeState {
  if (!isRecord(value) || (value.v !== 2 && value.v !== 3 && value.v !== 4) || !isRecord(value.rules)) throw new Error("Alert bridge state file is malformed.");
  if (value.v === 4) return { ...value as unknown as BridgeState, jobs: isRecord(value.jobs) ? value.jobs as Record<string, TriageJob> : {}, chats: isRecord(value.chats) ? value.chats as Record<string, string> : {} };
  type Old = Tracked & { step?: unknown; closedAt?: unknown; job?: RuleJob & { ranAt?: number; retriedAt?: number } };
  const jobs: Record<string, TriageJob> = {};
  const chats: Record<string, string> = {};
  const latest: Record<string, number> = {};
  const rules = Object.fromEntries(Object.entries(value.rules as Record<string, Old>).map(([key, old]) => {
    const { step: _step, closedAt: _closed, job, ...rule } = old;
    if (!job) return [key, rule];
    const was = jobs[job.id];
    jobs[job.id] = { id: job.id, name: job.name, chat: rule.chat, at: Math.min(was?.at ?? job.at, job.at),
      ...job.ranAt !== undefined || was?.ranAt !== undefined ? { ranAt: Math.max(job.ranAt ?? 0, was?.ranAt ?? 0) } : {},
      ...job.retriedAt !== undefined || was?.retriedAt !== undefined ? { retriedAt: Math.max(job.retriedAt ?? 0, was?.retriedAt ?? 0) } : {} };
    if (rule.resolvedAt === undefined && job.at > (latest[rule.chat] ?? -1)) { latest[rule.chat] = job.at; chats[rule.chat] = job.id; }
    return [key, { ...rule, job: { id: job.id, name: job.name, at: job.at } }];
  }));
  return { v: 4, rules, jobs, chats };
}

const isResolved = (rule: Tracked): boolean => rule.resolvedAt !== undefined;
const firingSets = (rule: Tracked): number => Object.values(rule.instances).filter(instance => instance.resolvedAt === undefined).length;

/** The rules of `chat` that fire now: the count its duty reads. */
export const firingRules = (state: BridgeState, chat: string): Tracked[] => Object.values(state.rules).filter(rule => rule.chat === chat && !isResolved(rule));

/**
 * Whether the rule's last fire still waits for a job: it has none, the bridge gave it to its job before that fire, its job is not its
 * chat's triage job and never had a turn, so the chat's job takes it over, or the bridge replaced its job (`replaceEnded`).
 */
export const owed = (state: BridgeState, rule: Tracked): boolean => !isResolved(rule) && (rule.job === undefined || rule.job.at < rule.wokeAt ||
  (state.chats[rule.chat] !== rule.job.id && state.jobs[rule.job.id]?.ranAt === undefined) || state.jobs[rule.job.id]?.replacedAt !== undefined);

/** Whether the rule's job took its last fire and had a model turn end since, so someone works the fire. */
export const held = (state: BridgeState, rule: Tracked): boolean => {
  const ran = rule.job && state.jobs[rule.job.id]?.ranAt;
  return rule.job !== undefined && rule.job.at >= rule.wokeAt && ran !== undefined && ran >= rule.job.at;
};

/** Whether the rule's job took its last fire within REOPEN_MS and has had no model turn since: the bridge watches it for its next turn. */
const waiting = (state: BridgeState, rule: Tracked, now: number): boolean =>
  rule.job !== undefined && rule.job.at >= rule.wokeAt && !held(state, rule) && now - rule.wokeAt < REOPEN_MS;

/** The state with only the triage jobs some rule or chat still names. */
function pruned(state: BridgeState): BridgeState {
  const named = new Set([...Object.values(state.rules).flatMap(rule => rule.job ? [rule.job.id] : []), ...Object.values(state.chats)]);
  return { ...state, jobs: Object.fromEntries(Object.entries(state.jobs).filter(([id]) => named.has(id))) };
}

/** Whether `alert` names a fault its open rule holds no instance of, by the label the rule's `incident_by` label names (`advance` step 5). */
const newFault = (rule: Tracked, alert: FiringAlert): boolean => {
  const by = alert.labels.incident_by;
  if (!by || isResolved(rule)) return false;
  return !Object.values(rule.instances).some(instance => instance.resolvedAt === undefined && instance.labels[by] === alert.labels[by]);
};

/**
 * The state after this tick's firing list, and the rules that fired: new, or back after they resolved. Each alert rule firing in an owning
 * chat is one entry, and every label set of it (lane, env and so on) is an instance of that entry. On 10-18 one proxy rule firing in 6 lanes
 * had opened 6 steps on crawler ops' board, one per Grafana fingerprint.
 *
 * 1. A firing whose instance key is already on a rule goes back to it and fires nothing, however long it was gone: the same fingerprint and
 *    startsAt is the same Grafana alert, which never resolved. At 06:20:35Z on 10-15 one poll dropped 25 alerts at once and they came back
 *    with the same startsAt. From 16:45:34Z to 16:57:35Z on 10-18 two obs deploys recreated Grafana, whose first lists lack each firing alert
 *    until that rule's first evaluation, and the bridge fired 20 such rules again 29 times; on 10-19 the 5m group estate-cpu-saturated came back
 *    305 s after Grafana listened.
 * 2. Any other firing joins the open rule of its chat and rule, or opens a new one, which replaces the chat's resolved entry of that rule and
 *    keeps its job, so a live job gets the next fire.
 * 3. An instance missing from the list resolves, and the rule resolves once every instance has.
 * 4. A rule that fired sets `wokeAt`, so its job owes the fire (`owed`). A new label set on a rule that still fires is the same incident, and
 *    so is a fire within REFIRE_MS of the rule resolving, which keeps the rule's entry and its job and fires nothing.
 * 5. A rule whose label `incident_by` names one of its labels, such as `spec`, holds one fault per value of that label: a new label set whose
 *    value no open instance of the rule has fires the rule again, so its job owes it. On 10-30 at 17:06Z hosted-app-chat.spec.ts went red on
 *    ci-staging-proof-spec-red while hosted-inbox-whatsapp-dm.spec.ts, held red on Meta's name approval, kept the rule open, and no job got it.
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
    if (!fired.has(key) && newFault(rule, alert)) fired.add(key);
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
  return { state: { ...state, rules }, fired: new Set([...fired].filter(key => rules[key] && !isResolved(rules[key]!))) };
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
  Object.entries(state.rules).flatMap(([key, rule]) => !isResolved(rule) && rule.job && !owed(state, rule) && now - rule.job.at >= REOPEN_MS ? [key] : []);

/**
 * The rules of chats with a board whose fire no job holds (`held`) ESCALATE_MS after it, once per fire: no job took it, or the job that took it
 * has had no model turn. A fire that resolved before its job had a turn escalates too, since nobody looked at it: metal-prod-crawler-netns-ports
 * fired at 12:14:30Z on 10-19, resolved at 12:28:42Z, and its job had no turn by 14:46Z. ops guy's own rules never escalate, since the
 * escalation goes to ops guy. A job in `parked` waits for a pi-pool slot, and its fires escalate only if it still has no turn once that slot
 * passed: on 10-20 three escalations (04:56Z, 05:17Z, 05:27Z) named two jobs whose slots at 05:06Z and 06:06Z were still ahead, and both
 * jobs ran at 05:40Z once pi-pool let them in.
 */
export function dueEscalations(state: BridgeState, boarded: ReadonlySet<string>, now: number, parked: ReadonlySet<string> = new Set()): string[] {
  return Object.entries(state.rules).flatMap(([key, rule]) => (owed(state, rule) || (waiting(state, rule, now) && !parked.has(rule.job!.id))) && boarded.has(rule.chat) &&
    rule.chat !== OPS_ROUTE.session && now - rule.wokeAt >= ESCALATE_MS && !(rule.escalatedAt !== undefined && rule.escalatedAt >= rule.wokeAt) ? [key] : []);
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

/** Each rule a triage job takes, with its summary, values and Grafana link: the rule list of a Prime triage brief and of a pi-host thread's alert message. */
export const alertRulesText = (lines: readonly AlertLine[]): string => lines.map(line => [`- ${ruleText(line)}`, line.summary ? `  Summary: ${line.summary}` : "",
  line.values ? `  Values: ${line.values}.` : "", line.url ? `  Grafana: ${line.url}` : ""].filter(Boolean).join("\n")).join("\n");

/** How a triage job works its rules, in a Prime triage brief and in a pi-host thread's alert message. */
export const TRIAGE_WORK = "Group the rules by cause first: several rules often fire on one fault. Find each cause from evidence: the Grafana rule and its query, the " +
  "metrics and logs, and read-only reads on the box. Fix it at the root: a fix in our code or alert rules goes through the repo's normal land " +
  "path, and a rule that fires on something that is not a fault gets fixed or deleted. Follow the chat's rules for any box or repo you touch, and " +
  "send nothing outside (no email, ticket or vendor chat).";

/**
 * The agent message that gives a pi-host thread its owed fires. The thread is its own triage job: it reads the rules and starts the triage with
 * rlm.spawn, so the agent decides the fan-out (c22). Each fire is one message.
 */
export const threadAlertText = (lines: readonly AlertLine[]): string => [
  `[alert] ${lines.length === 1 ? "A Grafana rule this thread owns fired" : `${lines.length} Grafana rules this thread owns fired`}. ${OWNERS_PATH} in ` +
    "auto-sns-agent routes the rule to this thread, and the alert bridge gives you each of its fires as one message.",
  alertRulesText(lines),
  TRIAGE_WORK,
  "Start the triage with rlm.spawn, or send the fire with agent_message.send to the triage job you already run on the same cause. The bridge " +
    `sends a rule again when it fires again after it resolved, or when it still fires ${REOPEN_MS / 3_600_000} h later. It escalates the fire to ops guy ` +
    `when no turn of this thread ends within ${ESCALATE_MS / 60_000} min of it.`,
].join("\n\n");

/** The request id of one hand-off to a thread: the same fires give the same id, so a send repeated after a failed save lands once. */
export const threadRequestId = (lines: readonly AlertLine[]): string => `alert:${lines.map(line => `${line.rule}@${line.firedAt}`).join(",")}`;

/** The message that gives a chat's triage job the fires of its chat that came after its brief. */
export function firedAgainText(lines: readonly AlertLine[]): string {
  const one = (line: AlertLine): string => `${ruleText(line)} fired at ${minute(line.firedAt)}${line.summary ? `. Summary: ${line.summary.replace(/\.+$/, "")}` : ""}`;
  return `[alert] ${lines.length === 1 ? `A rule of your chat, ${one(lines[0]!)}.` : `${lines.length} rules of your chat fired: ${lines.map(one).join("; ")}.`} ` +
    "You are this chat's triage job, so take each into your work: say whether it shares a cause with a fire you already have, and in your " +
    "report say for each rule whether your fix covers it.";
}

/** The message to a job that had a rule the chat's triage job now owns. */
export const ownedByText = (rules: readonly string[], owner: AlertJob): string =>
  `[alert] ${rules.join(", ")} now ${rules.length === 1 ? "belongs" : "belong"} to this chat's triage job "${owner.name}" (session ${owner.id}), ` +
  "which carries every fire of the chat. Stop your work on it, and end your turn with one line that points to that job.";

/** The words Prime puts before the token hook's own answer, which say nothing the hook's words do not. */
const TOKEN_HOOK_PREFIX = /^Failed to resolve API key for provider "[^"]+" from shell command: \S+ /;

/**
 * One rule to escalate: `job` names the job that took its fire and has had no model turn, `error` that job's last failed call, and `queued`
 * its run's place in pi-pool's turn queue while the queue holds it.
 */
export type EscalationLine = AlertLine & { chat: string; job?: string; error?: string; queued?: QueuePlace;
  /** The job the bridge replaced for this fire, since it ended with no model turn (`replaceEnded`). */
  replaced?: string;
  /** With no job: when the start of the chat's triage job began, while it still runs. */
  waitingSince?: number;
  /** With no job: why the last start of the chat's triage job failed. */
  startError?: string };

/** The escalation to ops guy, with the rules grouped by chat and by the job that has them. */
export function escalationText(lines: readonly EscalationLine[]): string {
  const failed = (error: string): string => error.replace(TOKEN_HOOK_PREFIX, "").slice(0, 200);
  const groups = new Map<string, EscalationLine[]>();
  for (const line of lines) groups.set(`${line.chat}\u0000${line.job ?? ""}`, [...groups.get(`${line.chat}\u0000${line.job ?? ""}`) ?? [], line]);
  const parts = [...groups.values()].map(group => {
    const { chat, job, error, queued, replaced, waitingSince, startError } = group.find(line => line.queued) ?? group.find(line => line.error) ?? group[0]!;
    const why = replaced ? `its triage job ${replaced} ended with no model turn after it took the fire${error ? ` (its last call failed: ${failed(error)})` : ""}, ` +
        "so the bridge gives it to a live or fresh triage job"
      : job && queued ? `its triage job ${job} has had no model turn, because its run waits in pi-pool's turn queue (${queued.position} of ${queued.total}, since ${minute(queued.since)})`
      : job ? `its triage job ${job} has had no model turn${error ? ` (its last call failed: ${failed(error)})` : ""}`
      : waitingSince !== undefined ? `the start of its triage job has waited since ${minute(waitingSince)} and has not finished`
      : startError ? `the start of its triage job failed (${startError.slice(0, 200)}) and is tried again each poll` : "the alert bridge has not started its triage job yet";
    return `on ${chat}, ${why}: ${group.map(line => ruleText(line)).join(", ")}`;
  });
  return `[alert-escalation] ${lines.length === 1 ? "A rule has" : `${lines.length} rules have`} nobody working ${lines.length === 1 ? "its" : "their"} fire ` +
    `${ESCALATE_MS / 60_000} min after it. ${parts.map(part => part[0]!.toUpperCase() + part.slice(1)).join(". ")}. ` +
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
  /** Starts the triage job of `chat` for its owed fires; `previous` is the chat's last triage job, which has ended. Absent, fires escalate to ops guy. */
  startJob?: (chat: string, lines: readonly AlertLine[], previous?: TriageJob) => Promise<AlertJob>;
  /**
   * The pi-host threads, which Prime's daemon does not know (c93). A thread that owns a rule is its own triage job: each owed fire goes to it
   * as one agent message (`threadAlertText`), and a root turn of it that ends after the fire holds the fire, so dedupe, refire, reopen,
   * escalation and resolve run as for a chat with a board.
   */
  threads?: {
    /** The live threads by id, with their names. */
    list: () => Promise<ReadonlyMap<string, string>>;
    /** Submits the text to the thread as an agent message keyed by `requestId`. */
    send: (thread: string, text: string, requestId: string) => Promise<void>;
    /** Whether a root turn of the thread ended after `since`. */
    turn: (thread: string, since: number) => Promise<TurnSince>;
  };
  /** Whether a job the bridge started still works its turn. */
  jobWorking?: (job: AlertJob) => Promise<boolean>;
  /** Whether a model turn of the job ended after `since` (`readTurnSince`). Absent, every job that took a fire holds it. */
  jobTurn?: (job: AlertJob, since: number) => Promise<TurnSince>;
  /** Asks the resume pass to continue a job whose first call pi-pool held, once the slot its error names has passed. */
  retryJob?: (job: AlertJob) => void;
  /** When pi-pool next gives the tree rooted at `tree` a `provider` account (`poolFreeAt`): now when it would now, null when the pool does not say. */
  poolFreeAt?: (tree: string, provider: string) => Promise<number | null>;
  /** Why a job that does not work is about to run (`jobLive`: a pending wake, a queued pi-pool run, a fresh watchdog continue), else null. */
  jobLive?: (session: string, now: number) => Promise<string | null>;
  /** The session's place in pi-pool's turn queue (`pi-pool queue --json`), null when its run does not wait there. */
  turnQueued?: (session: string) => Promise<QueuePlace | null>;
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
  /** The live pi-host threads by id, with their names, from the last poll that read them. */
  private threads: ReadonlyMap<string, string> = new Map();
  /** The chats whose hand-off runs now, with when it began. */
  private readonly handing = new Map<string, number>();
  /** Each chat's last failed hand-off, until one succeeds. */
  private readonly startErrors = new Map<string, string>();
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
      const chats = new Set(Object.values(state.rules).filter(rule => !isResolved(rule) || waiting(state, rule, now)).map(rule => rule.chat));
      if (this.deps.threads && chats.size) {
        this.threads = await this.deps.threads.list().catch(error => {
          this.deps.log(`alerts: pi-host threads: ${message(error)}; kept the last list`);
          return this.threads;
        });
      }
      for (const chat of chats) (this.threads.has(chat) || (await this.deps.hasBoard?.(chat) ?? true) ? boarded : boardless).add(chat);
      this.firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
      this.boarded = boarded;
      state = await this.reopen(state, boarded, now);
      const watched = await this.watch(state, now);
      state = await this.tell(this.replaceEnded(watched.state, watched.ended, now), boardless, now);
      return this.escalate(state, boarded, watched, now);
    });
    return true;
  }

  /**
   * Gives each chat's owed fires (`owed`) to the chat's triage job, all in one go: by one message while that job still works or has never had
   * a turn, or else to one new job that carries them all. Each chat's hand-off runs on its own, and a chat whose hand-off still runs is skipped,
   * so one slow start holds up no other chat: at 16:52:54Z on 10-19 the start for crawler-prod-jobs-wait-budget-failed queued behind duty creates
   * of 50 to 90 s each while the daemon was overloaded, and no other chat got a fire until the 17:05Z restart. A start or message that fails
   * leaves the fires owed, so they go again next dispatch, and the failure or the wait goes into the escalation at ESCALATE_MS. The slow calls
   * run outside `update`, so polls go on meanwhile.
   */
  async dispatch(): Promise<void> {
    if (!this.deps.startJob && !this.deps.threads) return;
    const snapshot = await this.update(async state => state);
    const byChat = new Map<string, string[]>();
    for (const [key, rule] of Object.entries(snapshot.rules)) {
      if (owed(snapshot, rule) && this.boarded.has(rule.chat) && !this.handing.has(rule.chat) && (this.deps.startJob || this.threads.has(rule.chat))) byChat.set(rule.chat, [...byChat.get(rule.chat) ?? [], key]);
    }
    await Promise.all([...byChat].map(([chat, keys]) => this.handOff(snapshot, chat, keys)));
  }

  private async handOff(snapshot: BridgeState, chat: string, keys: readonly string[]): Promise<void> {
    const lines = keys.map(key => alertLine(snapshot.rules[key]!, this.firing));
    const current = snapshot.chats[chat] === undefined ? undefined : snapshot.jobs[snapshot.chats[chat]!];
    this.handing.set(chat, this.now());
    try {
      const job = await this.give(chat, current, lines);
      this.startErrors.delete(chat);
      await this.point(snapshot, keys, job, current);
      const at = this.now();
      await this.update(async state => {
        const rules = { ...state.rules };
        for (const key of keys) {
          const now = rules[key];
          const was = snapshot.rules[key]!;
          if (!now || now.job?.id !== was.job?.id || now.job?.at !== was.job?.at) continue;
          rules[key] = { ...now, job: { id: job.id, name: job.name, at } };
        }
        return pruned({ ...state, rules, jobs: { ...state.jobs, [job.id]: { ...state.jobs[job.id], ...job } }, chats: { ...state.chats, [chat]: job.id } });
      });
    } catch (error) {
      this.startErrors.set(chat, message(error));
      this.deps.log(`alerts: triage job of ${chat.slice(0, 8)} for ${lines.map(line => line.rule).join(", ")}: ${message(error)}; tried again next tick`);
    } finally { this.handing.delete(chat); }
  }

  /**
   * Tells each other job that had one of `keys` that the chat's triage job owns it now, so a duplicate the pool wakes later stops and frees its
   * worker. At 20:30Z on 10-19 eight per-rule jobs for hyperdx-error-logs from before the per-chat change woke at once and read the same fault.
   */
  private async point(snapshot: BridgeState, keys: readonly string[], owner: TriageJob, previous: TriageJob | undefined): Promise<void> {
    const old = new Map<string, { name: string; at: number; rules: string[] }>();
    for (const key of keys) {
      const was = snapshot.rules[key]!.job;
      if (!was || was.id === owner.id || was.id === previous?.id) continue;
      old.set(was.id, { name: was.name, at: Math.min(was.at, old.get(was.id)?.at ?? Infinity), rules: [...old.get(was.id)?.rules ?? [], snapshot.rules[key]!.rule] });
    }
    for (const [id, { name, at, rules }] of old) {
      // Only a job that may still take a turn on the rule hears it: one that works, or whose turn since it took the rule has not run. A finished
      // job would wake for nothing and take a working slot. On 10-28 at 02:34Z to 02:35Z four vent triage jobs idle 11 h to 4 days (22:09,
      // 09:32, 18:07, 01:51) got this note, parked on pi-pool's queue, had their park wakes dropped and were continued by the job sweep.
      if (!(await this.mayTurn({ id, name }, at))) {
        this.deps.log(`alerts: did not tell job ${name} (${id.slice(0, 8)}) that triage job ${owner.name} owns ${rules.join(", ")}: it ended`);
        continue;
      }
      await this.deps.deliver(id, ownedByText(rules, owner)).then(
        () => this.deps.log(`alerts: told job ${name} (${id.slice(0, 8)}) that triage job ${owner.name} owns ${rules.join(", ")}`),
        error => this.deps.log(`alerts: tell job ${id.slice(0, 8)} its owner: ${message(error)}`));
    }
  }

  /** The job works, or no turn of it ran since `since`; true when the bridge cannot read either. */
  private async mayTurn(job: AlertJob, since: number): Promise<boolean> {
    if (await (this.deps.jobWorking?.(job) ?? Promise.resolve(false)).catch(() => true)) return true;
    if (!this.deps.jobTurn) return this.deps.jobWorking === undefined;
    const turn = await this.deps.jobTurn(job, since).catch(() => null);
    return turn === null || !turn.ran;
  }

  /**
   * The triage job that takes the chat's fires now. A job that never had a turn keeps them, and so does one whose last call failed on a pool
   * wait or another transient error after it ran, since the resume pass continues it: on 10-19 the bridge read such jobs as ended and
   * started another for each fire, until 25 jobs for hyperdx-error-logs sat in pi-pool's queue with no turn and 8 of them woke at once at 20:30Z.
   */
  private async give(chat: string, current: TriageJob | undefined, lines: readonly AlertLine[]): Promise<TriageJob> {
    const rules = lines.map(line => line.rule).join(", ");
    const thread = this.threads.get(chat);
    if (thread !== undefined) {
      await this.deps.threads!.send(chat, threadAlertText(lines), threadRequestId(lines));
      this.deps.log(`alerts: ${chat.slice(0, 8)}: sent ${rules} to pi-host thread ${thread}`);
      return current?.id === chat ? current : { id: chat, name: thread, chat, at: this.now() };
    }
    const keep = async (job: TriageJob): Promise<boolean> => {
      if (await this.deps.jobWorking?.(job)) return true;
      if (!this.deps.jobTurn || this.now() - (job.ranAt ?? job.at) >= REOPEN_MS) return false;
      const turn = await this.deps.jobTurn(job, job.ranAt === undefined ? job.at : job.ranAt + 1);
      return job.ranAt === undefined ? !turn.ran : !turn.ran && (turn.slotAt !== undefined || (turn.error !== undefined && transientTurnError(turn.error)));
    };
    if (current && current.replacedAt === undefined && await keep(current)) {
      await this.deps.deliver(current.id, firedAgainText(lines));
      this.deps.log(`alerts: ${chat.slice(0, 8)}: sent ${rules} to triage job ${current.name} (${current.id.slice(0, 8)})`);
      return current;
    }
    const started = await this.deps.startJob!(chat, lines, current);
    this.deps.log(`alerts: ${chat.slice(0, 8)}: started triage job ${started.name} (${started.id.slice(0, 8)}) for ${rules}`);
    return { id: started.id, name: started.name, chat, at: this.now() };
  }

  /**
   * Reads each triage job that has a fire with no turn since (`waiting`): its latest turn marks `ranAt`, so it holds every fire it took before
   * that. A job whose failed call names a pool slot that has passed, and that does not work, gets one retry per slot through the resume pass,
   * which continues it once pi-pool admits its tree. The errors, by job id, go with the escalation, and `parked` holds each job whose slot is
   * ahead or passed within one tick, so the retry this poll asked for gets a poll to show its turn: the resume pass answered 1 to 2 s after the
   * slot on 10-20 (05:06:00Z to 05:06:02Z, 05:13:28Z to 05:13:29Z). Past that tick the job stays in `parked` while pi-pool still names a time
   * ahead for its tree, since its next call meets a new wait: on 10-20 job 01a15aac's slot was 20:12:16Z, the pool waited for rotation, the
   * bridge escalated at 20:12:54Z, and Prime's next call at 20:13:18Z got a backoff to 20:27:51Z. It ran at 20:58:56Z, once an account served.
   * A failed call that names no slot stays in `parked` the same way: on 10-21 job 01a15bc4's first call, at 00:02:20Z, failed on "the token
   * hook gave no token", pi-pool held its tree until 01:50:03Z, and the bridge escalated vent-health-failure-rate-prod at 00:32:12Z.
   * `queued` holds each such job whose run waits in pi-pool's turn queue, so its escalation says the queue holds it: on 10-22 job 01a16080
   * took crawler-prod-sticky-block-rotations-jump at 11:53:27Z while its run sat in the queue from 11:28:22Z (126 queued, 6 working), the
   * bridge escalated it at 12:23:43Z as a job with no model turn, and pi-pool let the run in at 12:57:04Z.
   * A job whose last call failed on a transient error (`transientTurnError`: a lost connection, a timeout, pi-pool's token hook, a limit or a
   * failing provider) has not ended either: the catalog reads its cut and runs the resume pass at once (`resumesNow`), which continues it once
   * pi-pool can serve it, and its fire escalates at ESCALATE_MS with the error while no turn comes. Read as ended, such a job's fire went to a
   * fresh job on the next poll while the resume pass continued the old one, so two jobs worked one fire, and in an outage each fresh job could
   * fail the same way. A job about to run (`jobLive`) has not ended either: on 10-25 the watchdog sent 01a1753b a continue at 23:49:35Z, the
   * bridge read it as ended at 23:50:07Z and started a second job, and the continue's run reached pi-pool's queue at 23:50:12Z.
   */
  private async watch(state: BridgeState, now: number): Promise<{ state: BridgeState; errors: Map<string, string>; parked: Set<string>; queued: Map<string, QueuePlace>; ended: Set<string> }> {
    const errors = new Map<string, string>();
    const queued = new Map<string, QueuePlace>();
    const parked = new Set<string>();
    const ended = new Set<string>();
    const since = new Map<string, number>();
    for (const rule of Object.values(state.rules)) {
      if (waiting(state, rule, now) && state.jobs[rule.job!.id]) since.set(rule.job!.id, Math.min(since.get(rule.job!.id) ?? Infinity, rule.job!.at));
    }
    const jobs = { ...state.jobs };
    for (const [id, from] of since) {
      const job = jobs[id]!;
      const thread = this.threads.has(id);
      const turn: TurnSince | null = thread ? await this.deps.threads!.turn(id, from).catch(() => null)
        : this.deps.jobTurn ? await this.deps.jobTurn(job, from).catch(() => null) : { ran: true, at: now };
      if (!turn) continue;
      if (turn.ran) { jobs[id] = { ...job, ranAt: turn.at }; continue; }
      if (turn.error) errors.set(id, turn.error);
      // A thread never ends while pi-host lists it, so its fires stay with it and escalate at ESCALATE_MS while no turn of it ends.
      if (thread) { if (turn.slotAt !== undefined && now < turn.slotAt + TICK_MS) parked.add(id); continue; }
      const place = await this.deps.turnQueued?.(id).catch(() => null);
      if (place) queued.set(id, place);
      if ((turn.slotAt !== undefined && now < turn.slotAt + TICK_MS) || await this.poolHolds(id, turn.provider, now)) parked.add(id);
      const retry = this.deps.retryJob !== undefined && turn.slotAt !== undefined && turn.slotAt <= now && (job.retriedAt ?? -1) < turn.slotAt;
      const working = await (this.deps.jobWorking?.(job) ?? Promise.resolve(true)).catch(() => true);
      const transient = turn.error !== undefined && transientTurnError(turn.error);
      if (!working && !retry && !place && !parked.has(id) && !transient) {
        const live = await (this.deps.jobLive?.(id, now) ?? Promise.resolve(null)).catch(() => null);
        if (live) this.deps.log(`alerts: triage job ${job.name} (${id.slice(0, 8)}) does not work, but ${live}; not ended`);
        else ended.add(id);
      }
      if (!retry || working || turn.slotAt === undefined) continue;
      this.deps.retryJob!(job);
      jobs[id] = { ...job, retriedAt: turn.slotAt };
      this.deps.log(`alerts: triage job ${job.name} (${id.slice(0, 8)}) has had no turn and its pool slot ${minute(turn.slotAt)} passed; asked the resume pass to continue it`);
    }
    return { state: { ...state, jobs }, errors, parked, queued, ended };
  }

  /**
   * Marks each job in `ended` replaced (`replacedAt`) while a fire it took still fires, so `dispatch` gives those fires to the chat's live
   * triage job, or to a fresh one at once when the ended job was the chat's own. `ended` holds the jobs with no model turn since they took a
   * fire whose session has ended, was archived or settled on a failed call that is not transient. A job pi-pool holds keeps its place: one
   * in the turn queue would have a fresh job queue behind it, as on 10-22, when 01a16086's run had waited 55 min at 12:21Z behind 193 others,
   * and one that failed on a pool wait gets its continue from the resume pass.
   */
  private replaceEnded(state: BridgeState, ended: ReadonlySet<string>, now: number): BridgeState {
    const jobs = { ...state.jobs };
    for (const id of ended) {
      const job = jobs[id];
      if (!job || job.replacedAt !== undefined || !Object.values(state.rules).some(rule => rule.job?.id === id && !isResolved(rule))) continue;
      jobs[id] = { ...job, replacedAt: now };
      this.deps.log(`alerts: triage job ${job.name} (${id.slice(0, 8)}) ended with no turn after it took a fire; its fires go to a live or fresh job`);
    }
    return { ...state, jobs };
  }

  /** Whether pi-pool names a time ahead of `now` for the tree rooted at `tree`; a pool that does not say holds nothing. */
  private async poolHolds(tree: string, provider: string | undefined, now: number): Promise<boolean> {
    if (!provider || !this.deps.poolFreeAt) return false;
    const freeAt = await this.deps.poolFreeAt(tree, provider).catch(() => null);
    return freeAt !== null && freeAt > now;
  }

  /**
 * Marks each rule that still fires REOPEN_MS after its job took it, and whose job has ended, as fired now, so `dispatch` starts a new job. A
 * pi-host thread never ends, so its rule goes to it again.
 */
  private async reopen(state: BridgeState, boarded: ReadonlySet<string>, now: number): Promise<BridgeState> {
    const due = dueReopens(state, now).filter(key => boarded.has(state.rules[key]!.chat));
    if (!due.length) return state;
    const rules = { ...state.rules };
    for (const key of due) {
      if (!this.threads.has(rules[key]!.job!.id) && await (this.deps.jobWorking?.(rules[key]!.job!) ?? Promise.resolve(false)).catch(() => true)) continue;
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

  private async escalate(state: BridgeState, boarded: ReadonlySet<string>, { errors, parked, queued }: { errors: ReadonlyMap<string, string>; parked: ReadonlySet<string>; queued: ReadonlyMap<string, QueuePlace> }, now: number): Promise<BridgeState> {
    const due = dueEscalations(state, boarded, now, parked);
    if (!due.length) return state;
    try {
      await this.deps.deliver(OPS_ROUTE.session, escalationText(due.map(key => {
        const rule = state.rules[key]!;
        const job = rule.job && !owed(state, rule) ? rule.job : undefined;
        const error = job && errors.get(job.id);
        const place = job && queued.get(job.id);
        const old = rule.job && state.jobs[rule.job.id]?.replacedAt !== undefined ? rule.job : undefined;
        const oldError = old && errors.get(old.id);
        const replaced = old ? { replaced: old.name, ...oldError ? { error: oldError } : {} } : {};
        const start = job ? {} : this.handing.has(rule.chat) ? { waitingSince: this.handing.get(rule.chat)! }
          : this.startErrors.has(rule.chat) ? { startError: this.startErrors.get(rule.chat)! } : {};
        return { ...alertLine(rule, this.firing), chat: this.threads.get(rule.chat) ?? chatName(rule.chat), ...job ? { job: job.name } : {}, ...error ? { error } : {}, ...place ? { queued: place } : {}, ...replaced, ...old ? {} : start };
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

/**
 * The firing rules of `chat` in the state file, for a duty's precheck. A missing file throws, so the precheck reports a source error and
 * never a count of 0 it did not read: the bridge writes the file at its first poll, and the duties run on the box where the bridge runs.
 */
export async function readFiringRules(file: string, chat: string): Promise<Tracked[]> {
  return firingRules(parseState(JSON.parse(await readFile(file, "utf8"))), chat);
}

export class GrafanaError extends Error {
  constructor(readonly status: number) { super(`Grafana answered ${status} for the alert list`); }
}

/** Grafana's answer to `path`, with the url and token of the config file; null when the file is gone. */
async function readGrafana(configFile: string, path: string): Promise<unknown> {
  const text = await readFile(configFile, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (text === null) return null;
  const config = JSON.parse(text) as unknown;
  if (!isRecord(config) || typeof config.url !== "string" || typeof config.token !== "string") throw new Error(`${configFile} needs a url and a token`);
  // The alert list answered in 135 to 411 ms over 30 reads at load 367 on 10-19 16:30Z, and the rule list in 130 ms to 1.9 s over 6 reads at
  // 17:40Z. A read past 20 s is a stall on our side: at 16:10Z the box was in swap with 11 OOM kills, a 10 s sleep elsewhere on it woke up to
  // 114 s late, and the read aborted with the next poll 30 s on.
  const response = await fetch(new URL(path, config.url), { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new GrafanaError(response.status);
  return response.json();
}

export async function readGrafanaAlerts(configFile: string): Promise<FiringAlert[] | null> {
  const value = await readGrafana(configFile, GRAFANA_ALERTS_PATH);
  return value === null ? null : parseAlerts(value);
}

/** What Grafana's rule list says of one rule: whether it has not evaluated since Grafana started, and how many of its instances alert now. */
export interface RuleState { unevaluated: boolean; alerting: number }

/**
 * Each rule of Grafana's rule list by uid. Grafana 12.3 lists a rule it has not evaluated since it started with lastEvaluation
 * 0001-01-01T00:00:00Z ("default other fields for unscheduled rules" in pkg/services/ngalert/api/prometheus/api_prometheus.go), and counts
 * its instances by state in `totals`, where a Recovering instance still fires. A paused rule never evaluates, so it is left out.
 */
export function parseRuleStates(value: unknown): Map<string, RuleState> {
  const groups = isRecord(value) && isRecord(value.data) && Array.isArray(value.data.groups) ? value.data.groups : null;
  if (!groups) throw new Error("Grafana's rule list has no groups");
  const rules = groups.flatMap(group => isRecord(group) && Array.isArray(group.rules) ? group.rules : []);
  const count = (totals: unknown, state: string): number => isRecord(totals) && typeof totals[state] === "number" ? totals[state] as number : 0;
  return new Map(rules.flatMap(rule => isRecord(rule) && typeof rule.uid === "string" && rule.isPaused !== true ? [[rule.uid, {
    unevaluated: !(Date.parse(typeof rule.lastEvaluation === "string" ? rule.lastEvaluation : "") > 0),
    alerting: count(rule.totals, "alerting") + count(rule.totals, "recovering"),
  }] as const] : []));
}

export async function readRuleStates(configFile: string): Promise<Map<string, RuleState>> {
  return parseRuleStates(await readGrafana(configFile, GRAFANA_RULES_PATH));
}

/**
 * The current list plus each alert of the last list that is missing from it while Grafana's rule list says its rule still fires, so the
 * bridge does not resolve it: the rule has not evaluated since Grafana started, or Grafana counts more of its instances alerting than the
 * alert list holds. A restarted Grafana lists a firing alert only some time after it evaluates the rule again. On 10-19 virev-obs-grafana
 * stopped at 17:20:47Z, the alert list answered 502 at 17:20:58Z, and the first list of the new Grafana at 17:22:07Z lacked every CI rule,
 * so the bridge resolved them all, ci-jobs-waiting among them, while each still fired. On 10-29 the obs deploy of 7a2f0d2868 recreated
 * virev-obs-grafana, and its alert list at the bridge's poll at 15:42:52Z lacked the firing CI rules after each had evaluated again, so the
 * bridge resolved them all for one poll and d4's precheck read alerts_firing 0 at 15:43:23Z, while Grafana's state history kept
 * ci-turbo-force-failed and ci-staging-check-task-red Alerting throughout. The rule list is read only when an alert went missing, and a failed read fails the poll, so nothing resolves on it.
 */
export async function holdStillFiring(previous: readonly FiringAlert[] | null, current: FiringAlert[], states: () => Promise<ReadonlyMap<string, RuleState>>): Promise<FiringAlert[]> {
  const listed = new Set(current.map(alertKey));
  const gone = (previous ?? []).filter(alert => !listed.has(alertKey(alert)));
  if (!gone.length) return current;
  const rules = await states();
  const shown = new Map<string, number>();
  for (const alert of current) shown.set(ruleOf(alert), (shown.get(ruleOf(alert)) ?? 0) + 1);
  const fires = (alert: FiringAlert): boolean => {
    const rule = rules.get(ruleOf(alert));
    return rule !== undefined && (rule.unevaluated || rule.alerting > (shown.get(ruleOf(alert)) ?? 0));
  };
  return [...current, ...gone.filter(fires)];
}

export async function readOwnersFor(configFile: string, home: string): Promise<OwnerMap | null> {
  const text = await readFile(configFile, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  const config = text === null ? {} : JSON.parse(text) as unknown;
  const repo = isRecord(config) && typeof config.ownersRepo === "string" ? config.ownersRepo : join(home, "Documents/Github/auto-sns-agent");
  const refs = isRecord(config) && Array.isArray(config.ownersRefs) ? config.ownersRefs.filter((ref): ref is string => typeof ref === "string") : [];
  return readOwners(repo, ["origin/main", ...refs]);
}

/**
 * Starts the bridge: a poll each `everyMs`, and after each poll a dispatch, which skips each chat whose hand-off still runs, so a slow job
 * start never skips a poll or holds up another chat.
 */
export function startAlertBridge(deps: AlertBridgeDeps, everyMs = TICK_MS): () => void {
  const bridge = new AlertBridge(deps);
  let polling = false;
  const dispatch = () => { void bridge.dispatch().catch(error => deps.log(`alerts: dispatch: ${errorText(error)}`)); };
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
