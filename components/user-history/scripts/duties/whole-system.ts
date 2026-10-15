import { open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { activePause, checkInSettings } from "../../src/checkin-settings.ts";
import { FLEET_STATE_FILE } from "../../src/fleet-budget.ts";
import { parseFleetState } from "../../src/fleet-guard.ts";
import { readWatch, unusable, type WatchLine } from "../../src/mac-usable-watch.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import { CHECK_IN_DUTY_ID, type DutyRunRecord, type FlaggedSlice, type PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { CHANGE_APPROACH_MISSES, effectiveRun, missStreak } from "../../src/shared/duty-streak.ts";
import { isHarnessMinute } from "./mac-stays-usable.ts";

/**
 * The Whole system duty's precheck (`node --import tsx scripts/duties/whole-system.ts`), run every 30 minutes on the owner's 10-15 ask
 * ("reorganize duties have a 30 minute trigger that checks all this", mva1wt2h). It reads files the chat service and pi-pool already write and
 * makes no daemon call: the Mac usable watch, service.log, pi-pool.log and its config, fleet-state.json, queue-parked.json and every chat's duty
 * runs. The headline is how many of the last 30 minutes ran clean: a minute is clean when the watch read the Mac usable, no start, wake or parked
 * job had waited over HOLD_MS, and no turn sat queued while pi-pool had FREE_SLOTS free slots. Supporting: queue holds, fix jobs that ended
 * within CHURN_MS of their open with their metric still missing, and open steps nobody moves in all chats. The rest is detail.
 */

export const WINDOW_MS = 30 * 60_000;
const MINUTE = 60_000;
/** A start, wake or parked job waiting longer than this is a hold: the owner's line on 10-15, when 38 jobs' wakes sat held 3,374 times. */
export const HOLD_MS = 10 * MINUTE;
/** A fix job whose miss comes back this soon after its open died young: the opener reopened p494 and p495 every few minutes on 10-15 and 10-16. */
export const CHURN_MS = 5 * MINUTE;
/** Free slots that make a queued turn a queue fault: two, so one slot a release just freed is not counted. */
export const FREE_SLOTS = 2;
/** A queued turn counts against free slots only once the oldest one waited this long, past pi-pool's admit poll. */
export const QUEUED_WAIT_S = 120;
/** About 3 h of service.log at 10-16's rate (1.7 MB an hour, most of it held wakes), so a hold that began before the window is seen whole. */
const LOG_TAIL_BYTES = 6_000_000;

export interface Hold { what: string; from: number; to: number }
export interface FixOpen { chat: string; duty: string; job: string; at: number; died?: { at: number; why: string } }
export interface LogFacts { holds: Hold[]; fixes: FixOpen[]; stepScans: { at: number; chat: string; steps: string[] }[]; firstAt?: number }
export interface LimitChange { at: number; limit: number }

const TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const WAKE_HELD = /^wakes: wake (\w{8}) for .*: held by the fleet budget/;
const STARTED_AFTER = /^fleet budget: (\S+) (.+) starts after (\d+) s$/;
const FIX_OPENED = /^duty (\w{8})\/([\w-]+): .* had no fix step with a live job after \d+ or more missed runs; opened (.+)$/;
const FIX_ENDED = /^duty (\w{8})\/([\w-]+): fix job (.+?) (ended with .+ still missing; sent it back|could not be sent back.*|ended; it goes back on a later tick.*)$/;
const NOT_RESUMED = /^duty (\w{8})\/([\w-]+): own its fix: (Prime Agent did not resume this thread.*)$/;
const STEP_SCAN = /^chat (\w{8}): step scan told the chat (.+) have no live owner$/;
/** Lines of one wake held this far apart are one hold; the wake loop tries each held wake every tick. */
const HOLD_GAP_MS = 5 * MINUTE;

/** The holds, fix opens and step scan notices in service.log lines from `since` on; a hold may start before `since`, so the caller reads back far enough. */
export function readServiceLog(lines: readonly string[]): LogFacts {
  const wakes = new Map<string, Hold>();
  const holds: Hold[] = [];
  const fixes: FixOpen[] = [];
  const stepScans: LogFacts["stepScans"] = [];
  // Lines from the chats part (the step scan) carry no time, so they take the time of the stamped line before them.
  let at = NaN;
  for (const raw of lines) {
    const match = TIME.exec(raw);
    if (match) at = Date.parse(match[1]!);
    if (!Number.isFinite(at)) continue;
    const text = match ? match[2]! : raw;
    let found: RegExpExecArray | null;
    if ((found = WAKE_HELD.exec(text))) {
      const open = wakes.get(found[1]!);
      if (open && at - open.to <= HOLD_GAP_MS) open.to = at;
      else { const hold = { what: `wake of ${found[1]}`, from: at, to: at }; wakes.set(found[1]!, hold); holds.push(hold); }
    } else if ((found = STARTED_AFTER.exec(text))) {
      holds.push({ what: `${found[1]} ${found[2]}`, from: at - Number(found[3]) * 1000, to: at });
    } else if ((found = FIX_OPENED.exec(text))) {
      fixes.push({ chat: found[1]!, duty: found[2]!, job: found[3]!.trim(), at });
    } else if ((found = FIX_ENDED.exec(text)) || (found = NOT_RESUMED.exec(text))) {
      const [, chat, duty] = found;
      const job = found.length > 4 ? found[3]! : undefined;
      const why = found.length > 4 ? found[4]! : found[3]!;
      const fix = fixes.findLast(entry => entry.chat === chat && entry.duty === duty && (job === undefined || entry.job === job) && !entry.died);
      if (fix && at - fix.at <= CHURN_MS) fix.died = { at, why: why.replace(/; sent it back$/, "") };
    } else if ((found = STEP_SCAN.exec(text))) {
      stepScans.push({ at, chat: found[1]!, steps: found[2]!.split(", ") });
    }
  }
  // A fix job whose duty opened another one within CHURN_MS ended young too: the opener only opens again once the last fix job is gone.
  for (const fix of fixes) {
    const next = fixes.find(other => other !== fix && other.chat === fix.chat && other.duty === fix.duty && other.at > fix.at);
    if (!fix.died && next && next.at - fix.at <= CHURN_MS) fix.died = { at: next.at, why: `another fix job, ${next.job}, opened for the same duty` };
  }
  const first = lines.find(line => TIME.test(line));
  return { holds, fixes, stepScans, ...(first ? { firstAt: Date.parse(TIME.exec(first)![1]!) } : {}) };
}

/** pi-pool's working limit at each change, from its pressure events (local time stamps), oldest first. */
export function readLimits(lines: readonly string[]): LimitChange[] {
  const changes: LimitChange[] = [];
  for (const raw of lines) {
    if (!raw.includes('"pressure_')) continue;
    try {
      const event = JSON.parse(raw) as { event?: string; at?: number; ts?: string; limit_to?: number };
      if ((event.event === "pressure_level" || event.event === "pressure_limit") && typeof event.limit_to === "number") {
        const at = typeof event.at === "number" ? event.at * 1000 : Date.parse(event.ts ?? "");
        if (Number.isFinite(at)) changes.push({ at, limit: event.limit_to });
      }
    } catch { continue; }
  }
  return changes.sort((a, b) => a.at - b.at);
}

export const limitAt = (changes: readonly LimitChange[], at: number, fallback: number): number => changes.findLast(change => change.at <= at)?.limit ?? fallback;

/** Whether a watch line shows a queued turn while pi-pool had FREE_SLOTS or more free slots. */
export const queuedWithFreeSlots = (line: WatchLine, limit: number): boolean =>
  !!line.queue && line.queue.queued > (line.queue.held ?? 0) && line.queue.oldestWaitS >= QUEUED_WAIT_S && line.queue.working <= limit - FREE_SLOTS;

export interface Inputs {
  now: number;
  watch: readonly WatchLine[];
  log: LogFacts;
  limits: readonly LimitChange[];
  /** pi-pool's limit when the Mac reads ok (`mac_working_max`). */
  okLimit: number;
  /** Starts waiting in the fleet budget now, with the time each asked when the service publishes it. */
  waiting: readonly { kind: string; label: string; since?: number }[];
  parked: readonly { session: string; at: number; resumedAt?: number }[];
  /** Every chat's duty runs, newest first, with its active duty ids (the check-in included unless paused). */
  chats: readonly { id: string; name: string; duties: readonly { id: string; name: string }[]; runs: readonly DutyRunRecord[] }[];
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";
const minutes = (ms: number): number => Math.round(ms / MINUTE);

export function measure(input: Inputs): PrecheckOutput {
  const { now } = input;
  const start = now - WINDOW_MS;
  const flagged: FlaggedSlice[] = [];
  const queueHolds: Hold[] = [
    ...input.log.holds,
    ...input.waiting.flatMap(ask => ask.since === undefined ? [] : [{ what: `${ask.kind} ${ask.label} (still waiting)`, from: ask.since, to: now }]),
    ...input.parked.filter(entry => entry.resumedAt === undefined).map(entry => ({ what: `parked job ${entry.session.slice(0, 8)} (not resumed)`, from: entry.at, to: now })),
  ].filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  const heldAt = (at: number): boolean => queueHolds.some(hold => hold.from + HOLD_MS <= at && hold.to >= at - MINUTE);
  let clean = 0, usable = 0, fed = 0, unwatched = 0, held = 0, freeSlot = 0, harness = 0, other = 0;
  const dirty: string[] = [];
  for (let minute = 0; minute < 30; minute++) {
    const to = start + (minute + 1) * MINUTE;
    const line = input.watch.findLast(entry => { const at = Date.parse(entry.at); return at > to - MINUTE && at <= to; });
    const why: string[] = [];
    if (!line) { unwatched++; why.push("no watch line"); }
    else if (!line.usable) why.push("no pressure reading");
    else {
      fed++;
      if (unusable(line.usable).length) { why.push(`Mac unusable (${unusable(line.usable).join(", ")})`); if (isHarnessMinute(line)) harness++; else other++; }
      else usable++;
    }
    if (heldAt(to)) { held++; why.push("a start, wake or parked job held over 10 min"); }
    if (line && queuedWithFreeSlots(line, limitAt(input.limits, to, input.okLimit))) { freeSlot++; why.push("a turn queued with free slots"); }
    if (why.length) dirty.push(`${clock(to)} ${why.join(", ")}`);
    else clean++;
  }
  const churn = input.log.fixes.filter(fix => fix.at >= start && fix.died);
  const opened = input.log.fixes.filter(fix => fix.at >= start);
  const scans = input.log.stepScans.filter(scan => scan.at >= start);
  const stuck = input.chats.map(chat => {
    const run = chat.runs.find(entry => entry.duty === CHECK_IN_DUTY_ID && entry.verdict !== "skipped" && entry.verdict !== "error");
    const value = run ? effectiveRun(run).metrics.stuck_steps?.value ?? 0 : 0;
    return { chat, value, at: run?.at };
  }).filter(entry => entry.value > 0);
  const redDuties = input.chats.flatMap(chat => chat.duties.flatMap(duty => {
    const own = chat.runs.filter(run => run.duty === duty.id);
    const newest = own.find(run => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; });
    if (!newest || missStreak(own) < CHANGE_APPROACH_MISSES) return [];
    const live = Object.values(newest.fixes ?? {}).some(fix => fix.live);
    return live ? [] : [`${chat.name}: ${duty.name} missed ${missStreak(own)} runs in a row, with no live fix job on its last run`];
  }));
  const metrics: Record<string, number> = {
    clean_min_30: clean,
    queue_holds_30: queueHolds.length,
    fix_churn_30: churn.length,
    stuck_steps_all: stuck.reduce((sum, entry) => sum + entry.value, 0),
    usable_min_30: usable,
    fed_min_30: fed,
    harness_unusable_min_30: harness,
    other_unusable_min_30: other,
    held_min_30: held,
    queued_free_slot_min_30: freeSlot,
    unwatched_min_30: unwatched,
    fix_opened_30: opened.length,
    step_scan_notices_30: scans.length,
    stuck_duties: redDuties.length,
    starts_waiting: input.waiting.length,
    parked_now: input.parked.filter(entry => entry.resumedAt === undefined).length,
  };
  flagged.push({ kind: "minutes", excerpt: `${clean} of the last 30 minutes ran clean. The Mac read usable in ${usable} of ${fed} minutes with a pressure reading ` +
    `(${harness} unusable minutes on the harness side, ${other} on the app or owner side, ${unwatched} with no watch line); a start, wake or parked job was held over ` +
    `10 min in ${held}; a turn sat queued with ${FREE_SLOTS} or more free slots in ${freeSlot}.` });
  if (dirty.length) flagged.push({ kind: "dirty_minutes", excerpt: dirty.slice(-10).join("; ") });
  for (const hold of queueHolds.sort((a, b) => a.from - b.from).slice(0, 12)) {
    flagged.push({ kind: "queue_hold", item: hold.what, excerpt: `${hold.what} waited ${minutes(hold.to - hold.from)} min${hold.from - (input.log.firstAt ?? -Infinity) < MINUTE ? " or more (held when the log read starts)" : ""}, ${clock(hold.from)} to ${clock(hold.to)}.` });
  }
  if (input.waiting.length) flagged.push({ kind: "waiting_now", excerpt: `${input.waiting.length} starts wait in the fleet budget now` +
    `${input.waiting.some(ask => ask.since !== undefined) ? "" : " (the service does not publish when each asked yet, so only the log's holds count)"}.` });
  for (const fix of churn) flagged.push({ kind: "fix_churn", chat: fix.chat, item: fix.job,
    excerpt: `${fix.job} (${fix.chat}/${fix.duty}) opened ${clock(fix.at)} and ended ${minutes(fix.died!.at - fix.at)} min later: ${fix.died!.why}.` });
  const reopened = new Map<string, number>();
  for (const fix of opened) reopened.set(`${fix.chat}/${fix.duty}`, (reopened.get(`${fix.chat}/${fix.duty}`) ?? 0) + 1);
  const many = [...reopened].filter(([, count]) => count > 1);
  if (many.length) flagged.push({ kind: "reopened", excerpt: `Duties that opened more than one fix job in 30 min: ${many.map(([key, count]) => `${key} ${count}`).join(", ")}.` });
  if (scans.length) flagged.push({ kind: "step_scan", excerpt: `${scans.length} step scan notices in 30 min: ${scans.slice(-6).map(scan => `${clock(scan.at)} ${scan.chat} ${scan.steps.join(", ")}`).join("; ")}.` });
  for (const entry of stuck) flagged.push({ kind: "stuck_steps", item: entry.chat.id, excerpt: `${entry.chat.name}: ${entry.value} open steps nobody moves, from its check-in at ${clock(entry.at!)}.` });
  for (const line of redDuties) flagged.push({ kind: "stuck_duty", excerpt: line });
  return { metrics, flagged };
}

/** The last `bytes` of a file as lines, the first (cut) line dropped. */
async function tailLines(file: string, bytes: number): Promise<string[]> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const from = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - from);
    await handle.read(buffer, 0, buffer.length, from);
    const lines = buffer.toString("utf8").split("\n");
    return from > 0 ? lines.slice(1) : lines;
  } finally { await handle.close(); }
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown;

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("whole-system: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const dataDir = chatDataDir();
  const poolDir = join(homedir(), ".config", "pi-pool");
  const watch = await readWatch(dataDir, now - 2 * WINDOW_MS, now);
  const names = new Map<string, string>();
  for (const line of watch) for (const tree of [...line.top, ...line.trees ?? []]) if (tree.root && tree.tree) names.set(tree.root, tree.tree);
  const config = await readJson(join(poolDir, "config.json")) as { mac_working_max?: number } | null;
  const fleet = parseFleetState(await readFile(join(dataDir, FLEET_STATE_FILE), "utf8").catch(() => null));
  const parked = await readJson(join(dataDir, "queue-parked.json"));
  const listed = await readJson(join(dataDir, "chats.json")) as { ids?: unknown } | null;
  const ids = (Array.isArray(listed?.ids) ? listed.ids : []).filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id));
  const store = new DutyStore(dataDir);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  const chats: Inputs["chats"][number][] = [];
  for (const id of ids) {
    const file = await store.read(id);
    const paused = activePause(await settings.get(id), now) !== null;
    chats.push({ id, name: names.get(id) ?? id.slice(0, 8), runs: await store.runs(id),
      duties: [...paused ? [] : [{ id: CHECK_IN_DUTY_ID, name: "Check-in" }], ...file.duties.filter(duty => duty.status === "active").map(duty => ({ id: duty.id, name: duty.name }))] });
  }
  const result = measure({
    now, watch,
    log: readServiceLog(await tailLines(join(dataDir, "service.log"), LOG_TAIL_BYTES)),
    limits: readLimits(await tailLines(join(poolDir, "pi-pool.log"), LOG_TAIL_BYTES / 2)),
    okLimit: typeof config?.mac_working_max === "number" ? config.mac_working_max : 15,
    waiting: (fleet?.waiting ?? []) as Inputs["waiting"],
    parked: Array.isArray(parked) ? parked as Inputs["parked"] : [],
    chats,
  });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
