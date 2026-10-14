import { readFile, rename, writeFile } from "node:fs/promises";
import { routeAlert } from "./alert-routes.ts";
import type { BoardStore } from "./chat-board-store.ts";
import { missing } from "./locked-json.ts";
import { BOARD_LIMITS, findItem, nextIds, openGoals, titleDetail, walkItems } from "./shared/chat-board.ts";
import type { BoardOp, ChatBoard, PlanItem } from "./shared/types.ts";
import { TICK_MS } from "./wakes.ts";

export const REWAKE_MS = 20 * 60_000;
export const ALERT_GOAL = "Firing prod alerts";
export const GRAFANA_ALERTS_PATH = "/api/alertmanager/grafana/api/v2/alerts";
const RESOLVED = "The alert resolved at";

export interface FiringAlert { fingerprint: string; startsAt: string; alertname: string; labels: Record<string, string>; summary: string; url: string }
export interface Tracked { chat: string; step: string; alertname: string; startsAt: string; wokeAt: number }
export interface BridgeState { v: 1; alerts: Record<string, Tracked> }
export interface StepView { text: string; open: boolean; owned: boolean }
export interface ChatNotice { chat: string; add: FiringAlert[]; rewake: string[] }
export interface Resolve { key: string; chat: string; step: string; at: string }
export interface StepLine { step: string; title: string; alertname: string; startsAt: string }

export const emptyState = (): BridgeState => ({ v: 1, alerts: {} });
export const alertKey = (alert: Pick<FiringAlert, "fingerprint" | "startsAt">): string => `${alert.fingerprint}@${alert.startsAt}`;
export const alertChat = (alert: FiringAlert): string => routeAlert([alert.alertname, ...Object.values(alert.labels)]).session;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): Record<string, string> =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

export function parseAlerts(value: unknown): FiringAlert[] {
  if (!Array.isArray(value)) throw new Error("Grafana's alert list is not a list");
  return value.flatMap(item => {
    if (!isRecord(item) || !isRecord(item.status) || item.status.state !== "active") return [];
    const at = typeof item.startsAt === "string" ? Date.parse(item.startsAt) : NaN;
    if (typeof item.fingerprint !== "string" || !/^[\w-]{1,64}$/.test(item.fingerprint) || !Number.isFinite(at)) return [];
    const labels = strings(item.labels);
    return [{ fingerprint: item.fingerprint, startsAt: new Date(at).toISOString(), alertname: labels.alertname ?? labels.__alert_rule_uid__ ?? item.fingerprint, labels,
      summary: strings(item.annotations).summary ?? "", url: typeof item.generatorURL === "string" ? item.generatorURL : "" }];
  });
}

export function parseState(value: unknown): BridgeState {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.alerts)) throw new Error("Alert bridge state file is malformed.");
  return value as unknown as BridgeState;
}

export function reconcile(alerts: readonly FiringAlert[], state: BridgeState, steps: ReadonlyMap<string, StepView>, now: number): { notices: ChatNotice[]; resolves: Resolve[] } {
  const firing = new Map(alerts.map(alert => [alertKey(alert), alert]));
  const notices = new Map<string, ChatNotice>();
  const notice = (chat: string): ChatNotice => {
    const known = notices.get(chat);
    if (known) return known;
    const fresh: ChatNotice = { chat, add: [], rewake: [] };
    notices.set(chat, fresh);
    return fresh;
  };
  for (const [key, alert] of firing) if (!state.alerts[key]) notice(alertChat(alert)).add.push(alert);
  const waiting = new Map<string, { keys: string[]; due: boolean }>();
  const resolves: Resolve[] = [];
  for (const [key, tracked] of Object.entries(state.alerts)) {
    if (!firing.has(key)) { resolves.push({ key, chat: tracked.chat, step: tracked.step, at: new Date(now).toISOString() }); continue; }
    const step = steps.get(key);
    if (!step?.open || step.owned) continue;
    const chat = waiting.get(tracked.chat) ?? { keys: [], due: false };
    chat.keys.push(key);
    chat.due ||= now - tracked.wokeAt >= REWAKE_MS;
    waiting.set(tracked.chat, chat);
  }
  for (const [chat, { keys, due }] of waiting) if (due) notice(chat).rewake.push(...keys);
  return { notices: [...notices.values()], resolves };
}

