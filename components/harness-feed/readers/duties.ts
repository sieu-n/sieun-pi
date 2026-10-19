import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Sample } from "../otlp.ts";
import type { DutyRunRecord, DutySchedule } from "../../user-history/src/shared/chat-duties.ts";
import type { ChatBoard } from "../../user-history/src/shared/types.ts";

/**
 * Duties, check-ins, plans and goals of the owner's chats, read from the chat service's own files on the box that runs it. The rules are the
 * app's own functions, loaded only on the chat host so the Mac never loads user-history: the fleet green share as `dutyFleet` counts it
 * (scripts/duties/duty-fleet.ts), each duty's dot as the Duties card shows it (`dutyState`), the check-in's numbers as its card shows them,
 * and the Chat system duty's (d9) own last measure. The runs files (15 MB on us-metal02 on 10-19) are read from a saved offset each round.
 */

const SRC = "../../user-history/src/";
/** How late a duty may run before it counts as overdue. Over the 3 days to 10-19 17:00Z, 95% of check-in runs came within 10.4 min of their interval and 95% of every-N-minutes duty runs within 1.1 min. */
export const OVERDUE_GRACE_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type App = Awaited<ReturnType<typeof loadApp>>;
async function loadApp() {
  const [duties, streak, card, settings, board, store, owners] = await Promise.all([
    import(SRC + "shared/chat-duties.ts"), import(SRC + "shared/duty-streak.ts"), import(SRC + "client/duty-card.ts"), import(SRC + "checkin-settings.ts"),
    import(SRC + "shared/chat-board.ts"), import(SRC + "chat-board-store.ts"), import(SRC + "owner-chats.ts"),
  ]) as [typeof import("../../user-history/src/shared/chat-duties.ts"), typeof import("../../user-history/src/shared/duty-streak.ts"),
    typeof import("../../user-history/src/client/duty-card.ts"), typeof import("../../user-history/src/checkin-settings.ts"),
    typeof import("../../user-history/src/shared/chat-board.ts"), typeof import("../../user-history/src/chat-board-store.ts"),
    typeof import("../../user-history/src/owner-chats.ts")];
  return { ...duties, ...streak, ...card, ...settings, ...board, ...store, ...owners };
}

/** The records of one duty a reading needs, newest of each kind, as the runs file's line order gives them (later lines are newer). */
export interface DutyLast {
  newest?: DutyRunRecord;
  /** The newest run that is not skipped: the card's dot, the check-in's flagged items and step classes. */
  shown?: DutyRunRecord;
  /** The newest run whose measure after its job (`effectiveRun`) is met or missed: the fleet's green test. */
  measured?: DutyRunRecord;
  /** The last RUN_STRIP runs, oldest first, slimmed: the card's run strip (`history`). */
  recent: DutyRunRecord[];
  /** The measured runs from the newest one that met every target on, oldest first, slimmed: every run a metric's miss streak can reach (`metricStreaks`). */
  streak: DutyRunRecord[];
}
/** The runs the Duties card's strip shows, `history(view, 14)` in src/client/duties.svelte.ts. */
export const RUN_STRIP = 14;
interface RunsTail { ino: bigint; offset: number; duties: Map<string, DutyLast> }

/** The fields of a run the strip and the streaks read; the summary and flagged items stay out of memory. */
const slimRun = (run: DutyRunRecord): DutyRunRecord => ({ duty: run.duty, at: run.at, trigger: run.trigger, ms: 0, verdict: run.verdict, metrics: run.metrics ?? {}, summary: "",
  ...(run.fixes ? { fixes: run.fixes } : {}), ...(run.after ? { after: { ...run.after, summary: "" } } : {}) });

