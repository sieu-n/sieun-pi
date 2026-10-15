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

export const REWAKE_MS = 20 * 60_000;
export const ESCALATE_MS = 30 * 60_000;
export const OWNERS_PATH = "ops/alert-relay/owners.json";
export const ALERT_GOAL = "Firing prod alerts";
export const GRAFANA_ALERTS_PATH = "/api/alertmanager/grafana/api/v2/alerts";
const RESOLVED = "The alert resolved at";

export interface FiringAlert { fingerprint: string; startsAt: string; alertname: string; labels: Record<string, string>; summary: string; url: string }
export interface Tracked { chat: string; step: string | null; alertname: string; startsAt: string; wokeAt: number; firstWokeAt: number; escalatedAt?: number }
export interface BridgeState { v: 1; alerts: Record<string, Tracked> }
export interface StepView { text: string; open: boolean; owned: boolean }
export interface ChatNotice { chat: string; add: FiringAlert[]; rewake: string[] }
export interface OwnerRoute { name: string; match: Record<string, string>; owner: string }
export interface OwnerMap { owners: Record<string, string>; fallback: string; routes: OwnerRoute[] }
export type Router = (alert: FiringAlert) => string;
export interface Resolve { key: string; chat: string; step: string | null; at: string }
export interface StepLine { step: string; title: string; alertname: string; startsAt: string }

export const emptyState = (): BridgeState => ({ v: 1, alerts: {} });
export const alertKey = (alert: Pick<FiringAlert, "fingerprint" | "startsAt">): string => `${alert.fingerprint}@${alert.startsAt}`;
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
    return [{ fingerprint: item.fingerprint, startsAt: new Date(at).toISOString(), alertname: labels.alertname ?? labels.__alert_rule_uid__ ?? item.fingerprint, labels,
      summary: strings(item.annotations).summary ?? "", url: typeof item.generatorURL === "string" ? item.generatorURL : "" }];
  });
}

export function parseState(value: unknown): BridgeState {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.alerts)) throw new Error("Alert bridge state file is malformed.");
  const alerts = value.alerts as Record<string, Omit<Tracked, "firstWokeAt"> & { firstWokeAt?: number }>;
  return { v: 1, alerts: Object.fromEntries(Object.entries(alerts).map(([key, tracked]) => [key, { ...tracked, firstWokeAt: tracked.firstWokeAt ?? tracked.wokeAt }])) };
}

export function reconcile(alerts: readonly FiringAlert[], state: BridgeState, steps: ReadonlyMap<string, StepView>, now: number, route: Router = alertChat):
  { notices: ChatNotice[]; resolves: Resolve[]; escalate: string[] } {
  const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
  const notices = new Map<string, ChatNotice>();
  const notice = (chat: string): ChatNotice => {
    const known = notices.get(chat);
    if (known) return known;
    const fresh: ChatNotice = { chat, add: [], rewake: [] };
    notices.set(chat, fresh);
    return fresh;
  };
  for (const [key, alert] of firing) if (!state.alerts[key]) notice(route(alert)).add.push(alert);
  const waiting = new Map<string, { keys: string[]; due: boolean }>();
  const resolves: Resolve[] = [];
  const escalate: string[] = [];
  for (const [key, tracked] of Object.entries(state.alerts)) {
    if (!firing.has(key)) { resolves.push({ key, chat: tracked.chat, step: tracked.step, at: new Date(now).toISOString() }); continue; }
    const step = steps.get(key);
    if (!step?.open || step.owned) continue;
    if (tracked.escalatedAt === undefined && tracked.chat !== OPS_ROUTE.session && now - tracked.firstWokeAt >= ESCALATE_MS) escalate.push(key);
    const chat = waiting.get(tracked.chat) ?? { keys: [], due: false };
    chat.keys.push(key);
    chat.due ||= now - tracked.wokeAt >= REWAKE_MS;
    waiting.set(tracked.chat, chat);
  }
  for (const [chat, { keys, due }] of waiting) if (due) notice(chat).rewake.push(...keys);
  return { notices: [...notices.values()], resolves, escalate };
}

