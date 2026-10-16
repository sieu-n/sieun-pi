import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { cutWords, readCut, tailLines, type CutCause } from "../../src/cut-end.ts";
import { activePause, checkInSettings } from "../../src/checkin-settings.ts";
import { BoardStore } from "../../src/chat-board-store.ts";
import { OPEN, walk } from "../../src/checkin-steps.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { readWatch, unusable, type WatchLine } from "../../src/mac-usable-watch.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import { CHECK_IN_DUTY_ID, type DutyRunRecord, type FlaggedSlice, type PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { CHANGE_APPROACH_MISSES, effectiveRun, missStreak } from "../../src/shared/duty-streak.ts";
import { isHarnessMinute } from "./mac-stays-usable.ts";

/**
 * The Whole system duty's precheck (`node --import tsx scripts/duties/whole-system.ts`), run every 30 minutes on the owner's 10-15 ask
 * ("reorganize duties have a 30 minute trigger that checks all this", mva1wt2h). It reads files the chat service and pi-pool already write and
 * makes no daemon call: the Mac usable watch, service.log, pi-pool.log and its config, and every chat's duty
 * runs. The headline is how many of the last 30 minutes ran clean: a minute is clean when the watch read the Mac usable, no start, wake or parked
 * job had waited over HOLD_MS, and no turn sat queued while pi-pool had FREE_SLOTS free slots. Supporting: queue holds and open steps nobody
 * moves in all chats. The rest is detail.
 * A job whose last turn was cut (`cutEnd`) and that got no new input since is a start that waits too: after the restart at 00:19:57Z on 10-16 the
 * fleet budget logged a continue for local agents checks, local agents recovery and daily code health report at 00:21:17Z, none reached its
 * session, and the check-in read them as moving or gone while the agents panel showed done. A cut job with a later input, such as a continue
 * that waits in pi-pool's queue, is not cut, so ordinary queueing never counts here.
 */

export const WINDOW_MS = 30 * 60_000;
const MINUTE = 60_000;
/** A start, wake or parked job waiting longer than this is a hold: the owner's line on 10-15, when 38 jobs' wakes sat held 3,374 times. */
export const HOLD_MS = 10 * MINUTE;
/** Free slots that make a queued turn a queue fault: two, so one slot a release just freed is not counted. */
export const FREE_SLOTS = 2;
/** A queued turn counts against free slots only once the oldest one waited this long, past pi-pool's admit poll. */
export const QUEUED_WAIT_S = 120;
/** The resume rule's look-back (resume_paused.py --since-minutes defaults to 1440): a job cut longer ago than this is left to its chat. */
export const CUT_LOOKBACK_MS = 24 * 60 * MINUTE;
/**
 * Job folders read at once by `findCutJobs`. At 06:48Z on 10-16 a one-at-a-time walk of 3,458 job folders, with each folder's rlm-subagent.json
 * read before its age check, took 106 s under load and the precheck hit its 60 s limit.
 */
const WALK_AT_ONCE = 16;
/** About 3 h of service.log at 10-16's rate (1.7 MB an hour, most of it held wakes), so a hold that began before the window is seen whole. */
const LOG_TAIL_BYTES = 6_000_000;

export interface Hold { what: string; from: number; to: number }
/** A continue or wake the fleet budget let through for a session (`starts after N s`): proof the start was admitted. */
export interface Grant { kind: string; session: string; at: number; waitS: number }
export interface LogFacts { holds: Hold[]; grants?: Grant[]; firstAt?: number }
/** A job session whose last turn was cut and that got no input since (`cutEnd`), found in a live chat's tree. */
export interface CutJob { session: string; name: string; chat: string; at: number; cause: CutCause; root?: { session: string; name: string } }
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface LimitChange { at: number; limit: number }

const TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const WAKE_HELD = /^wakes: wake (\w{8}) for .*: held by the fleet budget/;
const STARTED_AFTER = /^fleet budget: (\S+) (.+) starts after (\d+) s$/;
/** Lines of one wake held this far apart are one hold; the wake loop tries each held wake every tick. */
const HOLD_GAP_MS = 5 * MINUTE;

/** The holds in service.log lines from `since` on; a hold may start before `since`, so the caller reads back far enough. */
export function readServiceLog(lines: readonly string[]): LogFacts {
  const wakes = new Map<string, Hold>();
  const holds: Hold[] = [];
  const grants: Grant[] = [];
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
      if ((found[1] === "continue" || found[1] === "wake") && SESSION_ID.test(found[2]!)) grants.push({ kind: found[1], session: found[2]!, at, waitS: Number(found[3]) });
    }
  }
  const first = lines.find(line => TIME.test(line));
  return { holds, grants, ...(first ? { firstAt: Date.parse(TIME.exec(first)![1]!) } : {}) };
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
  !!line.queue && line.queue.queued > 0 && line.queue.oldestWaitS >= QUEUED_WAIT_S && line.queue.working <= limit - FREE_SLOTS;

