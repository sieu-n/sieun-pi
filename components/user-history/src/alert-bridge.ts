import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ALERT_ROUTES, OPS_ROUTE, routeAlert } from "./alert-routes.ts";
import type { BoardStore } from "./chat-board-store.ts";
import { missing } from "./locked-json.ts";
import { BOARD_LIMITS, findItem, nextIds, openGoals, titleDetail, walkItems } from "./shared/chat-board.ts";
import type { BoardOp, ChatBoard, PlanItem } from "./shared/types.ts";
import { TICK_MS } from "./wakes.ts";

export const ESCALATE_MS = 30 * 60_000;
/**
 * How long a step the chat closed may sit closed while its rule still fires before reconcile reopens it. ops guy set 24 h on 10-18, after prod
 * backup alerts fired from 10-16 for over 3 days with no open step anywhere.
 */
export const REOPEN_MS = 24 * 3_600_000;
export const OWNERS_PATH = "ops/alert-relay/owners.json";
export const ALERT_GOAL = "Firing prod alerts";
export const GRAFANA_ALERTS_PATH = "/api/alertmanager/grafana/api/v2/alerts?active=true";
const RESOLVED = "The alert resolved at";

export interface FiringAlert { fingerprint: string; startsAt: string; alertname: string; labels: Record<string, string>; summary: string; url: string; values?: string }
/** One firing label set of a rule, keyed in `Tracked.instances` by alertKey (fingerprint@startsAt). */
export interface Instance { startsAt: string; labels: Record<string, string>; resolvedAt?: number }
/**
 * One alert rule firing in one owning chat, and its board step. `rule` is the rule uid, or the alertname when the uid label is missing. The
 * group resolves when every instance has resolved. `wokeAt` and `firstWokeAt` both hold the time the step was placed.
 */
export interface Tracked { chat: string; step: string | null; rule: string; alertname: string; startsAt: string; wokeAt: number; firstWokeAt: number; escalatedAt?: number;
  resolvedAt?: number; instances: Record<string, Instance>;
  /** When reconcile first saw the rule's step closed (done or dropped) while the rule still fired. */
  closedAt?: number }
export interface BridgeState { v: 2; rules: Record<string, Tracked> }
export interface StepView { text: string; open: boolean; owned: boolean }
export interface OwnerRoute { name: string; match: Record<string, string>; owner: string }
export interface OwnerMap { owners: Record<string, string>; fallback: string; routes: OwnerRoute[] }
export type Router = (alert: FiringAlert) => string;
export interface Resolve { key: string; chat: string; step: string | null; at: string }
export interface StepLine { step: string; title: string; alertname: string; startsAt: string; sets?: number }
export interface Merge { step: string | null; into: string }
/**
 * One chat's part of a tick: its rules after the tick, the new rules that need a step, the rules whose note changes, and steps merged away.
 * Reconcile adds `found`, the fresh rules it placed because no open step held them, and `reopen`, the rules whose closed step it reopens.
 */
export interface ChatChange { chat: string; rules: Record<string, Tracked>; fresh: Map<string, FiringAlert>; touched: Set<string>; merged: Merge[];
  found?: Map<string, string>; reopen?: Set<string> }
/** What reconcile sees of an open rule's step: the owning chat has no board, the step is gone or never placed, or the step is open or closed. */
export type StepLook = "no board" | "missing" | "open" | "closed";

export const emptyState = (): BridgeState => ({ v: 2, rules: {} });
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

export function parseState(value: unknown): BridgeState {
  if (isRecord(value) && value.v === 2 && isRecord(value.rules)) return value as unknown as BridgeState;
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.alerts)) throw new Error("Alert bridge state file is malformed.");
  const alerts = value.alerts as Record<string, { chat: string; step: string | null; alertname: string; startsAt: string; wokeAt: number; firstWokeAt?: number;
    escalatedAt?: number; resolvedAt?: number }>;
  return { v: 2, rules: Object.fromEntries(Object.entries(alerts).map(([key, old]) => {
    const { firstWokeAt, resolvedAt, ...rest } = old;
    const instance: Instance = { startsAt: old.startsAt, labels: {}, ...(resolvedAt === undefined ? {} : { resolvedAt }) };
    return [key, { ...rest, rule: old.alertname, firstWokeAt: firstWokeAt ?? old.wokeAt, ...(resolvedAt === undefined ? {} : { resolvedAt }), instances: { [key]: instance } }];
  })) };
}