/** Folds one run record into its duty's newest records. */
export function foldRun(duties: Map<string, DutyLast>, record: DutyRunRecord, effective: (run: DutyRunRecord) => { verdict: string }): void {
  if (typeof record?.duty !== "string" || typeof record.at !== "number") return;
  const last = duties.get(record.duty) ?? { recent: [], streak: [] };
  last.newest = record;
  if (record.verdict !== "skipped") last.shown = record;
  const slim = slimRun(record);
  last.recent.push(slim);
  if (last.recent.length > RUN_STRIP) last.recent.shift();
  const verdict = effective(record).verdict;
  if (verdict === "met" || verdict === "missed") last.measured = record;
  // A run that met every target ends every metric's streak, so nothing older can count.
  if (verdict === "met") last.streak = [slim];
  else if (verdict === "missed") last.streak.push(slim);
  duties.set(record.duty, last);
}

/**
 * A chat's runs file read on from the last round's offset. A rewrite (`updateRun` and `remove` replace the file by rename, so the inode
 * changes) or a shorter file reads it whole again. A line not ended by a newline yet waits for the next round.
 */
export async function readRuns(path: string, tail: RunsTail | undefined, effective: (run: DutyRunRecord) => { verdict: string }): Promise<RunsTail> {
  const handle = await open(path, "r").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!handle) return { ino: -1n, offset: 0, duties: new Map() };
  try {
    const info = await handle.stat({ bigint: true });
    const size = Number(info.size);
    const fresh = !tail || tail.ino !== info.ino || size < tail.offset;
    const state: RunsTail = fresh ? { ino: info.ino, offset: 0, duties: new Map() } : tail;
    if (size === state.offset) return state;
    const buffer = Buffer.alloc(size - state.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (end < 0) return state;
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { foldRun(state.duties, JSON.parse(line) as DutyRunRecord, effective); } catch { continue; }
    }
    state.offset += end + 1;
    return state;
  } finally { await handle.close(); }
}

/** When a duty runs next by its schedule, from its newest run of any kind (a skip covers its slot too), or its creation before its first run. */
export function dueAt(schedule: DutySchedule, since: number, dailySlot: (at: string, now: number) => number): number {
  if (schedule.kind === "every") return since + schedule.minutes * 60_000;
  const slot = dailySlot(schedule.at, since);
  return slot + DAY_MS;
}

/** Chat names from the catalog copies, by the title of each chat's session; a duplicate name gets its short id, a missing one is the short id. */
export function chatNames(ids: readonly string[], listed: ReadonlyMap<string, { name?: string }>): Map<string, string> {
  const raw = new Map(ids.map(id => [id, listed.get(id)?.name?.trim() || id.slice(0, 8)] as const));
  const seen = new Map<string, number>();
  for (const name of raw.values()) seen.set(name, (seen.get(name) ?? 0) + 1);
  return new Map([...raw].map(([id, name]) => [id, (seen.get(name) ?? 0) > 1 ? `${name} (${id.slice(0, 8)})` : name] as const));
}

/** How much of a catalog copy the name search reads first: on 10-19 every owner chat's row sat in the first 0.5 MB of the 14 MB and 39 MB copies. */
const NAME_PREFIX_BYTES = 1 << 20;
const ROW_BYTES = 4000;

/**
 * Each chat's session title in the boxes' catalog copies, as `listedSessions` (src/daemon-faults.ts) reads a top-level chat's row: the first
 * copy whose row for the id names a session file. It searches the bytes, so a 39 MB copy is never decoded whole, and it reads the first
 * NAME_PREFIX_BYTES and then the whole file only when an id is still missing.
 */
export async function catalogNames(files: readonly string[], ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const named = new Set<string>();
  for (const file of files) {
    const handle = await open(file, "r").catch(() => null);
    if (!handle) continue;
    try {
      const size = (await handle.stat()).size;
      for (const length of [Math.min(size, NAME_PREFIX_BYTES), size]) {
        const wanted = ids.filter(id => !named.has(id));
        if (!wanted.length) break;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        for (const id of wanted) {
          const at = buffer.indexOf(`"sessionId":"${id}`);
          if (at < 0 || (at + ROW_BYTES > length && length < size)) continue;
          const slice = buffer.subarray(at, at + ROW_BYTES).toString("utf8");
          if (!/"sessionFile":"[^"]*"/.test(slice)) continue;
          named.add(id);
          const name = /"sessionName":"((?:[^"\\]|\\.)*)"/.exec(slice)?.[1];
          if (name) names.set(id, JSON.parse(`"${name}"`) as string);
        }
        if (length === size) break;
      }
    } finally { await handle.close(); }
  }
  return names;
}