export function noticed(state: BridgeState, notice: ChatNotice, placed: ReadonlyMap<string, string>, now: number): BridgeState {
  const alerts = { ...state.alerts };
  for (const alert of notice.add) {
    const step = placed.get(alertKey(alert));
    if (step) alerts[alertKey(alert)] = { chat: notice.chat, step, alertname: alert.alertname, startsAt: alert.startsAt, wokeAt: now };
  }
  for (const key of notice.rewake) if (alerts[key]) alerts[key] = { ...alerts[key], wokeAt: now };
  return { ...state, alerts };
}

export function resolved(state: BridgeState, key: string): BridgeState {
  const { [key]: _gone, ...alerts } = state.alerts;
  return { ...state, alerts };
}

const mark = (alert: FiringAlert): string => `Grafana alert ${alert.fingerprint}, firing since ${alert.startsAt}.`;

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

const OPEN = new Set(["todo", "doing", "blocked"]);

export interface AlertBridgeDeps {
  file: string;
  alerts: () => Promise<FiringAlert[] | null>;
  boards: Pick<BoardStore, "read" | "apply">;
  deliver: (session: string, text: string) => Promise<"sent" | "gone">;
  startRoot?: (root: string) => Promise<void>;
  now?: () => number;
  log: (line: string) => void;
}

export class AlertBridge {
  private readonly now: () => number;
  constructor(private readonly deps: AlertBridgeDeps) { this.now = deps.now ?? Date.now; }

  async tick(): Promise<void> {
    const alerts = await this.deps.alerts();
    if (!alerts) return;
    let state = await this.read();
    const now = this.now();
    const steps = await this.steps(state);
    const { notices, resolves } = reconcile(alerts, state, steps, now);
    for (const notice of notices) {
      try {
        state = await this.notify(notice, state, steps, now);
        await this.write(state);
      } catch (error) { this.deps.log(`alerts: notice to ${notice.chat.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}; tried again next tick`); }
    }
    for (const resolve of resolves) {
      try {
        await this.deps.boards.apply(resolve.chat, board => resolveOps(board, resolve), "agent");
        state = resolved(state, resolve.key);
        await this.write(state);
        this.deps.log(`alerts: ${resolve.key} resolved, noted on ${resolve.step} in ${resolve.chat.slice(0, 8)}`);
      } catch (error) { this.deps.log(`alerts: resolve ${resolve.key}: ${error instanceof Error ? error.message : String(error)}; tried again next tick`); }
    }
  }

  private async notify(notice: ChatNotice, state: BridgeState, steps: ReadonlyMap<string, StepView>, now: number): Promise<BridgeState> {
    let placed = new Map<string, string>();
    if (notice.add.length) {
      await this.deps.boards.apply(notice.chat, board => {
        const plan = placeSteps(board, notice.add);
        placed = plan.steps;
        return plan.ops;
      }, "agent");
    }
    const added = notice.add.map(alert => ({ step: placed.get(alertKey(alert))!, title: stepTitle(alert), alertname: alert.alertname, startsAt: alert.startsAt }));
    const waiting = notice.rewake.map(key => {
      const tracked = state.alerts[key]!;
      return { step: tracked.step, title: steps.get(key)?.text ?? tracked.alertname, alertname: tracked.alertname, startsAt: tracked.startsAt };
    });
    const text = alertText(added, waiting);
    let result = await this.deps.deliver(notice.chat, text);
    if (result === "gone" && this.deps.startRoot) {
      await this.deps.startRoot(notice.chat);
      result = await this.deps.deliver(notice.chat, text);
    }
    this.deps.log(`alerts: ${result === "sent" ? "woke" : "could not reach"} ${notice.chat.slice(0, 8)} for ${added.length} new and ${waiting.length} unowned firing steps`);
    return noticed(state, notice, placed, now);
  }

  private async steps(state: BridgeState): Promise<Map<string, StepView>> {
    const boards = new Map<string, ChatBoard | null>();
    const views = new Map<string, StepView>();
    for (const [key, tracked] of Object.entries(state.alerts)) {
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

export async function readGrafanaAlerts(configFile: string): Promise<FiringAlert[] | null> {
  const text = await readFile(configFile, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (text === null) return null;
  const config = JSON.parse(text) as unknown;
  if (!isRecord(config) || typeof config.url !== "string" || typeof config.token !== "string") throw new Error(`${configFile} needs a url and a token`);
  const response = await fetch(new URL(GRAFANA_ALERTS_PATH, config.url), { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Grafana answered ${response.status} for the alert list`);
  return parseAlerts(await response.json());
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