const isResolved = (rule: Tracked): boolean => rule.resolvedAt !== undefined;

/**
 * The state after this tick's firing list, as one change per chat whose rules moved. Each alert rule firing in an owning chat is one rule entry
 * and one step, and every label set of it (lane, env and so on) is an instance of that entry. On 10-18 one proxy rule firing in 6 lanes had
 * opened 6 steps on crawler ops' board, one per Grafana fingerprint, and the escalation counted 13 steps for 7 problems.
 *
 * 1. A firing whose instance key is already on a rule goes back to it, so a resolved rule whose same firing returns reopens on its old step.
 *    At 06:20:35Z on 10-15 one poll dropped 25 alerts at once and they came back with the same startsAt. Rules read from a version 1 state file
 *    learn their rule uid here.
 * 2. Any other firing joins the open rule of its chat and rule, or opens a new one, which replaces the chat's resolved entry of that rule.
 * 3. An instance missing from the list resolves, and the rule resolves once every instance has.
 * 4. Two open entries of one chat and rule, which only version 1 state leaves, merge into the one placed first.
 */
export function advance(alerts: readonly FiringAlert[], state: BridgeState, route: Router, now: number): { state: BridgeState; changes: ChatChange[] } {
  const rules: Record<string, Tracked> = structuredClone(state.rules);
  const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
  const fresh = new Map<string, FiringAlert>();
  const touched = new Set<string>();
  const merged = new Map<string, Merge[]>();
  const owner = new Map<string, string>();
  for (const [key, rule] of Object.entries(rules)) for (const instance of Object.keys(rule.instances)) owner.set(instance, key);
  const add = (key: string, alert: FiringAlert) => {
    const rule = rules[key]!;
    for (const [id, instance] of Object.entries(rule.instances)) if (instance.resolvedAt !== undefined && id.startsWith(`${alert.fingerprint}@`)) delete rule.instances[id];
    rule.instances[alertKey(alert)] = { startsAt: alert.startsAt, labels: alert.labels };
  };
  const rest: FiringAlert[] = [];
  for (const [id, alert] of firing) {
    const key = owner.get(id);
    if (!key) { rest.push(alert); continue; }
    const rule = rules[key]!;
    if (isResolved(rule) || rule.instances[id]!.resolvedAt !== undefined) touched.add(key);
    delete rule.resolvedAt;
    rule.rule = ruleOf(alert);
    rule.instances[id] = { startsAt: alert.startsAt, labels: alert.labels };
  }
  for (const alert of rest) {
    const chat = route(alert);
    const name = ruleOf(alert);
    let key = Object.keys(rules).find(key => rules[key]!.chat === chat && rules[key]!.rule === name && !isResolved(rules[key]!));
    if (!key) {
      for (const [old, rule] of Object.entries(rules)) if (rule.chat === chat && isResolved(rule) && (rule.rule === name || rule.rule === alert.alertname)) delete rules[old];
      key = ruleKey(chat, name);
      rules[key] = { chat, step: null, rule: name, alertname: alert.alertname, startsAt: alert.startsAt, wokeAt: now, firstWokeAt: now, instances: {} };
      fresh.set(key, alert);
    }
    if (fresh.has(key) && alert.startsAt < rules[key]!.startsAt) rules[key]!.startsAt = alert.startsAt;
    add(key, alert);
    touched.add(key);
  }
  for (const [key, rule] of Object.entries(rules)) {
    if (isResolved(rule)) continue;
    for (const [id, instance] of Object.entries(rule.instances)) {
      if (firing.has(id) || instance.resolvedAt !== undefined) continue;
      rule.instances[id] = { ...instance, resolvedAt: now };
      touched.add(key);
    }
    if (Object.values(rule.instances).every(instance => instance.resolvedAt !== undefined)) rule.resolvedAt = now;
  }
  const open = new Map<string, string[]>();
  for (const [key, rule] of Object.entries(rules)) if (!isResolved(rule)) open.set(`${rule.chat}\n${rule.rule}`, [...open.get(`${rule.chat}\n${rule.rule}`) ?? [], key]);
  for (const keys of open.values()) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => rules[a]!.firstWokeAt - rules[b]!.firstWokeAt || a.localeCompare(b));
    const [first, ...others] = keys as [string, ...string[]];
    const keeper = rules[first]!;
    for (const key of others) {
      const rule = rules[key]!;
      Object.assign(keeper.instances, rule.instances);
      if (rule.startsAt < keeper.startsAt) keeper.startsAt = rule.startsAt;
      if (rule.escalatedAt !== undefined && (keeper.escalatedAt === undefined || rule.escalatedAt < keeper.escalatedAt)) keeper.escalatedAt = rule.escalatedAt;
      if (keeper.step !== null) merged.set(rule.chat, [...merged.get(rule.chat) ?? [], { step: rule.step, into: keeper.step }]);
      delete rules[key];
      fresh.delete(key);
      touched.delete(key);
    }
    touched.add(first);
  }
  return { state: { v: 2, rules }, changes: changesOf(state.rules, rules, { fresh, touched, merged }) };
}