interface NameCache { key: string; names: Map<string, string> }
/** The chat names, found again only when the owner's chats or a catalog copy changed. */
async function namesOf(dataDir: string, home: string, ids: readonly string[], cache: NameCache | undefined): Promise<NameCache> {
  const mirror = join(home, ".cache/sieun-pi/hosts");
  const files = [join(dataDir, "session-copy.json"), ...(await readdir(mirror).catch(() => [] as string[])).filter(name => name.endsWith(".sessions.json")).sort().map(name => join(mirror, name))];
  const stamps = await Promise.all(files.map(file => stat(file).then(info => `${info.ino}:${info.mtimeMs}`, () => "-")));
  const key = `${ids.join(",")}|${stamps.join(",")}`;
  if (cache?.key === key) return cache;
  const listed = await catalogNames(files, ids);
  return { key, names: chatNames(ids, new Map([...listed].map(([id, name]) => [id, { name }]))) };
}

/** One flagged check of the daily tool check, with its newest re-check after the run. */
export interface ToolProblem { id: string; status: "fail" | "off"; recheck?: string }

/**
 * The daily tool check's problems, as `dailyRun` in src/chat-tools.ts reads them (chat-tools.ts itself does not load under plain node): each
 * check its run's saved output flagged as failing or off, with the newest re-check of it after the run from skills-and-tools.rechecks.jsonl.
 * `dailyRun` also drops a check that CHECKS no longer has; that list lives in scripts/duties/skills-and-tools.ts, which does not load either.
 */
export function toolProblems(output: unknown, rechecks: string, since: number): ToolProblem[] {
  const flagged = (output as { flagged?: unknown } | null)?.flagged;
  const problems = (Array.isArray(flagged) ? flagged : []).flatMap((slice: { kind?: unknown; item?: unknown }): ToolProblem[] => {
    const status = slice?.kind === "off" ? "off" : slice?.kind === "fail_agent" || slice?.kind === "fail_owner" ? "fail" : undefined;
    return status && typeof slice.item === "string" ? [{ id: slice.item, status }] : [];
  });
  const latest = new Map<string, { at: number; status: string }>();
  for (const line of rechecks.split("\n")) {
    let entry: { at?: unknown; results?: unknown };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (typeof entry.at !== "number" || entry.at <= since || !Array.isArray(entry.results)) continue;
    for (const result of entry.results as { id?: unknown; status?: unknown }[]) {
      if (typeof result?.id === "string" && entry.at > (latest.get(result.id)?.at ?? 0)) latest.set(result.id, { at: entry.at, status: String(result.status) });
    }
  }
  for (const problem of problems) { const recheck = latest.get(problem.id); if (recheck) problem.recheck = recheck.status; }
  return problems;
}

const gauge = (name: string, help: string, value: number, labels?: Record<string, string>, unit?: Sample["unit"]): Sample =>
  ({ name, kind: "gauge", help, value, ...(unit ? { unit } : {}), ...(labels ? { labels } : {}) });

/**
 * One duty's table and strip as the Duties card shows them, and its miss streaks: per metric its target, and the value and verdict of the
 * newest run that is not skipped, after its job (`lastRun` and `effectiveRun` in DutyList.svelte); the strip's runs by verdict (`history`,
 * `judgedRun`); and per missed metric its streak, whether it is stuck and its fix (`metricStreaks`, `dutyCard`). A fix counts live as the run
 * recorded it while its step is still open on the board, as `dutyFleet` drops a closed one; the card's own live test reads the chat's agent
 * rows, which only the chat server holds. Returns the stuck metrics with no live fix.
 */