/**
 * The state after `notice` went out at `now`. `wokeAt` 0 records the placed steps before the send, so a send that fails or times out leaves the
 * alert tracked (no second step on the next tick) and its re-wake due at once. 10-15 12:41 to 13:46Z the daemon timed out send_message after
 * 30 s on most ticks; the state was written only after the send, and the Crawler VP had rewritten each step's note without the bridge's mark,
 * so every tick added a new step for each still-firing alert (p404 to p490, p500 to p502).
 */
export function noticed(state: BridgeState, notice: ChatNotice, placed: ReadonlyMap<string, string | null>, now: number, wokeAt = now): BridgeState {
  const alerts = { ...state.alerts };
  for (const alert of notice.add) {
    const step = placed.get(alertKey(alert));
    if (step !== undefined) alerts[alertKey(alert)] = { chat: notice.chat, step, alertname: alert.alertname, startsAt: alert.startsAt, wokeAt, firstWokeAt: now };
  }
  for (const key of notice.rewake) if (alerts[key]) alerts[key] = { ...alerts[key], wokeAt: now };
  return { ...state, alerts };
}

export function escalated(state: BridgeState, keys: readonly string[], now: number): BridgeState {
  const alerts = { ...state.alerts };
  for (const key of keys) if (alerts[key]) alerts[key] = { ...alerts[key], escalatedAt: now };
  return { ...state, alerts };
}

export function resolved(state: BridgeState, key: string): BridgeState {
  const { [key]: _gone, ...alerts } = state.alerts;
  return { ...state, alerts };
}

const mark = (alert: FiringAlert): string => `Grafana alert ${alert.fingerprint}, firing since ${alert.startsAt}.`;
const MARK = /^Grafana alert [\w-]{1,64}, firing since \S+\.$/m;

/**
 * Whether the bridge still holds a step it added: the note keeps its mark and no resolve line, the step has no job, thread or wait, and it last
 * changed within ESCALATE_MS. The bridge wakes the chat when it adds the step, wakes it again after REWAKE_MS and escalates it at ESCALATE_MS,
 * so nobody else needs to act in that window. On 10-15 the Crawler VP set a job 4.8 min (p350, p351) and 7.8 min (p360) after the bridge added
 * the step, and two check-ins in between counted those steps stuck with no owner.
 */
export function bridgeHolds(item: Pick<PlanItem, "job" | "sessionId" | "note" | "waitFor" | "waitUntil">, changedAt: number, now: number): boolean {
  return !item.job && !item.sessionId && !item.waitFor && !item.waitUntil && MARK.test(item.note ?? "") && !item.note!.includes(RESOLVED) &&
    now - changedAt < ESCALATE_MS;
}

export function stepTitle(alert: FiringAlert): string {
  const first = alert.summary.split(/(?<=\.)\s+/)[0]?.trim() ?? "";
  return [first, alert.alertname].find(text => text && text.length <= BOARD_LIMITS.text && !titleDetail(text)) ?? "A Grafana alert is firing";
}

export function stepNote(alert: FiringAlert): string {
  const labels = Object.entries(alert.labels).filter(([name]) => name !== "alertname").map(([name, value]) => `${name}=${value}`).join(", ");
  return [mark(alert), `Alert: ${alert.alertname}.`, alert.summary ? `Summary: ${alert.summary}` : "", `Labels: ${labels}.`, alert.url ? `Grafana: ${alert.url}` : ""]
    .filter(Boolean).join("\n").slice(0, BOARD_LIMITS.note);
}