/** One change per chat whose rules moved between `before` and `after`, each with its part of the tick's marks. */
function changesOf(before: Record<string, Tracked>, after: Record<string, Tracked>, marks: { fresh: Map<string, FiringAlert>; touched: Set<string>;
  merged?: Map<string, Merge[]>; found?: Map<string, string>; reopen?: Set<string> }): ChatChange[] {
  const chats = new Set([...Object.values(before), ...Object.values(after)].map(rule => rule.chat));
  return [...chats].flatMap((chat): ChatChange[] => {
    const was = Object.fromEntries(Object.entries(before).filter(([, rule]) => rule.chat === chat));
    const now = Object.fromEntries(Object.entries(after).filter(([, rule]) => rule.chat === chat));
    if (JSON.stringify(was) === JSON.stringify(now) && !marks.merged?.has(chat)) return [];
    const mine = (key: string) => key in now;
    return [{ chat, rules: now, fresh: new Map([...marks.fresh].filter(([key]) => mine(key))), touched: new Set([...marks.touched].filter(mine)),
      merged: marks.merged?.get(chat) ?? [], found: new Map([...marks.found ?? []].filter(([key]) => mine(key))), reopen: new Set([...marks.reopen ?? []].filter(mine)) }];
  });
}

/**
 * The state after checking every open rule against its step, and one change per chat that needs board ops. advance only places a step when a
 * rule first fires, so a rule whose step was never placed stayed silent: from 10-16 05:10Z (64726c5a0) a boardless owner's firing was only
 * recorded, and prod Postgres, ClickHouse and Redis backup alerts routed to metal box owner, a root session with no board, fired for over 3 days
 * with no step anywhere.
 *
 * 1. A rule whose owner has no board moves to ops guy's board, the fallback owner in owners.json.
 * 2. A rule whose step was never placed or is gone from the board gets a step, noted as found by reconcile.
 * 3. A rule whose step is closed records when reconcile first saw it closed, and the step reopens once it has been closed REOPEN_MS and the rule
 *    still fires.
 * 4. A placed or reopened step's 30 min escalation clock starts again from now.
 */
