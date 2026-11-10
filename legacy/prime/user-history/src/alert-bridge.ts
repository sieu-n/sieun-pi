import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALERT_ROUTES, OPS_ROUTE, routeAlert } from "./alert-routes.ts";
import { missing } from "./locked-json.ts";
import type { TurnSince } from "./held-turns.ts";
import { TICK_MS } from "./wakes.ts";

/**
 * The alert bridge: each Grafana alert rule that fires for a chat with a board goes to that chat's own thread by message, and the thread starts
 * the triage with rlm.spawn. Fires that back up for a chat, while the pool holds its thread or an earlier alert message still waits for its
 * turn, go together as one message once it can take input. The owner, 11-07 (c219): "don't complicate shit. and when things back up, process
 * it as 1 batched request to AI-chat thread don't' queue them". Until then the bridge started a triage job per chat, and while every Claude
 * account was limited each job waited behind 10 to 26 other runs in pi-pool's queue, 56 min at the median (ops guy's t49). The bridge puts
 * nothing on the plan. The owner, 10-18: "stop being paranoid in plan
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
/**
 * One firing label set of a rule, keyed in `Tracked.instances` by alertKey (fingerprint@startsAt). `seenAt` is when the bridge first listed
 * it, so a fire names the label sets it saw at or after the rule's `wokeAt` (`alertLine`). A state saved before 10-31 has none. `values` are
 * the alert's values at `seenAt`, since Grafana rewrites `__values__` at each evaluation: on 11-10 viewer-wall-walls-spike fired at 03:34:30Z
 * at A=26, C=1, its fire waited for ops guy's thread until 06:21Z, and the message printed A=0, C=0 from an evaluation after it cleared.
 */
export interface Instance { startsAt: string; labels: Record<string, string>; seenAt?: number; resolvedAt?: number; values?: string }
/** The session that took a fire: the owning chat's thread, or a triage job from before 11-07. */
export interface AlertJob { id: string; name: string }
/** The triage job a rule's fire went to, and when the bridge gave it (started the job with it, or sent it by message). */
export interface RuleJob extends AlertJob { at: number }
/**
 * A session that took fires of one owner chat: the chat's thread, or a triage job of it from before 11-07. It holds a fire only once a model
 * turn of it ended after it took the fire (`held`): job 01a15416 for metal-prod-crawler-netns-ports started at 12:15:14Z on 10-19, failed its
 * first call on a pi-pool slot wait and had no turn at 14:46Z, and the bridge counted it as holding the fire, so nothing escalated.
 */
export interface TriageJob extends AlertJob { chat: string;
  /** When it first took a fire. */
  at: number;
  /** When the bridge saw its latest model turn end. Absent: it never had a turn since. */
  ranAt?: number }
/**
 * One alert rule firing in one owning chat. `rule` is the rule uid, or the alertname when the uid label is missing. The rule resolves when
 * every instance has resolved.
 */
export interface Tracked { chat: string; rule: string; alertname: string; startsAt: string;
  /** When the rule last fired: first seen, back after it resolved, or still firing REOPEN_MS or with an unread label set after its job ended. A job whose `at` is older owes this fire. */
  wokeAt: number;
  /** When this entry first fired; the boardless tells count from it (`dueTells`). */
  firstWokeAt: number;
  /** When the bridge last escalated the rule to ops guy, or first told a boardless owner past ESCALATE_MS. */
  escalatedAt?: number;
  resolvedAt?: number; instances: Record<string, Instance>;
  /** When the bridge last told the rule's owner, a session with no board, that it fires (`dueTells`). */
  toldAt?: number;
  job?: RuleJob }
/** The rules, the sessions any rule names (by session id), and the session each owner chat's fires go to: its own thread since 11-07. */
export interface BridgeState { v: 4; rules: Record<string, Tracked>; jobs: Record<string, TriageJob>; chats: Record<string, string> }
export interface OwnerRoute { name: string; match: Record<string, string>; owner: string }
export interface OwnerMap { owners: Record<string, string>; fallback: string; routes: OwnerRoute[] }
export type Router = (alert: FiringAlert) => string;
/**
 * One label set of a fire as its triage job reads it: the labels that tell it apart, its own summary, its values when the bridge first saw it
 * (`values`), its values in the list now when they differ or none were kept (`now`), what Grafana's rule list says of it at the send when it
 * no longer alerts (`ended`), and its Grafana link.
 */
export interface AlertFire { labels: Record<string, string>; summary: string; url: string; values?: string; now?: string; ended?: SetState }
/**
 * One firing rule as its triage job reads it, with the label sets of its fire: those that newly fired (`fresh`), or every firing one when
 * the fire is a reopen or an escalation with no new label set.
 */