function markedStep(plan: readonly PlanItem[], alert: FiringAlert): PlanItem | undefined {
  let hit: PlanItem | undefined;
  walkItems(plan, item => { if (!hit && item.note?.includes(mark(alert))) hit = item; });
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

export function placeSteps(board: ChatBoard, alerts: readonly FiringAlert[]): { ops: BoardOp[]; steps: Map<string, string> } {
  const ids = nextIds(board);
  const ops: BoardOp[] = [];
  const steps = new Map<string, string>();
  let goal: string | undefined;
  for (const alert of alerts) {
    const found = markedStep(board.plan, alert);
    if (found) { steps.set(alertKey(alert), found.id); continue; }
    goal ??= alertGoal(board.plan, ops, ids);
    const id = ids("p");
    ops.push({ op: "plan_add", parent: goal, text: stepTitle(alert) }, { op: "plan_update", id, note: stepNote(alert) });
    steps.set(alertKey(alert), id);
  }
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

export function alertText(added: readonly StepLine[], waiting: readonly StepLine[]): string {
  const line = (step: StepLine) => `${step.step} "${step.title}" (${step.alertname}, firing since ${step.startsAt.slice(0, 16)}Z)`;
  const parts: string[] = [];
  if (added.length) {
    parts.push(`${added.length === 1 ? "A Grafana alert" : `${added.length} Grafana alerts`} started firing, and the alert bridge put ${added.length === 1 ? "a step" : "one step each"} ` +
      `on your board: ${added.map(line).join("; ")}.`);
  }
  if (waiting.length) parts.push(`Still firing with no job on the step: ${waiting.map(line).join("; ")}.`);
  return `[alert] ${parts.join(" ")} Act on ${added.length + waiting.length === 1 ? "it" : "each one"} now: start a job and set it on the step, or close the step with a reason in its note. ` +
    "Each step's note has the labels and the Grafana link.";
}

export function boardlessText(alerts: readonly FiringAlert[]): string {
  const one = (alert: FiringAlert) => `"${stepTitle(alert)}" (${alert.alertname}, firing since ${alert.startsAt.slice(0, 16)}Z, labels ` +
    `${Object.entries(alert.labels).filter(([name]) => name !== "alertname").map(([name, value]) => `${name}=${value}`).join(", ")}${alert.url ? `, ${alert.url}` : ""})`;
  return `[alert] ${alerts.length === 1 ? "A Grafana alert you own" : `${alerts.length} Grafana alerts you own`} started firing: ${alerts.map(one).join("; ")}. ` +
    `Act on ${alerts.length === 1 ? "it" : "each one"} now: start a job, or say why it needs nothing.`;
}

export function escalationText(steps: readonly (StepLine & { chat: string })[]): string {
  const line = (step: StepLine & { chat: string }) => `${step.step} "${step.title}" on ${step.chat} (${step.alertname}, firing since ${step.startsAt.slice(0, 16)}Z)`;
  return `[alert-escalation] ${steps.length === 1 ? "An alert step is" : `${steps.length} alert steps are`} still open with no job ${ESCALATE_MS / 60_000} min after the alert bridge ` +
    `first woke the chat that owns ${steps.length === 1 ? "it" : "them"}: ${steps.map(line).join("; ")}. Check why the chat has not acted, and start a job or get that chat to.`;
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

export class AlertBridge {
  private readonly now: () => number;
  constructor(private readonly deps: AlertBridgeDeps) { this.now = deps.now ?? Date.now; }

  async tick(): Promise<void> {
    const alerts = await this.deps.alerts();
    if (!alerts) return;
    const route = routerFor(await this.ownerMap());
    let state = await this.read();
    const now = this.now();
    const steps = await this.steps(state);
    const { notices, resolves, escalate } = reconcile(alerts, state, steps, now, route);
    for (const notice of notices) {
      try {
        state = await this.notify(notice, state, steps, now);
        await this.write(state);
      } catch (error) {
        state = await this.read().catch(() => state);
        this.deps.log(`alerts: notice to ${notice.chat.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}; tried again next tick`);
      }
    }
    if (escalate.length) {
      try {
        const lines = escalate.map(key => {
          const tracked = state.alerts[key]!;
          return { chat: chatName(tracked.chat), step: tracked.step ?? "", title: steps.get(key)?.text ?? tracked.alertname, alertname: tracked.alertname, startsAt: tracked.startsAt };
        });
        await this.send(OPS_ROUTE.session, escalationText(lines));
        state = escalated(state, escalate, now);
        await this.write(state);
        this.deps.log(`alerts: escalated ${escalate.length} unowned steps to ops guy`);
      } catch (error) { this.deps.log(`alerts: escalation: ${error instanceof Error ? error.message : String(error)}; tried again next tick`); }
    }
    for (const resolve of resolves) {
      try {
        if (resolve.step !== null) await this.deps.boards.apply(resolve.chat, board => resolveOps(board, resolve), "agent");
        state = resolved(state, resolve.key);
        await this.write(state);
        this.deps.log(`alerts: ${resolve.key} resolved${resolve.step === null ? "" : `, noted on ${resolve.step}`} in ${resolve.chat.slice(0, 8)}`);
      } catch (error) { this.deps.log(`alerts: resolve ${resolve.key}: ${error instanceof Error ? error.message : String(error)}; tried again next tick`); }
    }
  }

  private async ownerMap(): Promise<OwnerMap | null> {
    try { return (await this.deps.owners?.()) ?? null; }
    catch (error) {
      this.deps.log(`alerts: owners.json: ${error instanceof Error ? error.message : String(error)}; routed by keywords`);
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

  private async notify(notice: ChatNotice, state: BridgeState, steps: ReadonlyMap<string, StepView>, now: number): Promise<BridgeState> {
    if (notice.add.length && !(await this.deps.hasBoard?.(notice.chat) ?? true)) {
      const result = await this.send(notice.chat, boardlessText(notice.add));
      this.deps.log(`alerts: ${result === "sent" ? "woke" : "could not reach"} ${notice.chat.slice(0, 8)} (no board) for ${notice.add.length} new alerts`);
      return noticed(state, notice, new Map(notice.add.map(alert => [alertKey(alert), null])), now);
    }
    let placed = new Map<string, string>();
    if (notice.add.length) {
      await this.deps.boards.apply(notice.chat, board => {
        const plan = placeSteps(board, notice.add);
        placed = plan.steps;
        return plan.ops;
      }, "agent");
      state = noticed(state, { ...notice, rewake: [] }, placed, now, 0);
      await this.write(state);
    }
    const added = notice.add.map(alert => ({ step: placed.get(alertKey(alert))!, title: stepTitle(alert), alertname: alert.alertname, startsAt: alert.startsAt }));
    const waiting = notice.rewake.map(key => {
      const tracked = state.alerts[key]!;
      return { step: tracked.step ?? "", title: steps.get(key)?.text ?? tracked.alertname, alertname: tracked.alertname, startsAt: tracked.startsAt };
    });
    const result = await this.send(notice.chat, alertText(added, waiting));
    this.deps.log(`alerts: ${result === "sent" ? "woke" : "could not reach"} ${notice.chat.slice(0, 8)} for ${added.length} new and ${waiting.length} unowned firing steps`);
    return noticed(state, notice, placed, now);
  }

  private async steps(state: BridgeState): Promise<Map<string, StepView>> {
    const boards = new Map<string, ChatBoard | null>();
    const views = new Map<string, StepView>();
    for (const [key, tracked] of Object.entries(state.alerts)) {
      if (tracked.step === null) continue;
      if (!boards.has(tracked.chat)) boards.set(tracked.chat, await this.deps.boards.read(tracked.chat));
      const item = findItem(boards.get(tracked.chat)?.plan ?? [], tracked.step)?.item;
      if (item) views.set(key, { text: item.text, open: OPEN.has(item.status), owned: Boolean(item.job || item.sessionId) });
    }
    return views;
  }

  private async read(): Promise<BridgeState> {
    try { return parseState(JSON.parse(await readFile(this.deps.file, "utf8"))); }
    catch (error) { if (missing(error)) return emptyState(); throw error; }
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