export function reconcile(alerts: readonly FiringAlert[], state: BridgeState, look: (key: string, rule: Tracked) => StepLook, now: number,
  names: (session: string) => string = chatName, fallback = OPS_ROUTE.session): { state: BridgeState; changes: ChatChange[] } {
  const rules: Record<string, Tracked> = structuredClone(state.rules);
  const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
  const fresh = new Map<string, FiringAlert>();
  const touched = new Set<string>();
  const found = new Map<string, string>();
  const reopen = new Set<string>();
  const restart = (rule: Tracked): Tracked => {
    const { escalatedAt: _escalated, closedAt: _closed, ...rest } = rule;
    return { ...rest, wokeAt: now, firstWokeAt: now };
  };
  const firstFiring = (rule: Tracked): FiringAlert | undefined =>
    Object.keys(rule.instances).map(id => firing.get(id)).filter(alert => alert !== undefined).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  for (const [key, rule] of Object.entries(state.rules)) {
    if (isResolved(rule)) continue;
    const alert = firstFiring(rule);
    if (!alert) continue;
    const seen = look(key, rule);
    if (seen === "no board" && rule.chat !== fallback) {
      delete rules[key];
      const into = ruleKey(fallback, rule.rule);
      const there = rules[into];
      if (there && !isResolved(there)) {
        Object.assign(there.instances, rule.instances);
        if (rule.startsAt < there.startsAt) there.startsAt = rule.startsAt;
        touched.add(into);
        continue;
      }
      rules[into] = { ...restart(rule), chat: fallback, step: null };
      fresh.set(into, alert);
      found.set(into, `Its owner ${names(rule.chat)} (${rule.chat}) has no board, so the step is on this one.`);
    } else if (seen === "missing") {
      rules[key] = restart(rule);
      fresh.set(key, alert);
      found.set(key, "");
    } else if (seen === "closed") {
      if (rule.closedAt === undefined) rules[key] = { ...rule, closedAt: now };
      else if (now - rule.closedAt >= REOPEN_MS) {
        rules[key] = restart(rule);
        reopen.add(key);
      }
    } else if (seen === "open" && rule.closedAt !== undefined) {
      const { closedAt: _closed, ...rest } = rule;
      rules[key] = rest;
    }
  }
  return { state: { v: 2, rules }, changes: changesOf(state.rules, rules, { fresh, touched, found, reopen }) };
}

/** The state with `chat`'s rules replaced by `rules`, so a chat whose board write failed keeps its old entries for the next tick. */
export function withChat(state: BridgeState, chat: string, rules: Record<string, Tracked>): BridgeState {
  return { v: 2, rules: { ...Object.fromEntries(Object.entries(state.rules).filter(([, rule]) => rule.chat !== chat)), ...rules } };
}

/** Rules whose step is still open with no job ESCALATE_MS after the bridge placed it. One entry per rule, however many label sets fire. */
export function dueEscalations(state: BridgeState, steps: ReadonlyMap<string, StepView>, now: number): string[] {
  return Object.entries(state.rules).flatMap(([key, rule]) => {
    const step = steps.get(key);
    return !isResolved(rule) && step?.open && !step.owned && rule.escalatedAt === undefined && rule.chat !== OPS_ROUTE.session && now - rule.firstWokeAt >= ESCALATE_MS ? [key] : [];
  });
}

const mark = (rule: Pick<Tracked, "rule" | "startsAt">): string => `Grafana alert rule ${rule.rule}, firing since ${rule.startsAt}.`;
const MARK = /^Grafana alert (?:rule .+|[\w-]{1,64}), firing since \S+\.$/m;

/**
 * Whether the bridge still holds a step it added: the note keeps its mark and no resolve line, the step has no job, thread or wait, and it last
 * changed within ESCALATE_MS. The bridge escalates such a step to ops guy at ESCALATE_MS, so nobody else needs to act in that window. On 10-15 the Crawler VP set a job 4.8 min (p350, p351) and 7.8 min (p360) after the bridge added
 * the step, and two check-ins in between counted those steps stuck with no owner.
 */
export function bridgeHolds(item: Pick<PlanItem, "job" | "sessionId" | "note" | "waitFor" | "waitUntil">, changedAt: number, now: number): boolean {
  return !item.job && !item.sessionId && !item.waitFor && !item.waitUntil && MARK.test(item.note ?? "") && !item.note!.includes(RESOLVED) &&
    now - changedAt < ESCALATE_MS;
}

const ENVS: readonly [RegExp, string][] = [[/^prod/i, "Production"], [/^stag/i, "Staging"]];
const NAMES_ENV = /\b(prod|production|staging|stage|dev)\b/i;