export interface Inputs {
  now: number;
  watch: readonly WatchLine[];
  log: LogFacts;
  limits: readonly LimitChange[];
  /** pi-pool's limit when the Mac reads ok (`mac_working_max`). */
  okLimit: number;
  /** Every chat's duty runs, newest first, with its active duty ids (the check-in included unless paused). */
  chats: readonly { id: string; name: string; duties: readonly { id: string; name: string }[]; runs: readonly DutyRunRecord[] }[];
  /** Jobs in live chats whose last turn was cut and that got no input since (`cutEnd`). */
  cut?: readonly CutJob[];
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";
const minutes = (ms: number): number => Math.round(ms / MINUTE);

export function measure(input: Inputs): PrecheckOutput {
  const { now } = input;
  const start = now - WINDOW_MS;
  const flagged: FlaggedSlice[] = [];
  const queueHolds: Hold[] = [
    ...input.log.holds,
    ...(input.cut ?? []).map(job => ({ what: `cut job ${job.name} (${job.session})`, from: job.at, to: now })),
  ].filter(hold => hold.to - hold.from > HOLD_MS && hold.to >= start);
  const cutHeld = (input.cut ?? []).filter(job => now - job.at > HOLD_MS);
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
    stuck_steps_all: stuck.reduce((sum, entry) => sum + entry.value, 0),
    usable_min_30: usable,
    fed_min_30: fed,
    harness_unusable_min_30: harness,
    other_unusable_min_30: other,
    held_min_30: held,
    queued_free_slot_min_30: freeSlot,
    unwatched_min_30: unwatched,
    stuck_duties: redDuties.length,
    cut_jobs_held: cutHeld.length,
  };
  flagged.push({ kind: "minutes", excerpt: `${clean} of the last 30 minutes ran clean. The Mac read usable in ${usable} of ${fed} minutes with a pressure reading ` +
    `(${harness} unusable minutes on the harness side, ${other} on the app or owner side, ${unwatched} with no watch line); a start, wake or parked job was held over ` +
    `10 min in ${held}; a turn sat queued with ${FREE_SLOTS} or more free slots in ${freeSlot}.` });
  if (dirty.length) flagged.push({ kind: "dirty_minutes", excerpt: dirty.slice(-10).join("; ") });
  for (const hold of queueHolds.sort((a, b) => a.from - b.from).slice(0, 12)) {
    flagged.push({ kind: "queue_hold", item: hold.what, excerpt: `${hold.what} waited ${minutes(hold.to - hold.from)} min${hold.from - (input.log.firstAt ?? -Infinity) < MINUTE ? " or more (held when the log read starts)" : ""}, ${clock(hold.from)} to ${clock(hold.to)}.` });
  }
  for (const entry of stuck) flagged.push({ kind: "stuck_steps", item: entry.chat.id, excerpt: `${entry.chat.name}: ${entry.value} open steps nobody moves, from its check-in at ${clock(entry.at!)}.` });
  for (const line of redDuties) flagged.push({ kind: "stuck_duty", excerpt: line });
  for (const job of cutHeld.sort((a, b) => a.at - b.at)) {
    const grants = (input.log.grants ?? []).filter(grant => grant.session === job.session && grant.at >= job.at);
    const admitted = grants.map(grant => {
      const watched = input.watch.findLast(entry => Date.parse(entry.at) <= grant.at)?.queue;
      const slots = watched ? `, pi-pool then ran ${watched.working} of ${limitAt(input.limits, grant.at, input.okLimit)} slots with ${watched.queued} queued` : "";
      return `the fleet budget let its ${grant.kind} start at ${clock(grant.at)} after ${grant.waitS} s${slots}`;
    });
    flagged.push({ kind: "cut_job", chat: job.chat, item: job.session, excerpt: `${job.name} (${job.session}, chat ${job.chat}) was ${cutWords(job.cause)} at ` +
      `${clock(job.at)} and got no input in ${minutes(now - job.at)} min: ${admitted.length ? `${admitted.join("; ")}, and nothing reached the session` : "no continue or wake was let through for it"}.` });
  }
  return { metrics, flagged };
}

/**
 * Every job under the live chats' session folders (`session-artifacts/<chat>/sub-*` at any depth) whose transcript changed within CUT_LOOKBACK_MS
 * and ends cut (`cutEnd`). A child the chat deleted (deleted-jobs.json) or its parent deleted with rlm.delete_subagent is left out.
 */