export interface AlertLine { rule: string; alertname: string; startsAt: string; firedAt: number; sets: number; fresh: boolean; fires: AlertFire[];
  /** When Grafana put the last of the shown label sets back to Normal, when every one of them is Normal at the send. */
  resolvedAt?: number }

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
  type Old = Tracked & { step?: unknown; closedAt?: unknown; job?: RuleJob & { ranAt?: number } };
  const jobs: Record<string, TriageJob> = {};
  const chats: Record<string, string> = {};
  const latest: Record<string, number> = {};
  const rules = Object.fromEntries(Object.entries(value.rules as Record<string, Old>).map(([key, old]) => {
    const { step: _step, closedAt: _closed, job, ...rule } = old;
    if (!job) return [key, rule];
    const was = jobs[job.id];
    jobs[job.id] = { id: job.id, name: job.name, chat: rule.chat, at: Math.min(was?.at ?? job.at, job.at),
      ...job.ranAt !== undefined || was?.ranAt !== undefined ? { ranAt: Math.max(job.ranAt ?? 0, was?.ranAt ?? 0) } : {} };
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
 * Whether the rule's last fire still waits to be sent: it has no session, the bridge gave it to its session before that fire, or it went to a
 * triage job from before 11-07 that never had a turn, so the chat's thread takes it over.
 */
export const owed = (state: BridgeState, rule: Tracked): boolean => !isResolved(rule) && (rule.job === undefined || rule.job.at < rule.wokeAt ||
  (rule.job.id !== rule.chat && state.jobs[rule.job.id]?.ranAt === undefined));

/** Whether the rule's job took its last fire and had a model turn end since, so someone works the fire. */
export const held = (state: BridgeState, rule: Tracked): boolean => {
  const ran = rule.job && state.jobs[rule.job.id]?.ranAt;
  return rule.job !== undefined && rule.job.at >= rule.wokeAt && ran !== undefined && ran >= rule.job.at;
};

/** Whether the rule's session took its last fire within REOPEN_MS and has had no model turn since: the bridge watches it for its next turn. */
export const waiting = (state: BridgeState, rule: Tracked, now: number): boolean =>
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
 *    so is a fire within REFIRE_MS of the rule resolving, which keeps the rule's entry and its job and fires nothing here. Once that job has
 *    ended, `reopen` fires the rule for the label sets it never read (`dueReopens`). A label set back within REFIRE_MS keeps the `seenAt` of
 *    the instance it repeats, so a Grafana reset reopens nothing, and so does a fingerprint that fires again with a new startsAt while
 *    `holdStillFiring` still holds its old instance through a reset.
 * 5. A rule whose label `incident_by` names one of its labels, such as `spec`, holds one fault per value of that label: a new label set whose
 *    value no open instance of the rule has fires the rule again, so its job owes it. On 10-30 at 17:06Z hosted-app-chat.spec.ts went red on
 *    ci-staging-proof-spec-red while hosted-inbox-whatsapp-dm.spec.ts, held red on Meta's name approval, kept the rule open, and no job got it.
 */
export function advance(alerts: readonly FiringAlert[], state: BridgeState, route: Router, now: number): { state: BridgeState; fired: Set<string> } {
  const rules: Record<string, Tracked> = structuredClone(state.rules);
  const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
  const fired = new Set<string>();
  const blips = new Set<string>();
  const owner = new Map<string, string>();
  for (const [key, rule] of Object.entries(rules)) for (const instance of Object.keys(rule.instances)) owner.set(instance, key);
  const rest: FiringAlert[] = [];
  for (const [id, alert] of firing) {
    const key = owner.get(id);
    if (!key) { rest.push(alert); continue; }
    const rule = rules[key]!;
    delete rule.resolvedAt;
    rule.rule = ruleOf(alert);
    const { seenAt: seen, values } = rule.instances[id]!;
    rule.instances[id] = { startsAt: alert.startsAt, labels: alert.labels, ...seen === undefined ? {} : { seenAt: seen }, ...values === undefined ? {} : { values } };
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
        blips.add(key);
      } else {
        rules[key] = { chat, rule: name, alertname: alert.alertname, startsAt: alert.startsAt, wokeAt: now, firstWokeAt: now, instances: {}, ...job ? { job } : {} };
        fired.add(key);
      }
    }
    const rule = rules[key]!;
    if (!fired.has(key) && newFault(rule, alert)) fired.add(key);
    const labels = labelText(alert.labels);
    const held = Object.entries(rule.instances).find(([id, instance]) => instance.resolvedAt === undefined && id.startsWith(`${alert.fingerprint}@`))?.[1];
    const before = blips.has(key) ? Object.values(rule.instances).find(instance => labelText(instance.labels) === labels) : held;
    for (const [id, instance] of Object.entries(rule.instances)) if (instance.resolvedAt !== undefined && id.startsWith(`${alert.fingerprint}@`)) delete rule.instances[id];
    const values = before?.seenAt !== undefined ? before.values : alert.values || undefined;
    rule.instances[alertKey(alert)] = { startsAt: alert.startsAt, labels: alert.labels, seenAt: before?.seenAt ?? now, ...values === undefined ? {} : { values } };
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

/** Whether the rule holds a firing label set the bridge first saw after it gave the rule to its job, so that job never read it. */
const grown = (rule: Tracked): boolean => rule.job !== undefined &&
  Object.values(rule.instances).some(instance => instance.resolvedAt === undefined && instance.seenAt !== undefined && instance.seenAt > rule.job!.at);

/**
 * The rules that fire again for their chat's thread: they still fire REOPEN_MS after the bridge last gave them, or they hold a label set it
 * never read (`grown`) and the session that took the last fire had a turn since (`held`). On 10-16 prod backup alerts fired for over 3 days
 * while nobody worked them. From 11-02 18:01Z ci-dev-branch-warn-red took 75 label sets from 44 first runs, and none reached a job for 24 h.
 */
export const dueReopens = (state: BridgeState, now: number): string[] => Object.entries(state.rules).flatMap(([key, rule]) =>
  !isResolved(rule) && rule.job && !owed(state, rule) && (now - rule.job.at >= REOPEN_MS || (grown(rule) && held(state, rule))) ? [key] : []);

/**
 * The rules of chats with a board whose fire nobody holds (`held`) ESCALATE_MS after it, once per fire: it was not sent, or the session that
 * took it has had no model turn. A fire that resolved before a turn escalates too, since nobody looked at it: metal-prod-crawler-netns-ports
 * fired at 12:14:30Z on 10-19, resolved at 12:28:42Z, and its job had no turn by 14:46Z. ops guy's own rules never escalate, since the
 * escalation goes to ops guy. A chat or session in `parked` waits for a pi-pool slot, and its fires escalate only once it no longer does: on
 * 10-20 three escalations (04:56Z, 05:17Z, 05:27Z) named two jobs whose slots at 05:06Z and 06:06Z were still ahead, and both ran at 05:40Z.
 */
export function dueEscalations(state: BridgeState, boarded: ReadonlySet<string>, now: number, parked: ReadonlySet<string> = new Set()): string[] {
  return Object.entries(state.rules).flatMap(([key, rule]) => ((owed(state, rule) && !parked.has(rule.chat)) || (waiting(state, rule, now) && !parked.has(rule.job!.id))) && boarded.has(rule.chat) &&
    rule.chat !== OPS_ROUTE.session && now - rule.wokeAt >= ESCALATE_MS && !(rule.escalatedAt !== undefined && rule.escalatedAt >= rule.wokeAt) ? [key] : []);
}

const ruleIn = (title: string, alertname: string): string => title.includes(alertname) ? "" : `${alertname}, `;
const minute = (at: string | number): string => `${new Date(at).toISOString().slice(0, 16)}Z`;

/** The labels of a label set a reader needs: Grafana's own and the bridge's routing labels go, and the alertname when it is the rule's. */
const shownLabels = (labels: Record<string, string>, alertname: string): Record<string, string> => Object.fromEntries(Object.entries(labels)
  .filter(([name, value]) => !name.startsWith("__") && name !== "grafana_folder" && name !== "incident_by" && !(name === "alertname" && value === alertname)));

/**
 * The rule as its job reads it, with the label sets of this tick's list that the bridge first saw at or after the rule's last fire, each with
 * its own summary. With none, such as a reopen, every firing label set. Every CI rule keeps an instance firing 30 min after it clears
 * (keepFiringFor, auto-sns-agent 25e5f33e58), and on 10-31 at 18:31Z ci-staging-proof-spec-red fired for hosted-zz-monitor-flow.spec.ts
 * with the summary of the held hosted-campaign-screening.spec.ts instance, "6 in a row", because the line took the oldest instance. The title
 * is the newest shown label set's alertname, since a rule's alertname can carry a count: at 19:12Z that day the entry, open from 10-30, still
 * held "CI staging-proof spec red 3 runs in a row" while the spec that fired was red 2 runs.
 */
export function alertLine(rule: Tracked, firing: ReadonlyMap<string, FiringAlert>, states?: ReadonlyMap<string, SetState>): AlertLine {
  const live = Object.entries(rule.instances).flatMap(([id, instance]) => firing.has(id) ? [{ alert: firing.get(id)!, instance }] : [])
    .sort((a, b) => a.alert.startsAt.localeCompare(b.alert.startsAt));
  const fresh = live.filter(({ instance }) => instance.seenAt !== undefined && (instance.seenAt >= rule.wokeAt || (rule.job !== undefined && instance.seenAt > rule.job.at)));
  const shown = fresh.length ? fresh : live;
  const alertname = shown.at(-1)?.alert.alertname ?? rule.alertname;
  const fires = shown.map(({ alert, instance }): AlertFire => {
    const ended = states?.get(setKey(alert.labels));
    return { labels: shownLabels(alert.labels, alertname), summary: alert.summary, url: alert.url, ...instance.values ? { values: instance.values } : {},
      ...alert.values && alert.values !== instance.values ? { now: alert.values } : {}, ...ended && Number.isFinite(ended.since) && /^(Normal|Recovering)/.test(ended.state) ? { ended } : {} };
  });
  const normal = fires.length > 0 && fires.every(fire => fire.ended?.state.startsWith("Normal"));
  return { rule: rule.rule, alertname, startsAt: rule.startsAt, firedAt: rule.wokeAt, sets: firingSets(rule), fresh: fresh.length > 0, fires,
    ...normal ? { resolvedAt: Math.max(...fires.map(fire => fire.ended!.since)) } : {} };
}

const labelText = (labels: Record<string, string>): string => Object.entries(labels).map(([name, value]) => `${name}=${value}`).join(", ");

/** One rule in a line of text: its uid, its title when that differs, and since when it fires, or when it fired and resolved. */
export const ruleText = (line: Pick<AlertLine, "rule" | "alertname" | "startsAt" | "sets" | "resolvedAt">): string =>
  `${line.rule} (${ruleIn(line.rule, line.alertname)}${line.resolvedAt === undefined ? `firing since ${minute(line.startsAt)}`
    : `fired at ${minute(line.startsAt)}, resolved at ${minute(line.resolvedAt)}`}${line.sets > 1 ? `, ${line.sets} label sets` : ""})`;

/** What Grafana says of a label set that no longer alerts: Normal since the time it resolved, or Recovering since its condition cleared. */
const endedText = (ended: SetState): string => ended.state.startsWith("Normal") ? `  Resolved at ${minute(ended.since)} (Grafana: ${ended.state}).`
  : `  Grafana reads it ${ended.state} since ${minute(ended.since)}, so its condition no longer holds.`;

/**
 * Each rule a triage job takes, with the labels, summary, values and Grafana link of each label set of its fire: the rule list of a Prime
 * triage brief and of a pi-host thread's alert message.
 */
export const alertRulesText = (lines: readonly AlertLine[]): string => lines.map(line => [`- ${ruleText(line)}`, ...line.fires.flatMap(fire => [
  Object.keys(fire.labels).length ? `  ${line.fresh ? "Fired" : "Firing"}: ${labelText(fire.labels)}` : "", fire.summary ? `  Summary: ${fire.summary}` : "",
  fire.values ? `  Values at the fire: ${fire.values}.` : "", fire.now ? `  Values now: ${fire.now}.` : "", fire.ended ? endedText(fire.ended) : "",
  fire.url ? `  Grafana: ${fire.url}` : ""])].filter(Boolean).join("\n")).join("\n");

/** How a triage job works its rules, in a Prime triage brief and in a pi-host thread's alert message. */
export const TRIAGE_WORK = "Group the rules by cause first: several rules often fire on one fault. Find each cause from evidence: the Grafana rule and its query, the " +
  "metrics and logs, and read-only reads on the box. Fix it at the root: a fix in our code or alert rules goes through the repo's normal land " +
  "path, and a rule that fires on something that is not a fault gets fixed or deleted. Follow the chat's rules for any box or repo you touch, and " +
  "send nothing outside (no email, ticket or vendor chat).";

/**
 * The agent message that gives a chat's thread its owed fires, all of them in one message. The thread reads the rules and starts the triage
 * with rlm.spawn, so the agent decides the fan-out (c22). `call` asks for each fire's fault call when the chat's duty keeps them.
 */
export const threadAlertText = (lines: readonly AlertLine[], call?: { at: number; call: FiringCall }): string => [
  `[alert] ${lines.length === 1 ? "A Grafana rule this thread owns fired" : `${lines.length} Grafana rules this thread owns fired`}. ${OWNERS_PATH} in ` +
    "auto-sns-agent routes the rule to this thread. The alert bridge sends every fire that waits for this thread in one message, and holds new " +
    "fires while the pool holds this thread or this message waits for your turn.",
  alertRulesText(lines),
  TRIAGE_WORK,
  "Start the triage with rlm.spawn, or send the fire with agent_message.send to the triage job you already run on the same cause. The bridge " +
    `sends a rule again when it fires again after it resolved, or when it still fires ${REOPEN_MS / 3_600_000} h later. It escalates the fire to ops guy ` +
    `when no turn of this thread ends within ${ESCALATE_MS / 60_000} min of it.`,
  call ? firingCallText(lines, call.at, call.call) : "",
].filter(Boolean).join("\n\n");

/** How a chat's duty writes the fault call of one alert firing (`Duty.firingCall`): the command, with `<key>` where the firing key goes, and its folder. */
export interface FiringCall { command: string; cwd: string }

/** A firing's key as a chat's duty reads it from the bridge's log line of the hand-off: the rule uid and the second of the hand-off. */
export const firingKey = (rule: string, at: number): string => `${rule}@${new Date(at).toISOString().slice(0, 19)}Z`;

/** The lines that ask a triage job to write the fault call of each firing it got at `at`. */
export const firingCallText = (lines: readonly AlertLine[], at: number, call: FiringCall): string =>
  `Write the fault call of each firing once you know its cause, since the chat's duty counts a firing with no call as a false alert: in ${call.cwd}, ` +
  `run \`${call.command}\` with <key> set to the firing key and the rest from what you found. ` +
  `${lines.length === 1 ? "The firing key is" : "The firing keys are"} ${lines.map(line => firingKey(line.rule, at)).join(", ")}.`;

/** The request id of one hand-off to a thread: the same fires give the same id, so a send repeated after a failed save lands once. */
export const threadRequestId = (lines: readonly AlertLine[]): string => `alert:${lines.map(line => `${line.rule}@${line.firedAt}`).join(",")}`;

/** The words Prime puts before the token hook's own answer, which say nothing the hook's words do not. */
const TOKEN_HOOK_PREFIX = /^Failed to resolve API key for provider "[^"]+" from shell command: \S+ /;

/** One rule to escalate: `job` names the session that took its fire and has had no model turn, `error` its last failed call, and `sendError` why the last send of the chat's fires failed. */
export type EscalationLine = AlertLine & { chat: string; job?: string; error?: string; sendError?: string };

/** The escalation to ops guy, with the rules grouped by chat and by the session that has them. */
export function escalationText(lines: readonly EscalationLine[]): string {
  const failed = (error: string): string => error.replace(TOKEN_HOOK_PREFIX, "").slice(0, 200);
  const groups = new Map<string, EscalationLine[]>();
  for (const line of lines) groups.set(`${line.chat}\u0000${line.job ?? ""}`, [...groups.get(`${line.chat}\u0000${line.job ?? ""}`) ?? [], line]);
  const parts = [...groups.values()].map(group => {
    const { chat, job, error, sendError } = group.find(line => line.error) ?? group[0]!;
    const why = job ? `${job} has had no model turn since it took the fire${error ? ` (its last call failed: ${failed(error)})` : ""}`
      : sendError ? `the send of its fires failed (${sendError.slice(0, 200)}) and is tried again each poll` : "the alert bridge has not sent its fires yet";
    return `on ${chat}, ${why}: ${group.map(line => ruleText(line)).join(", ")}`;
  });
  return `[alert-escalation] ${lines.length === 1 ? "A rule has" : `${lines.length} rules have`} nobody working ${lines.length === 1 ? "its" : "their"} fire ` +
    `${ESCALATE_MS / 60_000} min after it. ${parts.map(part => part[0]!.toUpperCase() + part.slice(1)).join(". ")}. ` +
    "Find why the thread gets no turn, and get each fire worked.";
}

const chatName = (session: string): string => ALERT_ROUTES.find(route => route.session === session)?.chat ?? session;

export interface AlertBridgeDeps {
  file: string;
  alerts: () => Promise<FiringAlert[] | null>;
  /** Hands the session the text on disk (src/agent-outbox.ts); `root` is started when the daemon does not find the session. */
  deliver: (session: string, text: string, root?: string) => Promise<void>;
  owners?: () => Promise<OwnerMap | null>;
  hasBoard?: (session: string) => Promise<boolean>;
  /** How the chat's duty writes a firing's fault call, which each alert message names; null for a chat whose duties keep no calls. */
  firingCall?: (chat: string) => Promise<FiringCall | null>;
  /**
   * The pi-host threads, which Prime's daemon does not know (c93). A thread gets its fires through pi-host instead of the agent outbox, and
   * dedupe, refire, reopen, escalation and resolve run as for a Prime chat.
   */
  threads?: {
    /** The live threads by id, with their names. */
    list: () => Promise<ReadonlyMap<string, string>>;
    /** Submits the text to the thread as an agent message keyed by `requestId`. */
    send: (thread: string, text: string, requestId: string) => Promise<void>;
    /** Whether a root turn of the thread ended after `since`. */
    turn: (thread: string, since: number) => Promise<TurnSince>;
  };
  /** Whether a model turn of the Prime session ended after `since` (`readTurnSince`). Absent, every session that took a fire holds it. */
  jobTurn?: (job: AlertJob, since: number) => Promise<TurnSince>;
  /** Whether the session waits for a pi-pool slot, so a message to it now would only wait (the agent outbox's `slotPark`). Absent, none does. */
  held?: (session: string) => Promise<boolean>;
  /** The instances of the alert's rule in Grafana's rule list (`readSetStates`), read at each send, so a fire that waited says it resolved. */
  setStates?: (alert: FiringAlert) => Promise<ReadonlyMap<string, SetState>>;
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
 * Polls and dispatches apart: `poll` reads Grafana, advances the state, reopens, watches the sessions that took a fire for their next turn,
 * tells and escalates, and `dispatch` sends each chat's thread its owed fires. Every change to the state goes through `update`, so the two
 * never write over each other.
 */
export class AlertBridge {
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private firing: ReadonlyMap<string, FiringAlert> = new Map();
  private boarded: ReadonlySet<string> = new Set();
  /** The chats and sessions that wait for a pi-pool slot at the last poll; a chat here gets no fires until it can take them. */
  private parked: ReadonlySet<string> = new Set();
  /** The chats that `AlertBridgeDeps.held` read as waiting for a pi-pool slot at the last poll. */
  private held: ReadonlySet<string> = new Set();
  /** The live pi-host threads by id, with their names, from the last poll that read them. */
  private threads: ReadonlyMap<string, string> = new Map();
  /** The chats whose send runs now. */
  private readonly handing = new Set<string>();
  /** Each chat's last failed send, until one succeeds. */
  private readonly sendErrors = new Map<string, string>();
  constructor(private readonly deps: AlertBridgeDeps) { this.now = deps.now ?? Date.now; }

  /** One poll and then one dispatch, as one timer tick did before they ran apart. */
  async tick(): Promise<void> {
    if (await this.poll()) await this.dispatch();
  }

  /** Reads the firing list and does everything but the sends of fires; false when Grafana is not configured. */
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
      state = this.reopen(state, boarded, now);
      const watched = await this.watch(state, boarded, now);
      state = await this.tell(watched.state, boardless, now);
      return this.escalate(state, boarded, watched, now);
    });
    return true;
  }

  /**
   * Sends each chat's thread its owed fires (`owed`) in one message. A chat the pool holds, or whose last alert message still waits for its
   * turn, gets none now: its fires wait here and go together once it can take input (c219). A send that fails leaves the fires owed, so they
   * go again next dispatch, and the failure goes into the escalation at ESCALATE_MS.
   */
  async dispatch(): Promise<void> {
    const snapshot = await this.update(async state => state);
    const now = this.now();
    const pending = new Set(Object.values(snapshot.rules).filter(rule => rule.job?.id === rule.chat && waiting(snapshot, rule, now)).map(rule => rule.chat));
    const byChat = new Map<string, string[]>();
    for (const [key, rule] of Object.entries(snapshot.rules)) {
      if (owed(snapshot, rule) && this.boarded.has(rule.chat) && !this.handing.has(rule.chat) && !this.parked.has(rule.chat) && !pending.has(rule.chat)) {
        byChat.set(rule.chat, [...byChat.get(rule.chat) ?? [], key]);
      }
    }
    await Promise.all([...byChat].map(([chat, keys]) => this.handOff(snapshot, chat, keys)));
  }

  private async handOff(snapshot: BridgeState, chat: string, keys: readonly string[]): Promise<void> {
    this.handing.add(chat);
    try {
      const lines = await Promise.all(keys.map(async key => alertLine(snapshot.rules[key]!, this.firing, await this.setStates(snapshot.rules[key]!))));
      const name = await this.give(chat, lines);
      this.sendErrors.delete(chat);
      const at = this.now();
      await this.update(async state => {
        const rules = { ...state.rules };
        for (const key of keys) {
          const now = rules[key];
          const was = snapshot.rules[key]!;
          if (!now || now.job?.id !== was.job?.id || now.job?.at !== was.job?.at) continue;
          rules[key] = { ...now, job: { id: chat, name, at } };
        }
        const job: TriageJob = { ...state.jobs[chat], id: chat, name, chat, at: state.jobs[chat]?.at ?? at };
        return pruned({ ...state, rules, jobs: { ...state.jobs, [chat]: job }, chats: { ...state.chats, [chat]: chat } });
      });
    } catch (error) {
      this.sendErrors.set(chat, message(error));
      this.deps.log(`alerts: send to ${chat.slice(0, 8)} of ${keys.map(key => snapshot.rules[key]!.rule).join(", ")}: ${message(error)}; tried again next tick`);
    } finally { this.handing.delete(chat); }
  }

  /** Sends the chat's thread the fires of `lines` in one message, through pi-host for a pi-host thread, and answers the thread's name. */
  private async give(chat: string, lines: readonly AlertLine[]): Promise<string> {
    const call = await this.firingCall(chat);
    const text = threadAlertText(lines, call ? { at: this.now(), call } : undefined);
    const thread = this.threads.get(chat);
    if (thread !== undefined) await this.deps.threads!.send(chat, text, threadRequestId(lines));
    else await this.deps.deliver(chat, text, chat);
    const name = thread ?? chatName(chat);
    this.deps.log(`alerts: ${chat.slice(0, 8)}: sent ${lines.map(line => line.rule).join(", ")} to thread ${name}`);
    return name;
  }

  /**
   * Reads each session that has a fire with no turn since (`waiting`): its latest turn marks `ranAt`, so it holds every fire it took before
   * that. `parked` holds each session whose failed call names a pool slot still ahead or passed within one tick, and each boarded chat with
   * owed or waiting fires that waits for a pi-pool slot now (`AlertBridgeDeps.held`), so its fires neither go nor escalate until it can take
   * them. The escalation also spares the chats the last poll read as held, so a chat the pool just let go gets its fires before they escalate. The
   * errors, by session id, go with the escalation.
   */
  private async watch(state: BridgeState, boarded: ReadonlySet<string>, now: number): Promise<{ state: BridgeState; errors: Map<string, string>; parked: Set<string> }> {
    const errors = new Map<string, string>();
    const parked = new Set<string>();
    const since = new Map<string, number>();
    const asked = new Set<string>();
    for (const rule of Object.values(state.rules)) {
      if (waiting(state, rule, now) && state.jobs[rule.job!.id]) since.set(rule.job!.id, Math.min(since.get(rule.job!.id) ?? Infinity, rule.job!.at));
      if (boarded.has(rule.chat) && (owed(state, rule) || waiting(state, rule, now))) asked.add(rule.chat);
    }
    const jobs = { ...state.jobs };
    for (const [id, from] of since) {
      const job = jobs[id]!;
      const turn: TurnSince | null = this.threads.has(id) ? await this.deps.threads!.turn(id, from).catch(() => null)
        : this.deps.jobTurn ? await this.deps.jobTurn(job, from).catch(() => null) : { ran: true, at: now };
      if (!turn) continue;
      if (turn.ran) { jobs[id] = { ...job, ranAt: turn.at }; continue; }
      if (turn.error) errors.set(id, turn.error);
      if (turn.slotAt !== undefined && now < turn.slotAt + TICK_MS) parked.add(id);
    }
    const held = new Set<string>();
    for (const chat of asked) if (await (this.deps.held?.(chat) ?? Promise.resolve(false)).catch(() => false)) held.add(chat);
    const before = this.held;
    this.held = held;
    this.parked = new Set([...parked, ...held]);
    return { state: { ...state, jobs }, errors, parked: new Set([...this.parked, ...before]) };
  }

  /** Marks each rule that `dueReopens` names as fired now, so `dispatch` sends it to its chat's thread again. */
  private reopen(state: BridgeState, boarded: ReadonlySet<string>, now: number): BridgeState {
    const due = dueReopens(state, now).filter(key => boarded.has(state.rules[key]!.chat));
    if (!due.length) return state;
    const rules = { ...state.rules };
    for (const key of due) {
      const job = rules[key]!.job!;
      rules[key] = { ...rules[key]!, wokeAt: now };
      this.deps.log(now - job.at >= REOPEN_MS ? `alerts: ${rules[key]!.rule} still fires ${REOPEN_MS / 3_600_000} h after ${job.name} took it`
        : `alerts: ${rules[key]!.rule} has label sets ${job.name} never read`);
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

  private async escalate(state: BridgeState, boarded: ReadonlySet<string>, { errors, parked }: { errors: ReadonlyMap<string, string>; parked: ReadonlySet<string> }, now: number): Promise<BridgeState> {
    const due = dueEscalations(state, boarded, now, parked);
    if (!due.length) return state;
    try {
      await this.deps.deliver(OPS_ROUTE.session, escalationText(due.map(key => {
        const rule = state.rules[key]!;
        const job = rule.job && !owed(state, rule) ? rule.job : undefined;
        const error = job && errors.get(job.id);
        const sendError = job ? undefined : this.sendErrors.get(rule.chat);
        return { ...alertLine(rule, this.firing), chat: this.threads.get(rule.chat) ?? chatName(rule.chat),
          ...job ? { job: job.id === rule.chat ? "its thread" : `its triage job ${job.name}` } : {}, ...error ? { error } : {}, ...sendError ? { sendError } : {} };
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

  /** What Grafana's rule list says of the rule's instances now; a failed read gives none, so the hand-off still goes out. */
  private async setStates(rule: Tracked): Promise<ReadonlyMap<string, SetState> | undefined> {
    const alert = Object.keys(rule.instances).map(id => this.firing.get(id)).find(alert => alert !== undefined);
    if (!alert || !this.deps.setStates) return undefined;
    try { return await this.deps.setStates(alert); }
    catch (error) {
      this.deps.log(`alerts: rule list of ${rule.rule}: ${message(error)}; sent without its state`);
      return undefined;
    }
  }

  /** How the chat's duty writes a firing's fault call; a failed read gives none, so the hand-off still goes out. */
  private async firingCall(chat: string): Promise<FiringCall | null> {
    try { return (await this.deps.firingCall?.(chat)) ?? null; }
    catch (error) {
      this.deps.log(`alerts: firing call of ${chat.slice(0, 8)}: ${message(error)}`);
      return null;
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

/**
 * What Grafana's rule list says of one rule: whether it has not evaluated since Grafana started, how many of its instances alert now and how
 * many wait out their `for` (Pending), and when it last evaluated (0 when it has not).
 */
export interface RuleState { unevaluated: boolean; alerting: number; pending: number; evaluatedAt: number }

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
  return new Map(rules.flatMap(rule => {
    if (!isRecord(rule) || typeof rule.uid !== "string" || rule.isPaused === true) return [];
    const at = Date.parse(typeof rule.lastEvaluation === "string" ? rule.lastEvaluation : "");
    return [[rule.uid, { unevaluated: !(at > 0), alerting: count(rule.totals, "alerting") + count(rule.totals, "recovering"),
      pending: count(rule.totals, "pending"), evaluatedAt: at > 0 ? at : 0 }] as const];
  }));
}

/**
 * A label set as Grafana's alert list and its rule list both write it: every label but Grafana's own `__` ones and the empty ones, sorted by
 * name. On 11-05 the rule list wrote `project=` on vendor-bill-over-pace's sets, and the alert list left the empty label out.
 */
export const setKey = (labels: Record<string, string>): string =>
  Object.entries(labels).filter(([name, value]) => !name.startsWith("__") && value !== "").sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join(", ");

/**
 * One instance of a rule in Grafana's rule list: its state, such as "Alerting", "Recovering", "Pending" or "Normal (NoData)", and since when
 * it holds that state (`activeAt`). On 11-10 viewer-wall-walls-spike's instance read Normal with activeAt 05:34:30Z, the time its state
 * history put it back to Normal, and crawler-prod-pg-xmin-horizon's read Recovering with activeAt 05:47:40Z, the time it went Recovering.
 */
export interface SetState { state: string; since: number }

/** The instances of rule `uid` in a Grafana rule list, by label set (`setKey`). */
export function parseSetStates(value: unknown, uid: string): Map<string, SetState> {
  const groups = isRecord(value) && isRecord(value.data) && Array.isArray(value.data.groups) ? value.data.groups : null;
  if (!groups) throw new Error("Grafana's rule list has no groups");
  const rules = groups.flatMap(group => isRecord(group) && Array.isArray(group.rules) ? group.rules : []).filter(rule => isRecord(rule) && rule.uid === uid);
  const alerts = rules.flatMap(rule => isRecord(rule) && Array.isArray(rule.alerts) ? rule.alerts : []);
  return new Map(alerts.flatMap(alert => isRecord(alert) && typeof alert.state === "string" && isRecord(alert.labels) ?
    [[setKey(strings(alert.labels)), { state: alert.state, since: typeof alert.activeAt === "string" ? Date.parse(alert.activeAt) : NaN }] as const] : []));
}

const pendingSets = (states: ReadonlyMap<string, SetState>): Set<string> => new Set([...states].flatMap(([key, { state }]) => state.startsWith("Pending") ? [key] : []));

/** The label sets (`setKey`) of the instances of rule `uid` that a Grafana rule list holds Pending. */
export const parsePendingSets = (value: unknown, uid: string): Set<string> => pendingSets(parseSetStates(value, uid));

/** The instances of `alert`'s rule, read by its title: 11 KB for crawler-prod-kafka-writer-lag against 3.9 MB for every rule with its instances on 11-05. */
export async function readSetStates(configFile: string, alert: FiringAlert): Promise<Map<string, SetState>> {
  return parseSetStates(await readGrafana(configFile, `/api/prometheus/grafana/api/v1/rules?rule_name=${encodeURIComponent(alert.alertname)}`), ruleOf(alert));
}

/** The Pending label sets of `alert`'s rule. */
export async function readPendingSets(configFile: string, alert: FiringAlert): Promise<Set<string>> {
  return pendingSets(await readSetStates(configFile, alert));
}

/**
 * How to tell a Grafana state reset from a resolve: `since` is when the bridge read the last list, and `pending` reads the Pending label sets
 * of an alert's rule. A provisioning reload that changes a rule resets every instance of it to "Normal (Updated)" with no evaluation, and the
 * next evaluation puts a set that still breaches into Pending, where it waits out the rule's `for` before it fires with a new startsAt.
 */
export interface ResetCheck { since: number; pending: (alert: FiringAlert) => Promise<ReadonlySet<string>> }

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
 * With `reset`, a missing alert also stays while its rule has not evaluated since the last list, since only a reset or a restart drops a
 * firing alert with no evaluation, and while Grafana holds its label set Pending, since a firing set goes Pending only after a reset. On
 * 11-03 at 22:44:20Z the obs deploy of 63a4f6d6f2 changed crawler-prod-kafka-writer-lag, Grafana reset its 3 firing sets to "Normal
 * (Updated)", two went Pending at 22:44:30Z and fired again at 23:44:30Z at the same values, and the bridge paged the Crawler VP's triage job
 * at 23:45Z for a fault it already held, as it had on 11-02 at 17:53Z after the 16:49Z deploy of 195e3b808c. A missing alert whose fingerprint
 * the list holds with a new startsAt has ended, so it never stays beside the instance that replaced it.
 */
export async function holdStillFiring(previous: readonly FiringAlert[] | null, current: FiringAlert[], states: () => Promise<ReadonlyMap<string, RuleState>>, reset?: ResetCheck): Promise<FiringAlert[]> {
  const listed = new Set(current.map(alertKey));
  const relisted = new Set(current.map(alert => alert.fingerprint));
  const gone = (previous ?? []).filter(alert => !listed.has(alertKey(alert)) && !relisted.has(alert.fingerprint));
  if (!gone.length) return current;
  const rules = await states();
  const shown = new Map<string, number>();
  for (const alert of current) shown.set(ruleOf(alert), (shown.get(ruleOf(alert)) ?? 0) + 1);
  const pending = new Map<string, Promise<ReadonlySet<string>>>();
  const pendingOf = (alert: FiringAlert): Promise<ReadonlySet<string>> => {
    if (!pending.has(ruleOf(alert))) pending.set(ruleOf(alert), reset!.pending(alert));
    return pending.get(ruleOf(alert))!;
  };
  const fires = async (alert: FiringAlert): Promise<boolean> => {
    const rule = rules.get(ruleOf(alert));
    if (rule === undefined) return false;
    if (rule.unevaluated || rule.alerting > (shown.get(ruleOf(alert)) ?? 0)) return true;
    if (!reset) return false;
    if (rule.evaluatedAt < reset.since) return true;
    return rule.pending > 0 && (await pendingOf(alert)).has(setKey(alert.labels));
  };
  const held = await Promise.all(gone.map(fires));
  return [...current, ...gone.filter((_, index) => held[index])];
}

export async function readOwnersFor(configFile: string, home: string): Promise<OwnerMap | null> {
  const text = await readFile(configFile, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  const config = text === null ? {} : JSON.parse(text) as unknown;
  const repo = isRecord(config) && typeof config.ownersRepo === "string" ? config.ownersRepo : join(home, "Documents/Github/auto-sns-agent");
  const refs = isRecord(config) && Array.isArray(config.ownersRefs) ? config.ownersRefs.filter((ref): ref is string => typeof ref === "string") : [];
  return readOwners(repo, ["origin/main", ...refs]);
}

/**
 * Starts the bridge: a poll each `everyMs`, and after each poll a dispatch, which skips each chat whose send still runs, so a slow send never
 * skips a poll or holds up another chat.
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