/**
 * The step title is the Grafana rule title (the alertname label), with the env in front when the title does not name one. The summary holds
 * metric values and stream names, such as "crawl_profile:youtube group crawl_profile:youtube holds an entry 68053.971 s old", and crawler ops
 * renamed 28 such steps by hand on 10-15, so it goes in the note (c61).
 */
export function stepTitle(alert: FiringAlert): string {
  const env = alert.labels.env ?? alert.labels.environment ?? alert.labels.world ?? "";
  const prefix = ENVS.find(([pattern]) => pattern.test(env))?.[1];
  const titled = (text: string) => prefix && !NAMES_ENV.test(text) ? `${prefix} ${text}` : text;
  const rule = alert.labels.alertname ?? "";
  return [titled(rule), prefix ? `A ${prefix.toLowerCase()} Grafana alert is firing` : ""].find(text => text.trim() && text.length <= BOARD_LIMITS.text && !titleDetail(text)) ??
    "A Grafana alert is firing";
}

const SHARED = "Shared labels: ";
const SETS = "Label sets of this rule";
const minute = (iso: string): string => `${iso.slice(0, 16)}Z`;

/** The note block that lists the rule's label sets: the labels every set shares, then one line per set with the labels that differ. */
export function labelBlock(rule: Pick<Tracked, "instances">): string[] {
  const sets = Object.entries(rule.instances).sort(([, a], [, b]) => a.startsAt.localeCompare(b.startsAt));
  const names = [...new Set(sets.flatMap(([, set]) => Object.keys(set.labels)))].filter(name => name !== "alertname");
  const shared = names.filter(name => sets.every(([, set]) => set.labels[name] !== undefined && set.labels[name] === sets[0]![1].labels[name]));
  const firing = sets.filter(([, set]) => set.resolvedAt === undefined).length;
  const line = ([id, set]: [string, Instance]) => {
    const own = names.filter(name => !shared.includes(name) && set.labels[name] !== undefined).map(name => `${name}=${set.labels[name]}`);
    const resolved = set.resolvedAt === undefined ? "" : `, resolved ${minute(new Date(set.resolvedAt).toISOString())}`;
    return `- ${[...own, `since ${minute(set.startsAt)}${resolved}`].join(", ")} (${id.split("@")[0]})`;
  };
  return [`${SHARED}${shared.map(name => `${name}=${sets[0]![1].labels[name]}`).join(", ")}.`, `${SETS}, ${firing} of ${sets.length} firing:`, ...sets.map(line)];
}

const resolvedLine = (at: number): string => `${RESOLVED} ${new Date(at).toISOString()}, when the alert bridge saw every label set leave Grafana's firing list.`;

/**
 * `note` with the bridge's label block rewritten in place, or added at the end when the chat removed it, and the resolve line at the end while
 * the rule is resolved. Lines the chat wrote stay.
 */
export function ruleNote(note: string, rule: Pick<Tracked, "instances" | "resolvedAt">): string {
  const lines = note ? note.split("\n").filter(line => !line.startsWith(RESOLVED)) : [];
  let at = lines.findIndex(line => line.startsWith(SHARED) || line.startsWith(SETS));
  if (at < 0) at = lines.length;
  let end = at;
  while (end < lines.length && (lines[end]!.startsWith(SHARED) || lines[end]!.startsWith(SETS) || lines[end]!.startsWith("- "))) end++;
  const block = labelBlock(rule);
  const tail = rule.resolvedAt === undefined ? [] : [resolvedLine(rule.resolvedAt)];
  return [...lines.slice(0, at), ...block, ...lines.slice(end), ...tail].join("\n");
}

/** The note of a new step for `rule`, whose first firing is `alert`. */
export function stepNote(alert: FiringAlert, rule: Pick<Tracked, "rule" | "startsAt" | "instances" | "resolvedAt"> =
  { rule: ruleOf(alert), startsAt: alert.startsAt, instances: { [alertKey(alert)]: { startsAt: alert.startsAt, labels: alert.labels } } }): string {
  const head = [mark(rule), `Alert: ${alert.alertname}.`, alert.summary ? `Summary: ${alert.summary}` : "", alert.values ? `Values: ${alert.values}.` : "",
    alert.url ? `Grafana: ${alert.url}` : ""].filter(Boolean).join("\n");
  return ruleNote(head, rule);
}