function dutyMetrics(app: App, out: Sample[], label: Record<string, string>, metrics: readonly { key: string; target: number }[], last: Partial<DutyLast>, openSteps: ReadonlySet<string>): number {
  const shown = last.shown ? app.effectiveRun(last.shown).metrics ?? {} : {};
  for (const metric of app.verdictMetrics(metrics as Parameters<App["verdictMetrics"]>[0])) {
    const at = { ...label, metric: metric.key };
    out.push(gauge("harness.duties.metric_target", "The duty metric's target.", metric.target, at));
    const result = shown[metric.key];
    if (!result) continue;
    out.push(gauge("harness.duties.metric_value", "The duty metric's value in the newest run that was not skipped, after its job.", result.value, at));
    out.push(gauge("harness.duties.metric_met", "1 when that value met the metric's target.", result.met ? 1 : 0, at));
  }
  const strip = new Map<string, number>([["met", 0], ["missed", 0], ["error", 0], ["skipped", 0]]);
  for (const run of last.recent ?? []) {
    const verdict = app.judgedRun(run, metrics as Parameters<App["judgedRun"]>[1]).verdict;
    strip.set(verdict, (strip.get(verdict) ?? 0) + 1);
  }
  if (last.recent?.length) for (const [verdict, n] of strip) out.push(gauge("harness.duties.recent_runs", `The duty's last ${RUN_STRIP} runs by verdict, as the card's run strip shows them.`, n, { ...label, verdict }));
  let stuckNoFix = 0;
  for (const streak of app.metricStreaks([...last.streak ?? []].reverse())) {
    const fix = streak.fix && openSteps.has(streak.fix.step) ? (streak.fix.live ? "live" : "idle") : "none";
    const at = { ...label, metric: streak.key };
    out.push(gauge("harness.duties.metric_misses", "Measured runs in a row, after their job, that missed this metric.", streak.misses, at));
    out.push(gauge("harness.duties.metric_stuck", "1 when the metric missed 3 runs in a row with no move toward its target, so the next run must change approach.", streak.stuck ? 1 : 0, { ...at, fix }));
    if (streak.stuck && fix !== "live") stuckNoFix++;
  }
  return stuckNoFix;
}

const CHECK_IN_KEYS = ["goal_gaps", "stuck_steps", "no_done_line", "plan_risks"] as const;
const D9_KEYS = ["duties_green_pct", "stuck_steps_all", "plan_upkeep_all", "stuck_duties"] as const;

interface State { app?: App; runs: Map<string, RunsTail>; names?: NameCache; boards?: InstanceType<App["BoardStore"]>; toolOutput?: { detail: string; output: unknown } }