export async function findCutJobs(artifacts: string, chats: readonly string[], deleted: Readonly<Record<string, Readonly<Record<string, number>>>>, now: number): Promise<CutJob[]> {
  const found: CutJob[] = [];
  // The lines of each parent transcript that call delete_subagent. A chat's transcript runs to 150 MB, so it is searched as bytes, once.
  const parents = new Map<string, Promise<string[]>>();
  const deleteLines = async (parentFile: string): Promise<string[]> => {
    const bytes = await readFile(parentFile).catch(() => Buffer.alloc(0));
    const lines: string[] = [];
    for (let at = bytes.indexOf("delete_subagent"); at >= 0; at = bytes.indexOf("delete_subagent", at + 1)) {
      const end = bytes.indexOf(10, at);
      lines.push(bytes.subarray(bytes.lastIndexOf(10, at) + 1, end < 0 ? bytes.length : end).toString("utf8"));
      if (end < 0) break;
      at = end;
    }
    return lines;
  };
  const deletedBy = async (parentFile: string, child: string): Promise<boolean> => {
    if (!parents.has(parentFile)) parents.set(parentFile, deleteLines(parentFile));
    return (await parents.get(parentFile)!).some(line => line.includes(child));
  };
  const jobOf = async (child: string, file: string): Promise<{ session: string; name: string }> => {
    const meta = await readJson(join(child, "rlm-subagent.json")) as { sessionName?: unknown } | null;
    return { session: file.slice(0, -".jsonl".length), name: typeof meta?.sessionName === "string" ? meta.sessionName : basename(child) };
  };
  // `root` is the folder and file of the chat's own job (its direct child) above the folder the walk reads; its name is read only for a cut.
  const walk = async (chat: string, folder: string, parentFile: string, root?: { child: string; file: string }): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && item.name.startsWith("sub-"));
    for (let index = 0; index < entries.length; index += WALK_AT_ONCE) {
      await Promise.all(entries.slice(index, index + WALK_AT_ONCE).map(async entry => {
        const child = join(folder, entry.name);
        const file = (await readdir(child).catch(() => [] as string[])).find(name => SESSION_ID.test(name.replace(/\.jsonl$/, "")) && name.endsWith(".jsonl"));
        if (!file) return;
        const path = join(child, file);
        await walk(chat, child, path, root ?? { child, file });
        if (deleted[chat]?.[entry.name] !== undefined) return;
        const changed = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
        if (now - changed > CUT_LOOKBACK_MS) return;
        const end = await readCut(path);
        if (!end || now - end.at > CUT_LOOKBACK_MS || await deletedBy(parentFile, entry.name)) return;
        const job = await jobOf(child, file);
        found.push({ ...job, chat, ...end, root: root ? await jobOf(root.child, root.file) : job });
      }));
    }
  };
  for (const chat of chats) await walk(chat, join(artifacts, chat), join(artifacts, "..", "sessions", `${chat}.jsonl`));
  return found;
}

/**
 * The cut jobs that hold owner work: an open step of the job's chat names the job or the chat's own job above it, by session id or job name.
 * A cut job no open step names waits for nobody. At 06:27Z on 10-16 the duty counted 40 cut jobs as holds, and 37 of them sat under no open
 * step: their steps were done, or a later job had taken the work (metal-inventory, cut 10-15 08:34Z, under metal dev environment and its r2).
 */
export function cutJobsHoldingWork(cut: readonly CutJob[], boards: ReadonlyMap<string, ChatBoard | null>): CutJob[] {
  const named = new Map<string, Set<string>>();
  for (const [chat, board] of boards) {
    const keys = new Set<string>();
    walk(board?.plan ?? [], item => {
      if (!OPEN.has(item.status)) return;
      if (item.sessionId) keys.add(item.sessionId);
      if (item.job) keys.add(item.job);
    });
    named.set(chat, keys);
  }
  return cut.filter(job => {
    const keys = named.get(job.chat);
    return !keys || [job, job.root ?? job].some(one => keys.has(one.session) || keys.has(one.name));
  });
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
  const listed = await readJson(join(dataDir, "chats.json")) as { ids?: unknown } | null;
  const ids = (Array.isArray(listed?.ids) ? listed.ids : []).filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id));
  const archivedFile = await readJson(join(dataDir, "archived-chats.json")) as { ids?: unknown } | null;
  const archived = new Set((Array.isArray(archivedFile?.ids) ? archivedFile.ids : []).filter((id): id is string => typeof id === "string"));
  const store = new DutyStore(dataDir);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  const chats: Inputs["chats"][number][] = [];
  for (const id of ids) {
    const file = await store.read(id);
    const paused = activePause(await settings.get(id), now) !== null;
    chats.push({ id, name: names.get(id) ?? id.slice(0, 8), runs: await store.runs(id),
      duties: [...paused ? [] : [{ id: CHECK_IN_DUTY_ID, name: "Check-in" }], ...file.duties.filter(duty => duty.status === "active").map(duty => ({ id: duty.id, name: duty.name }))] });
  }
  const live = ids.filter(id => !archived.has(id));
  const cut = await findCutJobs(join(dataDir, "..", "session-artifacts"), live,
    (await readJson(join(dataDir, "deleted-jobs.json")) ?? {}) as Record<string, Record<string, number>>, now);
  const boardStore = new BoardStore(dataDir);
  const boards = new Map(await Promise.all(live.map(async id => [id, await boardStore.read(id).catch(() => null)] as const)));
  const result = measure({
    now, watch,
    log: readServiceLog(await tailLines(join(dataDir, "service.log"), LOG_TAIL_BYTES)),
    limits: readLimits(await tailLines(join(poolDir, "pi-pool.log"), LOG_TAIL_BYTES / 2)),
    okLimit: typeof config?.mac_working_max === "number" ? config.mac_working_max : 15,
    chats,
    cut: cutJobsHoldingWork(cut, boards),
  });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