const foundLine = (rule: Pick<Tracked, "startsAt">, stamp: string, extra: string): string =>
  `Firing since ${rule.startsAt}, found by reconcile at ${stamp} with no open step on this board.${extra ? ` ${extra}` : ""}`;
const withLine = (note: string, line: string): string => !line || note.includes(line) ? note : `${note}\n${line}`;

const ruleIn = (title: string, alertname: string): string => title.includes(alertname) ? "" : `${alertname}, `;

function markedStep(plan: readonly PlanItem[], rule: Pick<Tracked, "rule" | "startsAt">): PlanItem | undefined {
  let hit: PlanItem | undefined;
  walkItems(plan, item => { if (!hit && item.note?.split("\n").includes(mark(rule))) hit = item; });
  return hit;
}

function alertGoal(plan: readonly PlanItem[], ops: BoardOp[], ids: (kind: "p") => string): string {
  const open = openGoals(plan);
  const room = open.length < BOARD_LIMITS.openGoals;
  const named = plan.find(goal => goal.text === ALERT_GOAL && (open.includes(goal) || (goal.status === "done" && room)));
  const chosen = named ?? open.find(goal => /^[\w -]{0,40}\bops:|\bprod alerts\b/i.test(goal.text));
  if (chosen) return chosen.id;
  if (!room) return open.at(-1)!.id;
  const id = ids("p");
  ops.push({ op: "plan_add", text: ALERT_GOAL });
  return id;
}

/**
 * The board ops for one chat's change: a step for each new rule (or the step a crash left with its mark), the label block and resolve line
 * rewritten on each rule whose sets moved, and a pointer on each step merged into another. Returns each rule's step id.
 */
export function changeOps(board: ChatBoard, change: ChatChange, now = Date.now()): { ops: BoardOp[]; steps: Map<string, string> } {
  const ids = nextIds(board);
  const ops: BoardOp[] = [];
  const steps = new Map<string, string>();
  const notes = new Map<string, string>();
  const noteOf = (id: string) => notes.get(id) ?? findItem(board.plan, id)?.item.note ?? "";
  let goal: string | undefined;
  const stamp = new Date(now).toISOString();
  for (const [key, alert] of change.fresh) {
    const rule = change.rules[key]!;
    const extra = change.found?.get(key);
    const line = extra === undefined ? "" : foundLine(rule, stamp, extra);
    const marked = markedStep(board.plan, rule);
    if (marked) {
      steps.set(key, marked.id);
      notes.set(marked.id, withLine(ruleNote(noteOf(marked.id), rule), line));
      if (line && !OPEN.has(marked.status)) ops.push({ op: "plan_update", id: marked.id, status: "todo" });
      continue;
    }
    goal ??= alertGoal(board.plan, ops, ids);
    const id = ids("p");
    ops.push({ op: "plan_add", parent: goal, text: stepTitle(alert) }, { op: "plan_update", id, note: withLine(stepNote(alert, rule), line) });
    steps.set(key, id);
  }
  for (const key of change.reopen ?? []) {
    const rule = change.rules[key]!;
    const step = rule.step === null ? undefined : findItem(board.plan, rule.step)?.item;
    if (!step) continue;
    ops.push({ op: "plan_update", id: step.id, status: "todo" });
    notes.set(step.id, withLine(noteOf(step.id), `Reopened by reconcile at ${stamp}: this step was closed for over ${REOPEN_MS / 3_600_000} h and the rule still fires, firing since ${rule.startsAt}.`));
  }
  for (const key of change.touched) {
    const step = change.rules[key]!.step;
    if (change.fresh.has(key) || step === null || !findItem(board.plan, step)) continue;
    notes.set(step, ruleNote(noteOf(step), change.rules[key]!));
  }
  for (const { step, into } of change.merged) {
    if (step === null || !findItem(board.plan, step)) continue;
    const line = `The alert bridge moved this rule's label sets to ${into}, which now lists every set.`;
    const note = noteOf(step);
    if (!note.includes(line)) notes.set(step, note ? `${note}\n${line}` : line);
  }
  for (const [id, note] of notes) if (note !== (findItem(board.plan, id)?.item.note ?? "")) ops.push({ op: "plan_update", id, note });
  return { ops, steps };
}