export async function read(ctx: Context): Promise<Sample[]> {
  if (!ctx.chatHost) return [];
  const state = (ctx.state.get("duties") as State | undefined) ?? { runs: new Map() };
  ctx.state.set("duties", state);
  const app = state.app ??= await loadApp();
  const dataDir = join(ctx.home, ".prime/agent/browser-chat");
  const boards = state.boards ??= new app.BoardStore(dataDir);
  const now = ctx.now;
  const ids = await app.ownerChats(dataDir);
  state.names = await namesOf(dataDir, ctx.home, ids, state.names);
  const settingsPath = join(dataDir, "check-in-settings.json");
  // checkInSettings creates a missing file on read, and this reader never writes the chat's files.
  const settings = await stat(settingsPath).then(() => app.checkInSettings(settingsPath).all(), () => ({} as Record<string, never>));
  const out: Sample[] = [];
  let fleetGreen = 0, fleetJudged = 0;
  const findingKinds = new Map<string, number>();
  let d9: DutyRunRecord | undefined;
  let tools: { chat: string; name: string; record: DutyRunRecord } | undefined;

  for (const id of ids) {
    const chat = state.names.names.get(id) ?? id.slice(0, 8);
    const setting = settings[id] ?? app.DEFAULT_CHECK_IN;
    const paused = app.activePause(setting, now) !== null;
    const file = app.parseDutyFile(JSON.parse(await readFile(join(dataDir, "duties", `${id}.json`), "utf8").catch(() => "{}")));
    const tail = await readRuns(join(dataDir, "duties", `${id}.runs.jsonl`), state.runs.get(id), app.effectiveRun);
    state.runs.set(id, tail);

    // The duties the fleet judges: the check-in unless the owner paused it, and every active duty (`dutyFleet`).
    const checkIn = { id: app.CHECK_IN_DUTY_ID, name: app.CHECK_IN_DUTY.name, metrics: app.CHECK_IN_DUTY.metrics, status: paused ? "paused" : "active",
      schedule: { kind: "every", minutes: setting.everyMs / 60_000 } as DutySchedule, createdAt: file.checkIn?.createdAt ?? 0 };
    const all = [checkIn, ...file.duties];
    const states = new Map<string, number>();
    let green = 0, judged = 0, overdue = 0, stuckNoFix = 0;
    const board: ChatBoard | null = await boards.view(id).catch(() => null);
    const openSteps = new Set<string>();
    const walkOpen = (items: ChatBoard["plan"]) => { for (const item of items) { if (item.status === "todo" || item.status === "doing" || item.status === "blocked") openSteps.add(item.id); walkOpen(item.children); } };
    walkOpen(board?.plan ?? []);
    for (const duty of all) {
      const last = tail.duties.get(duty.id) ?? {};
      const label = { chat, duty: duty.name };
      const view = { duty: { ...duty, ownerWords: "", goal: "" }, paused: duty.status !== "active", running: false, runs: last.shown ? [last.shown] : [] };
      const dot = app.dutyState(view as Parameters<App["dutyState"]>[0]);
      states.set(dot, (states.get(dot) ?? 0) + 1);
      stuckNoFix += dutyMetrics(app, out, label, duty.metrics, last, openSteps);
      if (duty.status !== "active") continue;
      if (last.measured) {
        const met = app.effectiveRun(last.measured).verdict === "met";
        judged++;
        if (met) green++;
        out.push(gauge("harness.duties.duty_green", "1 when the duty's newest measured run, after its job, met every target, 0 when it missed one.", met ? 1 : 0, label));
      }
      if (duty.id === app.CHECK_IN_DUTY_ID && setting.startAt !== undefined && setting.startAt > now) continue;
      // A chat's first check-in has no run and no createdAt in its duties file yet, so nothing says when it was due.
      const since = last.newest?.at ?? (duty.createdAt || undefined);
      if (since === undefined) continue;
      const late = Math.max(0, now - Math.max(dueAt(duty.schedule, since, app.dailySlot), duty.id === app.CHECK_IN_DUTY_ID ? setting.startAt ?? 0 : 0));
      if (late > OVERDUE_GRACE_MS) overdue++;
      out.push(gauge("harness.duties.duty_late", "How long past its scheduled time the duty's next run is, 0 while it is not due.", late / 1000, label, "s"));
      if (last.newest) out.push(gauge("harness.duties.duty_run_age", "Time since the duty's newest run record of any kind.", (now - last.newest.at) / 1000, label, "s"));
      const own = file.duties.find(entry => entry.id === duty.id);
      if (own?.precheck.command.some(word => word.endsWith("chat-system.ts"))) d9 = last.measured;
      // The daily tool check is the newest run of any duty whose precheck runs skills-and-tools.ts (`dailyRun`).
      if (own?.precheck.command.join(" ").includes("skills-and-tools.ts") && last.newest && (!tools || last.newest.at > tools.record.at)) tools = { chat, name: duty.name, record: last.newest };
    }
    fleetGreen += green; fleetJudged += judged;
    for (const dot of ["met", "missed", "error", "paused", "new"]) {
      out.push(gauge("harness.duties.count", "The chat's duties, the check-in included, by the dot the Duties card shows: met, missed (off target), error, paused or new.", states.get(dot) ?? 0, { chat, state: dot }));
    }
    if (judged) out.push(gauge("harness.duties.green_share", "Share of the chat's active duties whose newest measured run met every target, as the fleet counts it.", green / judged, { chat }, "1"));
    out.push(gauge("harness.duties.stuck_no_fix", "Missed metrics of the chat's duties that are stuck (3 misses in a row with no move) and whose run named no live fix job on an open step.", stuckNoFix, { chat }));
    out.push(gauge("harness.duties.overdue", `Active duties with no run more than ${OVERDUE_GRACE_MS / 60_000} min after their schedule said.`, overdue, { chat }));

    // The check-in, as its card shows it: the newest run that is not skipped, its after-job measure first.
    out.push(gauge("harness.checkin.paused", "1 while the owner or an agent paused the chat's check-in.", paused ? 1 : 0, { chat }));
    out.push(gauge("harness.checkin.interval", "The chat's check-in interval.", setting.everyMs / 1000, { chat }, "s"));
    const ck = tail.duties.get(app.CHECK_IN_DUTY_ID);
    const lastAt = Math.max(ck?.newest?.at ?? 0, file.checkIn?.lastRunAt ?? 0);
    if (!paused && lastAt) out.push(gauge("harness.checkin.last_run_age", "Time since the chat's newest check-in run.", (now - lastAt) / 1000, { chat }, "s"));
    if (ck?.shown) {
      const shown = app.effectiveRun(ck.shown);
      for (const key of CHECK_IN_KEYS) {
        const result = shown.metrics?.[key];
        if (result) out.push(gauge("harness.checkin.metric", "The check-in's own counts from its newest run that was not skipped, after its job: goal_gaps, stuck_steps, no_done_line, plan_risks.", result.value, { chat, key }));
      }
      for (const [cls, n] of Object.entries(ck.shown.classes ?? {})) out.push(gauge("harness.checkin.steps", "The chat's open steps by the check-in's class, from its newest run that was not skipped.", n, { chat, class: cls }));
      const flagged = ck.shown.flagged ?? [];
      out.push(gauge("harness.checkin.findings", "Items the chat's newest check-in run that was not skipped flagged.", flagged.length, { chat }));
      for (const slice of flagged) findingKinds.set(slice.kind, (findingKinds.get(slice.kind) ?? 0) + 1);
      out.push(gauge("harness.checkin.shown_run_age", "Time since the check-in run the card's numbers come from.", (now - (ck.shown.after?.at ?? ck.shown.at)) / 1000, { chat }, "s"));
    }

    // The plan, as the board stores it.
    if (!board) continue;
    out.push(gauge("harness.plan.for_you_open", "Open For you todos on the chat's board, as the sidebar and the board's For you list count them.", board.todos.filter(todo => !todo.done).length, { chat }));
    out.push(gauge("harness.plan.for_you_asks", "Open For you todos an agent asked, as the chat header's waiting-on-you dot counts them (openAgentTodos).", board.todos.filter(todo => !todo.done && todo.from === "agent").length, { chat }));
    const open = openSteps.size;
    const counts = app.planCounts(board.plan);
    out.push(gauge("harness.plan.open_steps", "Open plan items (todo, doing or blocked) at every level of the chat's board.", open, { chat }));
    out.push(gauge("harness.plan.items", "Plan items that are not dropped, done or not, as the sidebar line counts them.", counts.total, { chat }));
    out.push(gauge("harness.plan.done_items", "Done plan items, as the sidebar line counts them.", counts.done, { chat }));
    const updated = Date.parse(board.updatedAt);
    if (Number.isFinite(updated)) out.push(gauge("harness.plan.upkeep_age", "Time since the chat's board last changed.", (now - updated) / 1000, { chat }, "s"));
    const readings = new Map<string, number>([["live", 0], ["stale", 0], ["unmeasured", 0], ["no_target", 0]]);
    let onTarget = 0;
    for (const goal of app.openGoals(board.plan)) {
      const target = goal.target;
      const at = Date.parse(target?.measuredAt ?? "");
      const reading = !target ? "no_target" : !Number.isFinite(at) || target.current === undefined ? "unmeasured"
        : now - at > app.targetStaleMs(target, setting.everyMs) ? "stale" : "live";
      readings.set(reading, readings.get(reading)! + 1);
      if (target && app.targetMet(target)) onTarget++;
    }
    for (const [reading, n] of readings) out.push(gauge("harness.plan.goals", "Open goals by their number's reading: live, stale (older than 2 check-in intervals, or 24 h for a daily metric), unmeasured, or no target.", n, { chat, reading }));
    out.push(gauge("harness.plan.goals_on_target", "Open goals whose last measured number reaches its target.", onTarget, { chat }));
  }

  if (fleetJudged) out.push(gauge("harness.duties.fleet_green_share", "Share of every owner chat's active duties whose newest measured run met every target (`dutyFleet`, AI harness goal p706).", fleetGreen / fleetJudged, undefined, "1"));
  for (const [kind, n] of findingKinds) out.push(gauge("harness.checkin.findings_by_kind", "Items the newest check-in runs of all chats flagged, by kind.", n, { kind }));
  if (d9) {
    const measured = app.effectiveRun(d9);
    for (const key of D9_KEYS) {
      const result = measured.metrics?.[key];
      if (result) out.push(gauge("harness.chat_system.metric", "The Chat system duty's (d9) newest measured run over all chats: duties_green_pct, stuck_steps_all, plan_upkeep_all, stuck_duties.", result.value, { key }));
    }
    out.push(gauge("harness.chat_system.run_age", "Time since the Chat system duty's newest measured run.", (now - (d9.after?.at ?? d9.at)) / 1000, undefined, "s"));
  }
  if (tools) {
    const { record } = tools;
    const label = { chat: tools.chat, duty: tools.name };
    if (record.detail && state.toolOutput?.detail !== record.detail) {
      state.toolOutput = { detail: record.detail, output: await readFile(record.detail, "utf8").then(text => JSON.parse(text) as unknown, () => null) };
    }
    const output = record.detail ? state.toolOutput?.output : null;
    const rechecks = await readFile(join(dataDir, "duties", "skills-and-tools.rechecks.jsonl"), "utf8").catch(() => "");
    const problems = toolProblems(output, rechecks, record.at);
    const judged = app.effectiveRun(record);
    const checksRun = (output as { metrics?: { checks_run?: unknown } } | null)?.metrics?.checks_run ?? judged.metrics?.checks_run?.value;
    const fails = problems.filter(problem => problem.status === "fail");
    const fixed = fails.filter(problem => problem.recheck === "pass").length;
    out.push(gauge("harness.tools_daily.run_age", "Time since the daily Skills and tools check's newest run.", (now - record.at) / 1000, label, "s"));
    if (typeof checksRun === "number") out.push(gauge("harness.tools_daily.checks", "Checks the daily Skills and tools run ran.", checksRun, label));
    out.push(gauge("harness.tools_daily.failures", "Checks the daily run found failing.", fails.length, label));
    out.push(gauge("harness.tools_daily.off", "Checks the daily run found off.", problems.length - fails.length, label));
    out.push(gauge("harness.tools_daily.fixed", "Failing checks whose re-check after the run passed.", fixed, label));
    out.push(gauge("harness.tools_daily.still_failing", "Failing checks with no passing re-check since the run.", fails.length - fixed, label));
    out.push(gauge("harness.tools_daily.met", "1 when the daily run's verdict, after its job, is met.", judged.verdict === "met" ? 1 : 0, label));
  }
  return out;
}
