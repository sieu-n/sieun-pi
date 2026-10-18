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
export const OWNERS_PATH = "ops/alert-relay/owners.json";
export const ALERT_GOAL = "Firing prod alerts";
export const GRAFANA_ALERTS_PATH = "/api/alertmanager/grafana/api/v2/alerts";
const RESOLVED = "The alert resolved at";

export interface FiringAlert { fingerprint: string; startsAt: string; alertname: string; labels: Record<string, string>; summary: string; url: string; values?: string }
/** One firing label set of a rule, keyed in `Tracked.instances` by alertKey (fingerprint@startsAt). */
export interface Instance { startsAt: string; labels: Record<string, string>; resolvedAt?: number }
/**
 * One alert rule firing in one owning chat, and its board step. `rule` is the rule uid, or the alertname when the uid label is missing. The
 * group resolves when every instance has resolved. `wokeAt` and `firstWokeAt` both hold the time the step was placed.
 */
export interface Tracked { chat: string; step: string | null; rule: string; alertname: string; startsAt: string; wokeAt: number; firstWokeAt: number; escalatedAt?: number;
  resolvedAt?: number; instances: Record<string, Instance> }
export interface BridgeState { v: 2; rules: Record<string, Tracked> }
export interface StepView { text: string; open: boolean; owned: boolean }
export interface OwnerRoute { name: string; match: Record<string, string>; owner: string }
export interface OwnerMap { owners: Record<string, string>; fallback: string; routes: OwnerRoute[] }
export type Router = (alert: FiringAlert) => string;
export interface Resolve { key: string; chat: string; step: string | null; at: string }
export interface StepLine { step: string; title: string; alertname: string; startsAt: string; sets?: number }
export interface Merge { step: string | null; into: string }
/** One chat's part of a tick: its rules after the tick, the new rules that need a step, the rules whose note changes, and steps merged away. */
export interface ChatChange { chat: string; rules: Record<string, Tracked>; fresh: Map<string, FiringAlert>; touched: Set<string>; merged: Merge[] }

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
  const chats = new Set([...Object.values(state.rules), ...Object.values(rules)].map(rule => rule.chat));
  const changes = [...chats].flatMap((chat): ChatChange[] => {
    const before = Object.fromEntries(Object.entries(state.rules).filter(([, rule]) => rule.chat === chat));
    const after = Object.fromEntries(Object.entries(rules).filter(([, rule]) => rule.chat === chat));
    if (JSON.stringify(before) === JSON.stringify(after) && !merged.has(chat)) return [];
    return [{ chat, rules: after, fresh: new Map([...fresh].filter(([key]) => key in after)), touched: new Set([...touched].filter(key => key in after)),
      merged: merged.get(chat) ?? [] }];
  });
  return { state: { v: 2, rules }, changes };
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
 * the rule is resolved. Lines the chat wrote stay. When the note runs over BOARD_LIMITS.note the block lists fewer sets.
 */
export function ruleNote(note: string, rule: Pick<Tracked, "instances" | "resolvedAt">): string {
  const lines = note ? note.split("\n").filter(line => !line.startsWith(RESOLVED)) : [];
  let at = lines.findIndex(line => line.startsWith(SHARED) || line.startsWith(SETS));
  if (at < 0) at = lines.length;
  let end = at;
  while (end < lines.length && (lines[end]!.startsWith(SHARED) || lines[end]!.startsWith(SETS) || lines[end]!.startsWith("- "))) end++;
  const block = labelBlock(rule);
  const tail = rule.resolvedAt === undefined ? [] : [resolvedLine(rule.resolvedAt)];
  const render = (sets: string[]) => [...lines.slice(0, at), ...sets, ...lines.slice(end), ...tail].join("\n");
  for (let keep = block.length - 2; keep > 0; keep--) {
    const shown = keep === block.length - 2 ? block : [...block.slice(0, 2 + keep), `- and ${block.length - 2 - keep} more label sets.`];
    if (render(shown).length <= BOARD_LIMITS.note) return render(shown);
  }
  return render(block.slice(0, 3)).slice(0, BOARD_LIMITS.note);
}