export function escalationText(steps: readonly (StepLine & { chat: string })[]): string {
  const sets = (step: StepLine) => step.sets && step.sets > 1 ? `, ${step.sets} label sets` : "";
  const line = (step: StepLine & { chat: string }) => `${step.step} "${step.title}" on ${step.chat} (${ruleIn(step.title, step.alertname)}firing since ${step.startsAt.slice(0, 16)}Z${sets(step)})`;
  return `[alert-escalation] ${steps.length === 1 ? "An alert step is" : `${steps.length} alert steps are`} still open with no job ${ESCALATE_MS / 60_000} min after the alert bridge ` +
    `put ${steps.length === 1 ? "it" : "them"} on the owning chat's board: ${steps.map(line).join("; ")}. Check why the chat has not acted, and start a job or get that chat to.`;
}

const chatName = (session: string): string => ALERT_ROUTES.find(route => route.session === session)?.chat ?? session;

const OPEN = new Set(["todo", "doing", "blocked"]);

export interface AlertBridgeDeps {
  file: string;
  alerts: () => Promise<FiringAlert[] | null>;
  boards: Pick<BoardStore, "read" | "apply">;
  deliver: (session: string, text: string) => Promise<"sent" | "gone">;
  startRoot?: (root: string) => Promise<void>;
  owners?: () => Promise<OwnerMap | null>;
  hasBoard?: (session: string) => Promise<boolean>;
  now?: () => number;
  log: (line: string) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const firingSets = (rule: Tracked): number => Object.values(rule.instances).filter(instance => instance.resolvedAt === undefined).length;

export class AlertBridge {
  private readonly now: () => number;
  constructor(private readonly deps: AlertBridgeDeps) { this.now = deps.now ?? Date.now; }

  async tick(): Promise<void> {
    const alerts = await this.deps.alerts();
    if (!alerts) return;
    const map = await this.ownerMap();
    const route = routerFor(map);
    const names = new Map(Object.entries(map?.owners ?? {}).map(([name, session]) => [session, name]));
    const now = this.now();
    const before = await this.read();
    let state = await this.apply(before, advance(alerts, before, route, now).changes, now);
    const checked = reconcile(alerts, state, await this.looks(state), now, session => names.get(session) ?? chatName(session));
    const found = checked.changes.flatMap(change => [...change.found ?? []].map(([key]) => `${key} (${change.rules[key]!.alertname}, firing since ${change.rules[key]!.startsAt})`));
    const reopened = checked.changes.flatMap(change => [...change.reopen ?? []]);
    if (found.length || reopened.length) this.deps.log(`alerts: reconcile found ${found.length} firing rules with no open step: ${found.join("; ") || "none"}; reopened ${reopened.join(", ") || "none"}`);
    state = await this.apply(state, checked.changes, now);
    const steps = await this.steps(state);
    const escalate = dueEscalations(state, steps, now);
    if (!escalate.length) return;
    try {
      const lines = escalate.map(key => {
        const rule = state.rules[key]!;
        return { chat: chatName(rule.chat), step: rule.step ?? "", title: steps.get(key)?.text ?? rule.alertname, alertname: rule.alertname, startsAt: rule.startsAt, sets: firingSets(rule) };
      });
      await this.send(OPS_ROUTE.session, escalationText(lines));
      const rules = { ...state.rules };
      for (const key of escalate) rules[key] = { ...rules[key]!, escalatedAt: now };
      state = { ...state, rules };
      await this.write(state);
      this.deps.log(`alerts: escalated ${escalate.length} unowned rule steps to ops guy`);
    } catch (error) { this.deps.log(`alerts: escalation: ${message(error)}; tried again next tick`); }
  }

  /** Places each chat's change and writes the state after each one, so a chat whose board write fails keeps its old entries for the next tick. */
  private async apply(state: BridgeState, changes: readonly ChatChange[], now: number): Promise<BridgeState> {
    for (const change of changes) {
      try {
        state = withChat(state, change.chat, await this.place(change, now));
        await this.write(state);
      } catch (error) {
        state = await this.read().catch(() => state);
        this.deps.log(`alerts: steps for ${change.chat.slice(0, 8)}: ${message(error)}; tried again next tick`);
      }
    }
    return state;
  }

  /** What reconcile sees of each open rule's step on its chat's board. */
  private async looks(state: BridgeState): Promise<(key: string, rule: Tracked) => StepLook> {
    const boarded = new Map<string, boolean>();
    const boards = new Map<string, ChatBoard | null>();
    for (const rule of Object.values(state.rules)) {
      if (isResolved(rule) || boarded.has(rule.chat)) continue;
      boarded.set(rule.chat, await this.deps.hasBoard?.(rule.chat) ?? true);
      if (boarded.get(rule.chat)) boards.set(rule.chat, await this.deps.boards.read(rule.chat));
    }
    return (_key, rule) => {
      if (!boarded.get(rule.chat)) return "no board";
      const item = rule.step === null ? undefined : findItem(boards.get(rule.chat)?.plan ?? [], rule.step)?.item;
      return !item ? "missing" : OPEN.has(item.status) ? "open" : "closed";
    };
  }

  /** Writes one chat's change on its board and returns the chat's rules with their step ids. A chat with no board gets nothing here; reconcile moves its rules to ops guy's board. */
  private async place(change: ChatChange, now: number): Promise<Record<string, Tracked>> {
    const rules = change.rules;
    if (!(await this.deps.hasBoard?.(change.chat) ?? true)) {
      if (change.fresh.size) this.deps.log(`alerts: ${change.chat.slice(0, 8)} has no board, so reconcile moves ${change.fresh.size} new firing rules to ops guy's board`);
      return rules;
    }
    if (!change.fresh.size && !change.touched.size && !change.merged.length && !change.reopen?.size) return rules;
    let steps = new Map<string, string>();
    let count = 0;
    await this.deps.boards.apply(change.chat, board => {
      const plan = changeOps(board, change, now);
      steps = plan.steps;
      count = plan.ops.length;
      return plan.ops;
    }, "agent");
    for (const [key, step] of steps) rules[key] = { ...rules[key]!, step };
    if (count) {
      const sets = (rule: Tracked) => `${rule.step ?? "no step"} (${rule.rule}, ${firingSets(rule)} of ${Object.keys(rule.instances).length} sets firing${rule.resolvedAt === undefined ? "" : ", resolved"})`;
      const moved = [...change.touched].map(key => sets(rules[key]!));
      this.deps.log(`alerts: ${change.chat.slice(0, 8)}: ${steps.size} new rule steps, ${change.merged.length} merged; ${moved.join("; ")}`);
    }
    return rules;
  }

  private async ownerMap(): Promise<OwnerMap | null> {
    try { return (await this.deps.owners?.()) ?? null; }
    catch (error) {
      this.deps.log(`alerts: owners.json: ${message(error)}; routed by keywords`);
      return null;
    }
  }

  private async send(session: string, text: string): Promise<"sent" | "gone"> {
    let result = await this.deps.deliver(session, text);
    if (result === "gone" && this.deps.startRoot) {
      await this.deps.startRoot(session);
      result = await this.deps.deliver(session, text);
    }
    return result;
  }

  private async steps(state: BridgeState): Promise<Map<string, StepView>> {
    const boards = new Map<string, ChatBoard | null>();
    const views = new Map<string, StepView>();
    for (const [key, rule] of Object.entries(state.rules)) {
      if (rule.step === null || rule.resolvedAt !== undefined) continue;
      if (!boards.has(rule.chat)) boards.set(rule.chat, await this.deps.boards.read(rule.chat));
      const item = findItem(boards.get(rule.chat)?.plan ?? [], rule.step)?.item;
      if (item) views.set(key, { text: item.text, open: OPEN.has(item.status), owned: Boolean(item.job || item.sessionId) });
    }
    return views;
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