/** The note of a new step for `rule`, whose first firing is `alert`. */
export function stepNote(alert: FiringAlert, rule: Pick<Tracked, "rule" | "startsAt" | "instances" | "resolvedAt"> =
  { rule: ruleOf(alert), startsAt: alert.startsAt, instances: { [alertKey(alert)]: { startsAt: alert.startsAt, labels: alert.labels } } }): string {
  const head = [mark(rule), `Alert: ${alert.alertname}.`, alert.summary ? `Summary: ${alert.summary}` : "", alert.values ? `Values: ${alert.values}.` : "",
    alert.url ? `Grafana: ${alert.url}` : ""].filter(Boolean).join("\n");
  return ruleNote(head, rule);
}

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
export function changeOps(board: ChatBoard, change: ChatChange): { ops: BoardOp[]; steps: Map<string, string> } {
  const ids = nextIds(board);
  const ops: BoardOp[] = [];
  const steps = new Map<string, string>();
  const notes = new Map<string, string>();
  const noteOf = (id: string) => notes.get(id) ?? findItem(board.plan, id)?.item.note ?? "";
  let goal: string | undefined;
  for (const [key, alert] of change.fresh) {
    const rule = change.rules[key]!;
    const found = markedStep(board.plan, rule);
    if (found) {
      steps.set(key, found.id);
      notes.set(found.id, ruleNote(noteOf(found.id), rule));
      continue;
    }
    goal ??= alertGoal(board.plan, ops, ids);
    const id = ids("p");
    ops.push({ op: "plan_add", parent: goal, text: stepTitle(alert) }, { op: "plan_update", id, note: stepNote(alert, rule) });
    steps.set(key, id);
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
    if (!note.includes(line)) notes.set(step, note ? `${note.slice(0, BOARD_LIMITS.note - line.length - 1)}\n${line}` : line);
  }
  for (const [id, note] of notes) if (note !== (findItem(board.plan, id)?.item.note ?? "")) ops.push({ op: "plan_update", id, note });
  return { ops, steps };
}

export function resolveOps(board: ChatBoard, resolve: Resolve): BoardOp[] {
  if (resolve.step === null) return [];
  const item = findItem(board.plan, resolve.step)?.item;
  if (!item || item.note?.includes(RESOLVED)) return [];
  const line = `${RESOLVED} ${resolve.at}, when the alert bridge saw it leave Grafana's firing list.`;
  const note = item.note ? `${item.note.slice(0, BOARD_LIMITS.note - line.length - 1)}\n${line}` : line;
  return [{ op: "plan_update", id: resolve.step, note }];
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
    const route = routerFor(await this.ownerMap());
    const now = this.now();
    let state = await this.read();
    for (const change of advance(alerts, state, route, now).changes) {
      try {
        state = withChat(state, change.chat, await this.place(change));
        await this.write(state);
      } catch (error) {
        state = await this.read().catch(() => state);
        this.deps.log(`alerts: steps for ${change.chat.slice(0, 8)}: ${message(error)}; tried again next tick`);
      }
    }
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

  /** Writes one chat's change on its board and returns the chat's rules with their step ids. A chat with no board gets nothing; its rules are only recorded. */
  private async place(change: ChatChange): Promise<Record<string, Tracked>> {
    const rules = change.rules;
    if (!(await this.deps.hasBoard?.(change.chat) ?? true)) {
      if (change.fresh.size) this.deps.log(`alerts: ${change.chat.slice(0, 8)} has no board, so ${change.fresh.size} new firing rules are only recorded`);
      return rules;
    }
    let steps = new Map<string, string>();
    let count = 0;
    await this.deps.boards.apply(change.chat, board => {
      const plan = changeOps(board, change);
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
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void bridge.tick().catch(error => deps.log(`alerts: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
