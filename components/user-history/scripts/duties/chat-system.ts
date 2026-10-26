import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseAgentQueue, poolExecutable } from "../../src/chat-pool.ts";
import { heldByTodo, withLinkedBoards } from "../../src/shared/todo-hold.ts";
import { cancelHolds, JOB_CANCELS_FILE, parseJobCancels } from "../../src/job-cancels.ts";
import { planRiskSteps } from "../../src/checkin-findings.ts";
import { LIVE_GAP_MS, OPEN, parkedBy, walk } from "../../src/checkin-steps.ts";
import { listedSessions } from "../../src/daemon-faults.ts";
import { ownerChats } from "../../src/owner-chats.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import type { DutyRunRecord, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { D9_PUSH_PREFIX, serverNote } from "../../src/shared/chat-feed.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { CHANGE_APPROACH_MISSES, fixStepStreak, metricStreaks } from "../../src/shared/duty-streak.ts";
import { countWindowMs } from "../../src/duty-push.ts";
import { hasDoneLine, upkeepWords } from "../../src/shared/upkeep-title.ts";
import { stalledSince } from "../../src/shared/stalled-calls.ts";
import { transientTurnError, turnErrorCause } from "../../src/turn-error.ts";
import { turnError } from "../../src/shared/credential-wait.ts";
import { daemonSessions, dutyFleet, type FleetDuty } from "./duty-fleet.ts";
import { catalogCopyFiles, copyHosts, endsOnPoolWait, type HostHeldStep, mirroredSessions, planCounts, planInputs, POOL_TAIL_BYTES, stepSessions } from "./whole-system.ts";
import { loadHosts, selfHost } from "../../src/hosts.ts";
import { peerReach, readTailscaleStatus } from "../../src/host-reach.ts";
import { type AwayHost, hostHolds } from "../../src/shared/host-hold.ts";

/**
 * The precheck of the AI harness chat's Chat system duty (d9). The owner on 10-19 (msg mvfb7zt0): "plan should be tasks all eventually clear -
 * duties are things that need constant montiroing thus set a heartbeat ... ALL PLANS SHOULD BE EPHEMERAL ... keeping this compliant on it's own
 * your duty. 당분간은 몰래 실사 감시도 하고". Across the owner's chats on both boxes (one chat service holds every board) it counts the open steps
 * nobody moves (headline), the open plan items that are upkeep or have no done line, the share of green duties, and the red duties with no live
 * fix job, and the red duties whose live fix job does not move the number. Each metric flags at most 3 examples, spread over chats, and the detail file next to OUTPUT_FILE lists them all. Each run also
 * picks one chat not yet audited this cycle (`spotPick`) for the duty job's quiet spot audit and writes that chat's files and the owner's last messages in it there.
 */

/** Examples per metric in the flagged slices; the detail file lists every item. The owner's c75 shape for a duty run's summary. */
const EXAMPLES = 3;
/** The owner messages of the spot audit chat the detail quotes, newest last. */
const OWNER_MESSAGES = 8;
/** How much of a transcript's end the spot audit reads for those messages: the AI harness chat's last 3 MB held 42 user lines on 10-19. */
const TRANSCRIPT_TAIL_BYTES = 4_000_000;
const MIRROR_DIR = join(homedir(), ".cache/sieun-pi/hosts");
const run = promisify(execFile);

/** An open plan item that breaks the plan rule (board skill, references/plan-and-duties.md): its chat, id, title and the reason. */
export interface PlanFlag { chat: string; id: string; text: string; why: string }


/** The open items of a chat's plan that are upkeep, a standing risk, or a step with no done line, each once. */
export function planUpkeep(chat: string, board: ChatBoard | null): PlanFlag[] {
  const risks = new Set(planRiskSteps(board).map(item => item.id));
  const found: PlanFlag[] = [];
  walk(board?.plan ?? [], item => {
    if (!OPEN.has(item.status)) return;
    const words = upkeepWords(item.text);
    const why = words ? `reads like upkeep ("${words.trim()}")` : risks.has(item.id) ? "holds a standing risk or a resolved alert" : hasDoneLine(item) ? null : "has no Done when line";
    if (why) found.push({ chat, id: item.id, text: item.text, why });
  });
  return found;
}

/** Up to `count` items, one chat at a time in turn, so the examples show as many chats as they can. */
export function spread<T extends { chat: string }>(items: readonly T[], count: number): T[] {
  const byChat = new Map<string, T[]>();
  for (const item of items) byChat.set(item.chat, [...byChat.get(item.chat) ?? [], item]);
  const queues = [...byChat.values()];
  const out: T[] = [];
  for (let round = 0; out.length < count && queues.some(queue => queue.length > round); round++) {
    for (const queue of queues) if (queue[round] && out.length < count) out.push(queue[round]!);
  }
  return out;
}

const quote = (text: string): string => `"${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`;
const show = (value: number): string => String(Math.round(value * 10) / 10);

/**
 * The owner's own messages in a transcript's last lines: user lines that no job, check-in or tool wrote ("[job] ...") and that the feed does not
 * read as a server or Prime note (`serverNote`), and his board picks. On 10-21 the 06:11Z spot audit of CI and RepoOps quoted 8 "owner's last
 * messages", and all 8 were Prime's <provider_quota_resumed> and restart notes.
 */
export function ownerMessages(lines: readonly string[], count: number): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const line of lines) {
    let entry: { timestamp?: string; message?: { role?: string; content?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = (typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (part as { text?: unknown }).text).filter(t => typeof t === "string").join(" ") : "").trim();
    if (!text || (text.startsWith("[") && !text.startsWith("[board] Owner")) || serverNote(text)) continue;
    out.push({ at: entry.timestamp ?? "", text: text.length > 600 ? `${text.slice(0, 599)}…` : text });
  }
  return out.slice(-count);
}

async function tail(file: string, bytes: number): Promise<string[]> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally { await handle.close(); }
}

/** A session file on this box, or this box's copy of another box's (src/host-catalogs.ts `mirrorPath`), with the box it runs on. */
function localCopy(file: string | undefined): { file: string; host: string } | undefined {
  if (!file) return undefined;
  if (existsSync(file)) return { file, host: "this box" };
  for (const host of (() => { try { return readdirSync(MIRROR_DIR); } catch { return []; } })()) {
    const copy = join(MIRROR_DIR, host, file);
    if (existsSync(copy)) return { file: copy, host };
  }
  return undefined;
}

/**
 * A red duty of the fleet, with the newest event time when every metric it misses is a windowed count that only ages out (`agingSince`), and
 * the lead metric's misses under its fix step with whether they moved (`underFix`, `fixStepStreak`).
 */
export type RedDuty = FleetDuty & { agingSince?: number; agingUntil?: number; underFix?: ReturnType<typeof fixStepStreak> };

/** The ids of the plan items above `id` on a board, nearest first: what a fix step's own number can be read from (`fixStepStreak`). */
export function itemsAbove(board: ChatBoard | null, id: string): string[] {
  const find = (items: readonly PlanItem[], path: readonly string[]): string[] | undefined => {
    for (const item of items) {
      if (item.id === id) return [...path].reverse();
      const found = find(item.children, [...path, item.id]);
      if (found) return found;
    }
    return undefined;
  };
  return find(board?.plan ?? [], []) ?? [];
}

/**
 * When a red duty misses only windowed counts with no new event since the run before (`MetricStreak.quietSince`, the duty runner's own quiet
 * read), the newest event any of them counts; otherwise undefined. Such a duty owes no fix job (`missLine` says to start none), but d9 listed
 * the AI harness chat's d10, repeat_corrections_7d 16 with every line before its fix, among its red examples, and its job pushed the chat for a
 * fix step on it at 07:50Z, 10:47Z and 14:12Z on 10-20. `runs` is the duty's own runs, newest first.
 */
export function agingSince(runs: readonly DutyRunRecord[]): number | undefined {
  const streaks = metricStreaks(runs);
  if (!streaks.length || streaks.some(streak => streak.quietSince === undefined)) return undefined;
  return Math.max(...streaks.map(streak => streak.quietSince!));
}

/**
 * When the last event an aging duty counts leaves its window (`countWindowMs` of each key), or undefined when a key names no window. The newest
 * event alone misled: at 22:25Z on 10-26 d9 said CI and RepoOps d5 aged out with its newest event at 02:35Z, and the chat read that as clearing
 * at 02:35Z on 10-27, while refused_lands_promotes_7d counts a refusal of 21:53Z on 10-25 until 21:53Z on 11-01.
 */
export function agingUntil(runs: readonly DutyRunRecord[]): number | undefined {
  if (agingSince(runs) === undefined) return undefined;
  let until = 0;
  for (const streak of metricStreaks(runs)) {
    const window = countWindowMs(streak.key);
    if (window === undefined) return undefined;
    until = Math.max(until, streak.quietSince! + window);
  }
  return until;
}

/** A red duty whose live fix job does not move its number, with the push line that asks its chat to replace that fix. */
export interface NotMoving { chat: string; duty: string; line: string }

/**
 * The red duties whose lead metric's fix step has a live job while the runs that named that step (`underFix`, `fixStepStreak`) missed it
 * CHANGE_APPROACH_MISSES or more times with no move toward the target since the first of them. A fix is judged on its own runs: a new step
 * starts its count, a new job on the same step does not. The whole-streak count read 8 at 01:00Z, 03:01Z and 05:01Z on 10-23, and after the 04:07Z
 * push SEO guy's p90, the root-cause step that replaced p83, read as not moving on the first run that named it, so each run asked to replace
 * the replacement. `MetricStreak.stuck` needs the same step and job, so a new job on an old step starts it again: on 10-22 api portal vp's d1
 * missed 42 runs while p52's job was too new for `stuck`, and p52 had been its fix since 10-21 06:11Z.
 * measured: over the 7,011 runs in the 118 runs files on 10-22, a missed metric with no move reached its target within 10 more runs 86% of the
 * time after 1 miss, 76% after 2, 67% after 3 and 32% after 12 or more.
 * A windowed count with no new event (`quietSince`) only waits, and a duty whose missed metrics' fix steps all wait on an open For you todo
 * (`FleetDuty.held`) waits on the owner and owes no new job.
 * When the runs read a number for the item the step works (`fixStepStreak` with `itemsAbove`), the move is judged on that number and the
 * line names it, since a count of goals or risks moves only when one clears.
 */
export function fixNotMoving(red: readonly RedDuty[], name: (chat: string) => string): NotMoving[] {
  return red.flatMap(duty => {
    const metric = duty.metric;
    const under = duty.underFix;
    if (duty.held || !duty.fix || metric?.fix?.step !== duty.fix || duty.agingSince !== undefined || metric.quietSince !== undefined || !under ||
      under.moved || under.misses < CHANGE_APPROACH_MISSES) return [];
    const worked = under.worked;
    const stall = worked ? `${worked.item}, the item ${duty.fix} works, read ${show(worked.to)} against ${show(worked.target)}, no closer than its ${show(worked.from)} when the first of those runs measured it`
      : `${show(metric.value)} against ${metric.op} ${show(metric.target)} and no closer than when ${duty.fix} began`;
    return [{ chat: duty.chat, duty: duty.duty, line: `${name(duty.chat)}: ${duty.name} (${duty.duty}) missed ${metric.key} ${metric.misses} runs in a row, ` +
      `${under.misses} of them under its fix step ${duty.fix}, ${stall}, ` +
      `while ${duty.fix} has a live job. Replace that fix: start a root-cause job with rlm.create_session that finds why ${duty.fix} does not move the number and fixes that cause, ` +
      `give it its own step with duty "${duty.duty}/${metric.key}", and close or drop ${duty.fix} with a note naming the new step` }];
  });
}

/** A catalog row as the boxes' copies keep it (session-copy.json and src/host-catalogs.ts `copyPath`), with the fields the push reads. */
export interface CatalogRow { sessionId: string; sessionName?: string; sessionFile?: string; activity?: string; lastActivityAt?: string; created?: string;
  lifecycle?: string; activeSessionId?: string; isRunningTools?: boolean; modified?: string }
/**
 * Whether a catalog row works now: its activity says so and it does not sit in one tool call past STALL_MS (`stalledSince`). On 10-23 d9 read
 * p919 as owned by the job "codex fhnyq29tw5 sign-in" while one glob of it over all of home ran 2 h 53 min.
 */
const rowWorks = (row: CatalogRow, now: number): boolean => row.activity === "working" && stalledSince(row, now) === undefined;
const ROOT_OF = /\/session-artifacts\/([0-9a-f-]{36})\//;
const ms = (iso: string | undefined): number => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : 0; };

/**
 * Each chat's jobs in the catalog copies of both boxes: by the chat id their file sits under, or, for a job started with `rlm.create_session`
 * (file under `sessions/`), by the board whose plan item names its session. At 13:57Z on 10-20 d9 counted the AI harness chat's d7 and Crawler
 * VP's d9 as stuck while their fix jobs on p814 and p865, both create_session jobs, showed "working" in the catalog.
 */
export function jobsByChat(rows: readonly CatalogRow[], boards: ReadonlyMap<string, ChatBoard | null> = new Map()): Map<string, CatalogRow[]> {
  const stepChat = new Map<string, string>();
  for (const [chat, board] of boards) walk(board?.plan ?? [], item => { if (item.sessionId) stepChat.set(item.sessionId, chat); });
  const out = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const chat = ROOT_OF.exec(row.sessionFile ?? "")?.[1] ?? stepChat.get(row.sessionId);
    if (chat) out.set(chat, [...out.get(chat) ?? [], row]);
  }
  return out;
}

/** What tells `goalsWithNoJob` that a step's owner is live: the precheck's own owner reads and both boxes' catalog rows. */
export interface OwnerReads {
  now: number; named: ReadonlyMap<string, readonly string[]>; jobs: readonly CatalogRow[];
  activity: ReadonlyMap<string, number>; waking: ReadonlySet<string>; poolWaiting: ReadonlySet<string>;
  /** The chat's steps its check-in held on an offline box that the owner is asked to bring back (`HostHeldStep`); absent: none. */
  onHost?: ReadonlySet<string>;
}

/**
 * The open goals with no live owner and not held on the owner's answer. A goal has a live owner when an open item under it has a job working
 * now or within LIVE_GAP_MS, asleep on a board.wake or waiting for its pi-pool slot. A Mac chat's jobs write their transcripts on the Mac, so
 * their catalog rows (by session id or by the step's job name) count too. A goal is held when an open For you todo links it (its step field or
 * `heldByTodo`, which reads a wait that names the todo) or an owner correction parks it (`parkedBy`), or when every open item under it is held
 * that way: owner rule c64 counts a step blocked only by an open For you todo as an end state, and frontend bro's p62 waits only on c40-parked
 * p52 and p31. On 10-20 the 06:16Z run pushed frontend bro on p208 and p272 and slack green guy on p179, whose
 * open steps each wait on an open todo (t39, t40, t28), and on 10-21 the 08:11Z and 08:23Z runs pushed metal-management on p91, whose goal and
 * only step p115 wait for "the owner's answer on For you t6". A goal with one held step and one step nobody moves still counts, as the
 * check-in's `ownerHeld` reads it, and so does a blocked wait on the owner with no todo, which the check-in counts as stuck (`owner_no_todo`).
 */
export function goalsWithNoJob(board: ChatBoard | null, reads: OwnerReads): PlanItem[] {
  const fresh = (at: number | undefined) => at !== undefined && reads.now - at <= LIVE_GAP_MS;
  const todos = board?.todos ?? [];
  const asked = new Set(todos.filter(todo => !todo.done && todo.step).map(todo => todo.step));
  const live = (item: PlanItem): boolean => {
    const sessions = stepSessions(item, reads.named);
    if (sessions.some(id => reads.waking.has(id) || reads.poolWaiting.has(id) || fresh(reads.activity.get(id)))) return true;
    return reads.jobs.some(row => (sessions.includes(row.sessionId) || (!!item.job && row.sessionName === item.job)) &&
      (rowWorks(row, reads.now) || fresh(ms(row.lastActivityAt))));
  };
  const held = (item: PlanItem): boolean => {
    if (asked.has(item.id) || heldByTodo(item, todos) || parkedBy(item) !== undefined || reads.onHost?.has(item.id)) return true;
    const open = item.children.filter(child => OPEN.has(child.status));
    return open.length > 0 && open.every(held);
  };
  return (board?.plan ?? []).filter(goal => {
    if (!OPEN.has(goal.status) || held(goal)) return false;
    let owned = false;
    walk([goal], item => { if (OPEN.has(item.status) && live(item)) owned = true; });
    return !owned;
  });
}

/**
 * `planCounts`' owner reads with both boxes' catalog rows of each chat's jobs added: a row's session wrote at its `lastActivityAt`, now when it
 * works, and it is a session of the job its name names. `ownerActivity` reads only this box's transcripts, so at 00:29Z on 10-20 the Mac chats
 * frontend bro (p201, p296) and mcp for chris (p3) read as red duties with no live fix while the Mac's rows showed those fix jobs working.
 */
export function withCatalogOwners(plan: { ownerActivity?: ReadonlyMap<string, number>; named?: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> },
  jobs: ReadonlyMap<string, readonly CatalogRow[]>, now: number): { ownerActivity: Map<string, number>; named: Map<string, Map<string, string[]>> } {
  const ownerActivity = new Map(plan.ownerActivity ?? []);
  const named = new Map([...plan.named ?? []].map(([chat, names]) => [chat, new Map([...names].map(([name, ids]) => [name, [...ids]]))]));
  for (const [chat, rows] of jobs) {
    const names = named.get(chat) ?? named.set(chat, new Map()).get(chat)!;
    for (const row of rows) {
      const at = rowWorks(row, now) ? now : ms(row.lastActivityAt);
      if (at > (ownerActivity.get(row.sessionId) ?? 0)) ownerActivity.set(row.sessionId, at);
      if (row.sessionName && !names.get(row.sessionName)?.includes(row.sessionId)) names.set(row.sessionName, [...names.get(row.sessionName) ?? [], row.sessionId]);
    }
  }
  return { ownerActivity, named };
}

/**
 * The stuck duties whose newest run with a job still owns the miss. That job works: it has no after-job measure, its session works or wrote
 * within LIVE_GAP_MS by either box's catalog row, after its cut when it has one, and its brief has it fix the miss or start the fix job. At
 * 01:2xZ on 10-20 the AI harness chat's check-in counted as stuck while its 01:19Z check-in job worked on the step its run flagged. A later run
 * that found that job still at work measured with no job of its own (STILL_WORKING), and a cut job goes on once pi-pool gives it a slot: at
 * 07:20Z on 10-22 d9 counted 5 stuck duties, and the jobs of all 5 (AI harness d5, d9 and d11, CI and RepoOps d2, Vent d1) were at work. Or that job was cut on a failed
 * model call and the run waits for its rerun (`rerunCut`), as the duty runner's push reads it: a cut run that no rerun names, which is no
 * rerun or whose cut is transient (`transientTurnError`). From 03:52Z to 06:16Z on 10-20 d9 counted its own d9, CI and RepoOps' d4 and frontend bro's check-in while their jobs waited for
 * pi-pool slots up to 07:23Z. A job whose transcript ends on a pool wait the runner has not recorded as a cut yet (`poolCut`) waits the same
 * way: at 07:01Z d9 counted CI and RepoOps' d4, whose 06:56Z verify job got a slot wait as its first reply and was parked to 08:16Z.
 * So does a job whose tree has a turn working or queued in pi-pool (`poolTrees`), as the duty runner's `treeWait` reads a subagent's wait: at
 * 16:03Z on 10-22 d9 counted Prospect feature bro's d2 while its 21:00 job waited on a subagent queued in pi-pool from 15:17Z to 16:05Z.
 */
export function withoutWorkingRuns<T extends { chat: string; duty: string }>(stuck: readonly T[], runs: ReadonlyMap<string, readonly DutyRunRecord[]>,
  rows: readonly CatalogRow[], now: number, poolCut: ReadonlySet<string> = new Set(), poolTrees: ReadonlySet<string> = new Set()): T[] {
  const at = new Map(rows.map(row => [row.sessionId, rowWorks(row, now) ? now : ms(row.lastActivityAt)] as const));
  return stuck.filter(entry => {
    const own = (runs.get(entry.chat) ?? []).filter(run => run.duty === entry.duty);
    const last = own.find(run => run.job !== undefined);
    const wrote = last?.job ? at.get(last.job.id) ?? 0 : 0;
    if (last && !last.after && now - wrote <= LIVE_GAP_MS && wrote > (last.cut?.at ?? 0)) return false;
    if (last?.job && !last.after && poolTrees.has(last.job.id)) return false;
    const cut = last?.cut ?? (last?.job && !last.after && poolCut.has(last.job.id) ? true : undefined);
    return !(cut && (last!.trigger !== "rerun" || cut === true || transientTurnError(cut.error)) && !own.some(run => run.rerunOf === last!.at));
  });
}

/** The jobs of the stuck duties' newest runs, with no after-job measure and no recorded cut, whose transcript on either box ends on a pool wait. */
async function poolCutJobs(stuck: readonly { chat: string; duty: string }[], runs: ReadonlyMap<string, readonly DutyRunRecord[]>,
  file: (id: string) => string | undefined): Promise<Set<string>> {
  const out = new Set<string>();
  for (const entry of stuck) {
    const last = (runs.get(entry.chat) ?? []).find(run => run.duty === entry.duty && run.job !== undefined);
    if (!last?.job || last.after || last.cut) continue;
    const copy = localCopy(file(last.job.id) ?? join(homedir(), ".prime/agent/sessions", `${last.job.id}.jsonl`));
    if (copy && endsOnPoolWait(await tail(copy.file, POOL_TAIL_BYTES))) out.add(last.job.id);
  }
  return out;
}

/** The sessions and trees with a turn working or queued in this box's pi-pool, which the Mac's jobs use too; empty when the pool does not answer. */
async function poolTrees(): Promise<Set<string>> {
  try {
    const queue = parseAgentQueue(JSON.parse((await run(poolExecutable(), ["queue", "--json"])).stdout));
    return new Set([...queue.working, ...queue.queued].flatMap(turn => [turn.session, turn.tree]));
  } catch { return new Set(); }
}

/**
 * One push the duty job sent a chat (`PUSHES_FILE`): when, the tag it put in the message, and the items it named. `session` is the chat's root
 * job the push went to in place of the chat (`downRoutes`).
 */
export interface Push { at: number; chat: string; tag: string; items: string[]; session?: string }
/**
 * How a push the last run's job sent went: whether its tag reached the chat's transcript, the chat answered after it, and a job started since.
 * `away` names the box the chat runs on when this box reads its transcript from a mirror copy and Tailscale reads that box offline: the push
 * sits in the queue until the box answers, so a second send only queues a duplicate. On 10-24 the 13:19Z run flagged both 11:25Z pushes to
 * frontend bro as never delivered and asked for them again while the Mac sat offline for 7 hours with its steps held on For you t30.
 */
export interface PushCheck { push: Push; delivered: boolean; read: boolean; jobStarted: boolean; away?: string; settled?: boolean }

/**
 * Whether every step a push named has closed on the chat's board since, or waits on an open For you todo (`heldByTodo`): then the chat acted
 * and owes no followup. On 10-24 the 23:10 run asked to steer ops guy again about p475, which the chat had dropped as a duplicate of p450,
 * whose job sleeps on a wake, and the 20:53Z run asked to steer ops guy again about p518, which waited only on the owner's t34.
 */
export function pushSettled(board: ChatBoard | null, items: readonly string[]): boolean {
  if (!items.length || !board) return false;
  const steps = new Map<string, PlanItem>();
  walk(board.plan, item => { steps.set(item.id, item); });
  return items.every(id => {
    const step = steps.get(id);
    return step !== undefined && (!OPEN.has(step.status) || heldByTodo(step, board.todos));
  });
}

/**
 * The transcript a push went to. A push can go to a session that is no owner chat, like the release owner 01a10810 or the metal box owner
 * 01a11d24, so it is looked up in the catalog by its own id; on 10-20 the 15:57Z run read both 13:45Z pushes as never delivered, though
 * each sat in its transcript from 14:03Z.
 */
export function pushedFile(listed: ReadonlyMap<string, { file?: string }>, copies: readonly string[], chat: string): string | undefined {
  return listed.get(chat)?.file ?? listedSessions(copies, [chat]).get(chat)?.file;
}

/**
 * The tagged push in a chat's transcript lines: delivered when an agent message or a user message carries the tag, read when an assistant line
 * comes after it. The server sends d9's pushes itself since ce020858, and they land as user messages: the 07:02Z run on 10-23 read all 7 of
 * the 05:01Z pushes as not delivered, while the AI harness chat's transcript held its push as a user line from 05:01:46Z.
 */
export function pushReached(lines: readonly string[], tag: string): { delivered: boolean; read: boolean } {
  let delivered = false;
  for (const line of lines) {
    if (!delivered) { if ((line.includes('"agent_message"') || line.includes('"role":"user"')) && line.includes(tag)) delivered = true; continue; }
    if (line.includes('"role":"assistant"') && !line.includes('"stopReason":"error"')) return { delivered, read: true };
  }
  return { delivered, read: false };
}

/**
 * A chat that cannot take a turn: every model turn it took since `since` failed, and `cause` names why (`turnErrorCause`, with its pi-pool
 * selection when that is Manual). A push to it lands in its transcript and nobody reads it. From 10-24 to 10-26 d9 pushed frontend bro 6 times
 * on p330, p332 and p333 while every turn of it since 10-23 09:12Z ended on "Provider rate limit exceeded (rate_limit_error, 429) ...
 * pi-pool: Manual f6cee98e-... remains selected.", since `pi-pool use` had pinned it to claude8@slack.green, limited until 10-29 02:00Z.
 */
export interface ChatDown { chat: string; since: number; turns: number; cause: string }

/**
 * The failed model turns at the end of a transcript's lines: those after its last assistant message that did not fail, when the last one
 * failed and the first of them is LIVE_GAP_MS old or older, the longest quiet a working session shows between model calls, so a turn in
 * Prime's provider retry does not read as down.
 */
export function failingTurns(lines: readonly string[], now: number): { since: number; turns: number; error: string; provider?: string } | undefined {
  let failed: { since: number; turns: number; error: string; provider?: string } | undefined;
  for (const line of lines) {
    if (!line.includes('"role":"assistant"')) continue;
    let entry: { type?: string; timestamp?: string; message?: { role?: string; stopReason?: string; errorMessage?: unknown; diagnostics?: unknown; provider?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason !== "error") { failed = undefined; continue; }
    const provider = typeof entry.message.provider === "string" ? { provider: entry.message.provider } : {};
    failed = { since: failed?.since ?? ms(entry.timestamp), turns: (failed?.turns ?? 0) + 1, error: turnError(entry.message) ?? "error", ...provider };
  }
  return failed && now - failed.since >= LIVE_GAP_MS ? failed : undefined;
}

/** A Manual pi-pool selection from `pi-pool who --json --session <id>`, with its account and when its slot comes; undefined for Auto or a reply it cannot read. */
export function manualSelection(who: unknown, provider: string): string | undefined {
  const entry = (who as { providers?: Record<string, { selection?: { mode?: unknown; account_id?: unknown }; current?: { email?: unknown }; wait?: { slot_at?: unknown } | null }> })
    ?.providers?.[provider];
  if (entry?.selection?.mode !== "manual") return undefined;
  const account = typeof entry.current?.email === "string" ? entry.current.email : String(entry.selection.account_id ?? "an account");
  const slot = typeof entry.wait?.slot_at === "number" ? `, whose pi-pool slot comes at ${new Date(entry.wait.slot_at * 1000).toISOString().slice(0, 16)}Z` : "";
  return `Manual ${account}${slot}`;
}

/** The `chat_down` line of a chat that cannot take a turn, which the detail file's push list and the flagged slices open with. */
export const downLine = (down: ChatDown, name: string): string => `chat_down: ${name} has failed every turn since ` +
  `${new Date(down.since).toISOString().slice(0, 16)}Z (${down.cause}), ${down.turns} failed ${down.turns === 1 ? "turn" : "turns"}; d9 sent it no push this run. ` +
  "Ask the owner on For you to bring it back, or move its steps to a chat that runs, and push it nothing until it takes a turn";

/**
 * An open step nobody moves: its id and title, or only a count when the chat's check-in named no ids. `waitsOn` is the open step of the same
 * chat that its blocked wait names (`waitsOnStep`), whose live job it can name as its own.
 */
export interface StuckStep { chat: string; id?: string; text?: string; count?: number; waitsOn?: string }

/** The other open step of the board that a blocked step's waitFor names, such as CI and RepoOps' p361 waiting for p368 on 10-24. */
export function waitsOnStep(board: ChatBoard | null, id: string): string | undefined {
  const items = new Map<string, PlanItem>();
  walk(board?.plan ?? [], item => { items.set(item.id, item); });
  const step = items.get(id);
  if (step?.status !== "blocked") return undefined;
  return (step.waitFor?.match(/\bp\d+\b/g) ?? []).find(named => named !== id && OPEN.has(items.get(named)?.status ?? "done"));
}

/** The push d9 sends a down chat's root job straight: the chat, the job's session and name, and the stuck steps it owns. */
export interface JobPush { chat: string; session: string; job: string; steps: StuckStep[] }

/**
 * A down chat's stuck step that no push can reach: its job is a subagent of the chat, its root job runs on a box Tailscale reads offline, or it
 * names no job session at all. `call` is the one rlm.create_session call that moves it to a new root job on this box, whose brief has the job
 * claim the step on the board first.
 */
export interface StepMove { chat: string; id: string; text: string; why: string; job: string; call: string }

/** What `downRoutes` reads: the boards, the job names' sessions, both boxes' catalog rows with the box each runs on, the offline boxes and the data dir. */
export interface RouteReads { boards: ReadonlyMap<string, ChatBoard | null>; named: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>; rows: readonly CatalogRow[];
  chats: ReadonlySet<string>; cancelled: ReadonlySet<string>; hostOf?: ReadonlyMap<string, string | null>; away?: ReadonlySet<string>; dataDir?: string }

/** The board-apply command a job runs on a chat's board. */
const boardApply = (chat: string, dataDir: string): string =>
  `cd /home/sieun/.local/share/sieun-pi-chat/current/components/user-history && node --import tsx scripts/board-apply.ts ${chat} '<ops>' --data-dir ${dataDir}`;

/** The brief of the root job that takes over a down chat's step: the owner's rule, the step, how to claim it and how to work it with no chat to report to. */
export function moveBrief(input: { chat: string; chatName: string; item: PlanItem; job: string; dataDir: string }): string {
  const { chat, chatName, item, job } = input;
  return [`Owner's words (10-19): "the Chat (and Chat-check-in) MUST BE DESIGNED SO THAT IT ACTIVELY PERSUES AND CLEARS ALL THE TASKS."`, "",
    `You are the job "${job}" of the chat "${chatName}" (${chat}), started by the chat system duty (d9) because that chat fails every turn and nothing moves its step ${item.id}.`,
    `Step ${item.id}: "${item.text}".`, ...item.note ? [`Its note: ${item.note}`] : [], ...item.waitFor ? [`It waits for: ${item.waitFor}`] : [], "",
    `1. First claim the step: run \`${boardApply(chat, input.dataDir)}\` with the ops [{"op":"plan_update","id":"${item.id}","job":${JSON.stringify(job)},"sessionId":"<your own session id>"}].`,
    `2. Work the step to its Done when line, and keep its note current with the same command after each milestone.`,
    `3. Put any ask of the owner on For you, close the step only on the evidence its Done when line names, and send the chat nothing, since nobody reads it until it takes a turn.`,
    `4. Follow the repo's AGENTS.md, write in English and follow the unslop skill.`].join("\n");
}

/**
 * Where d9's push goes for each stuck step of a chat that cannot take a turn (`down`). A step whose job is a root session (a file under
 * sessions/, no owner chat, no Stop or Archive that still holds) on a box that answers gets the push straight, per job (`pushes`). Every other
 * step with an id gets a `StepMove` (`moves`). A step's job is its sessionId or the sessions its job name names (`stepSessions`), the newest
 * by its catalog row. d9 pushes a down chat nothing, so until 10-26 such a step had no one to wake its job: frontend bro's job "5180 creators
 * cold load" ended idle at 10:13Z with p330 open while the chat failed every turn on a 429, and the 12:24Z run's job steered it by hand. At
 * 14:19Z its p334, p339 and p340 belonged to subagents of the chat on the Mac, which Tailscale read offline, and the run's job moved them by hand.
 */
export function downRoutes(stuck: readonly StuckStep[], down: ReadonlySet<string>, reads: RouteReads, name: (chat: string) => string = chat => chat.slice(0, 8)):
  { pushes: JobPush[]; moves: StepMove[] } {
  const out = new Map<string, JobPush>();
  const moves: StepMove[] = [];
  for (const step of stuck) {
    if (!step.id || !down.has(step.chat)) continue;
    let item: PlanItem | undefined;
    walk(reads.boards.get(step.chat)?.plan ?? [], candidate => { if (candidate.id === step.id) item = candidate; });
    if (!item) continue;
    const ids = stepSessions(item, reads.named.get(step.chat) ?? new Map());
    const owners = reads.rows.filter(row => ids.includes(row.sessionId)).sort((a, b) => ms(b.lastActivityAt) - ms(a.lastActivityAt));
    const roots = owners.filter(row => !!row.sessionFile && !ROOT_OF.test(row.sessionFile) && !reads.chats.has(row.sessionId) && !reads.cancelled.has(row.sessionId));
    const host = (row: CatalogRow): string | null => reads.hostOf?.get(row.sessionId) ?? null;
    const root = roots.find(row => { const box = host(row); return box === null || !reads.away?.has(box); });
    if (root) {
      const push = out.get(root.sessionId) ?? out.set(root.sessionId, { chat: step.chat, session: root.sessionId, job: item.job ?? root.sessionName ?? root.sessionId, steps: [] }).get(root.sessionId)!;
      push.steps.push(step);
      continue;
    }
    const offline = roots.map(host).find(box => box !== null);
    const why = offline ? `its root job runs on ${offline}, which Tailscale reads offline` : owners.some(row => ROOT_OF.test(row.sessionFile ?? ""))
      ? "its job is a subagent of the chat, which only the chat can wake" : "it names no job session that can be woken";
    const job = `${name(step.chat)} ${item.id} job`;
    const brief = moveBrief({ chat: step.chat, chatName: name(step.chat), item, job, dataDir: reads.dataDir ?? "/home/sieun/.prime/agent/browser-chat" });
    moves.push({ chat: step.chat, id: item.id, text: item.text, why, job, call: `await rlm.create_session(${JSON.stringify(brief)}, name=${JSON.stringify(job)})` });
  }
  return { pushes: [...out.values()], moves };
}

/** The line of a move_step item, in the flagged slice and the detail file: the step, why no push reaches it, and the one call that moves it. */
const moveLine = (move: StepMove, chat: string): string => `${chat}: ${move.id} ${quote(move.text)} is stuck in a chat that cannot take a turn, and ${move.why}, ` +
  `so no push reaches it. Move it to a new root job with this one call, whose brief has the job claim ${move.id} on the board: ${move.call}`;

/** The line that names a job push, in the flagged slice and the detail file. */
const jobPushLine = (push: JobPush, chat: string): string => `${chat}'s chat cannot take a turn, so d9 sent its job "${push.job}" (${push.session}) ` +
  `the push about ${push.steps.map(step => step.id).join(", ")} straight`;

/** The text of each job push, tagged like the chat pushes, as a tell to the job's session. */
export function jobPushTells(pushes: readonly JobPush[], tag: string, name: (chat: string) => string): { chat: string; session: string; text: string }[] {
  return pushes.map(push => ({ chat: push.chat, session: push.session, text: `${tag} The chat system duty (d9) found ${push.steps.length === 1 ? "this open step of your chat " + name(push.chat) + ", which names you as its job, and nobody moves it"
    : "these open steps of your chat " + name(push.chat) + ", which name you as their job, and nobody moves them"}: ${push.steps.map(stuckItem).join(", ")}. ` +
    "Your chat fails every turn, so d9 sends this to you and not to it, and nobody reads what you send it. Work each step to its Done when line now, " +
    "keep its note on the board current with board-apply, put any ask of the owner on For you, and do not wait for your chat's answer." }));
}

/** The pushes.jsonl line of each job push: its chat, the job's session and the steps it names. */
export const jobPushRecords = (pushes: readonly JobPush[], tag: string, at: number): Push[] =>
  pushes.map(push => ({ at, chat: push.chat, session: push.session, tag, items: push.steps.flatMap(step => step.id ? [step.id] : []) }));

export interface ChatSystemFacts {
  names: ReadonlyMap<string, string>;
  stuck: readonly StuckStep[];
  upkeep: readonly PlanFlag[];
  fleet: { pct: number; red: readonly RedDuty[] };
  stuckDuties: readonly { chat: string; line: string }[];
  /** The open steps and red duties held on an offline box that a For you todo asks the owner to bring back (`HostHeldStep`), by chat id; absent: none. */
  hostHeld?: readonly { chat: string; id: string; host: string; todo: string; duty?: string }[];
  /** Per chat, the open goals with no live job (`goalsWithNoJob`) the run's job pushes it on, beside its stuck duties. */
  idleGoals: readonly { chat: string; goals: readonly PlanItem[] }[];
  /** The pushes the last run's job sent, as they went. */
  followUps: readonly PushCheck[];
  /** The chats on the push list or the follow-ups that cannot take a turn; d9 sends them no push. */
  down?: readonly ChatDown[];
  /** The pushes d9 sends straight to the root jobs of down chats' stuck steps (`downRoutes`). */
  jobPushes?: readonly JobPush[];
  /** The down chats' stuck steps no push reaches, each with the call that moves it to a new root job (`downRoutes`). */
  stepMoves?: readonly StepMove[];
  detail: string;
}

/** How many runs in a row a red duty missed, in words; a duty red on skipped runs' measures alone says so (`FleetDuty.skipped`). */
export const missRuns = (duty: Pick<RedDuty, "misses" | "skipped">): string =>
  `${duty.misses} ${duty.skipped ? "skipped " : ""}${duty.misses === 1 ? "run" : "runs in a row"}`;
/** The precheck output from the facts: the five metrics, and per metric a count line with the detail path and up to 3 examples. */
export function chatSystemOutput(facts: ChatSystemFacts): PrecheckOutput {
  const name = (chat: string): string => facts.names.get(chat) ?? chat.slice(0, 8);
  const stuckCount = facts.stuck.reduce((sum, entry) => sum + (entry.count ?? 1), 0);
  const down = new Set((facts.down ?? []).map(entry => entry.chat));
  const flagged: FlaggedSlice[] = (facts.down ?? []).map(entry => ({ kind: "chat_down", chat: entry.chat, excerpt: `${downLine(entry, name(entry.chat))}.` }));
  for (const push of facts.jobPushes ?? []) flagged.push({ kind: "job_push", chat: push.chat, excerpt: `${jobPushLine(push, name(push.chat))}; send it nothing again.` });
  for (const move of facts.stepMoves ?? []) flagged.push({ kind: "move_step", chat: move.chat, item: move.id, excerpt: moveLine(move, name(move.chat)) });
  const head = (kind: string, count: number, what: string, chats: number) => {
    if (count) flagged.push({ kind, excerpt: `${count} ${what} in ${chats} ${chats === 1 ? "chat" : "chats"}; every one is in ${facts.detail}.` });
  };
  const chats = (items: readonly { chat: string }[]) => new Set(items.map(item => item.chat)).size;
  head("stuck_steps", stuckCount, "open steps nobody moves", chats(facts.stuck));
  for (const entry of spread(facts.stuck, EXAMPLES)) {
    flagged.push({ kind: "stuck_steps", chat: entry.chat, ...entry.id ? { item: entry.id } : {},
      excerpt: entry.id ? `${name(entry.chat)}: ${entry.id} ${quote(entry.text ?? "")} is open and nobody moves it.` : `${name(entry.chat)}: ${entry.count} open steps nobody moves.` });
  }
  for (const group of hostGroups(facts.hostHeld ?? [])) {
    const one = group.steps.length === 1;
    const duties = group.steps.filter(step => step.duty !== undefined).length;
    const runs = !duties ? (one ? "its job runs" : "their jobs run") : duties === group.steps.length ? (one ? "its chat runs" : "their chats run")
      : `the ${duties === group.steps.length - 1 ? "step's job" : "steps' jobs"} and the ${duties === 1 ? "duty's chat" : "duties' chats"} run`;
    flagged.push({ kind: "host_held", excerpt: `${group.title}: ${runs} on ${group.host}, which Tailscale reads ` +
      `offline, and For you ${group.todo} asks the owner to bring it back, so ${one ? "it waits" : "they wait"} on his answer and push nothing; ` +
      `${one ? "it counts" : "they count"} as stuck again once the box answers and nothing moves ${one ? "it" : "them"}. ` +
      `Every one is in ${facts.detail}.` });
  }
  head("plan_upkeep", facts.upkeep.length, "open plan items that are upkeep or have no done line", chats(facts.upkeep));
  for (const item of spread(facts.upkeep, EXAMPLES)) flagged.push({ kind: "plan_upkeep", chat: item.chat, item: item.id, excerpt: `${name(item.chat)}: ${item.id} ${quote(item.text)} ${item.why}.` });
  head("red_duty", facts.fleet.red.length, "red duties", chats(facts.fleet.red));
  for (const duty of spread(facts.fleet.red.filter(duty => duty.agingSince === undefined), EXAMPLES)) {
    flagged.push({ kind: "red_duty", chat: duty.chat, item: duty.duty, excerpt: `${name(duty.chat)}: ${duty.name} (${duty.duty}) is red` +
      (duty.metric ? `, ${duty.metric.key} ${show(duty.metric.value)} against ${duty.metric.op} ${show(duty.metric.target)}` : "") + `, ${missRuns(duty)}.` });
  }
  const aging = facts.fleet.red.filter(duty => duty.agingSince !== undefined);
  if (aging.length) flagged.push({ kind: "aging_duty", excerpt: `${aging.map(duty => `${name(duty.chat)} ${duty.duty}`).join(", ")} ${aging.length === 1 ? "is" : "are"} red only on ` +
    "counts over a trailing window with no new event since the run before, which fall as old events leave the window; they owe no fix job, so push nothing for them." });
  head("stuck_duty", facts.stuckDuties.length, "red duties with no live fix job", chats(facts.stuckDuties));
  for (const duty of spread(facts.stuckDuties, EXAMPLES)) flagged.push({ kind: "stuck_duty", chat: duty.chat, excerpt: `${duty.line}.` });
  const notMoving = fixNotMoving(facts.fleet.red, name);
  head("fix_not_moving", notMoving.length, "red duties whose live fix job does not move the number", chats(notMoving));
  for (const duty of spread(notMoving, EXAMPLES)) flagged.push({ kind: "fix_not_moving", chat: duty.chat, item: duty.duty, excerpt: `${duty.line}.` });
  const pushes = pushList({ ...facts, notMoving }).filter(entry => !down.has(entry.chat));
  if (pushes.length) flagged.push({ kind: "push", excerpt: `${pushes.length} ${pushes.length === 1 ? "chat has" : "chats have"} a goal with no live job, an open step nobody moves, a red duty with no fix job ` +
    `or with a fix that does not move it, or a plan item that is upkeep or has no done line; ` +
    `message each one, as the push list in ${facts.detail} says.` });
  for (const check of facts.followUps.filter(check => check.away && !check.delivered)) {
    flagged.push({ kind: "push_queued", chat: check.push.chat, excerpt: `${name(check.push.chat)}: the last run's push ${check.push.tag} about ${check.push.items.join(", ")} ` +
      `waits in the queue, since the chat runs on ${check.away}, which Tailscale reads offline; it lands when the box answers, so send it nothing again.` });
  }
  for (const check of facts.followUps.filter(check => (!check.read || !check.jobStarted) && !(check.away && !check.delivered) && !check.settled && !down.has(check.push.chat))) {
    flagged.push({ kind: "push_followup", chat: check.push.chat, excerpt: `${name(check.push.chat)}${check.push.session ? ` job ${check.push.session}` : ""}: the last run's push ${check.push.tag} about ${check.push.items.join(", ")} ` +
      `${!check.delivered ? "never reached its transcript" : !check.read ? "reached it, but the chat has not answered" : "was read, but no job started since"}; steer it again.` });
  }
  return {
    metrics: { stuck_steps_all: stuckCount, plan_upkeep_all: facts.upkeep.length, duties_green_pct: facts.fleet.pct, stuck_duties: facts.stuckDuties.length,
      fix_not_moving: notMoving.length },
    flagged,
  };
}

/**
 * Per chat, what the run's job pushes it on: its open goals with no live job, its open steps nobody moves that are not those goals, its red
 * duties with no fix job or with a fix that does not move them (`fixNotMoving`), its red windowed counts with no lastEventAt (`unreadWindows`),
 * and its plan items that are upkeep or have no done line. Until 10-19 a chat with only plan items was on no push list, so no run messaged it:
 * at 20:22Z the 26 items sat in 6 chats, and 4 of those chats were on no list. Until 10-24 a chat with only stuck steps got no push either: at
 * 00:49Z CI and RepoOps' p361 (blocked, waitFor p368, no job) was the only stuck step, and the duty job linked it to p368's job by hand.
 */
export function pushList(facts: Pick<ChatSystemFacts, "idleGoals" | "stuckDuties" | "upkeep"> & { stuck?: readonly StuckStep[];
  lagging?: readonly { chat: string; line: string }[]; notMoving?: readonly NotMoving[] }):
  { chat: string; goals: readonly PlanItem[]; steps: StuckStep[]; duties: string[]; upkeep: PlanFlag[] }[] {
  const chats = new Map<string, { goals: readonly PlanItem[]; steps: StuckStep[]; duties: string[]; upkeep: PlanFlag[] }>();
  const at = (chat: string) => chats.get(chat) ?? chats.set(chat, { goals: [], steps: [], duties: [], upkeep: [] }).get(chat)!;
  for (const entry of facts.idleGoals) if (entry.goals.length) at(entry.chat).goals = entry.goals;
  for (const step of facts.stuck ?? []) if (!chats.get(step.chat)?.goals.some(goal => goal.id === step.id)) at(step.chat).steps.push(step);
  for (const duty of [...facts.stuckDuties, ...facts.lagging ?? [], ...facts.notMoving ?? []]) at(duty.chat).duties.push(duty.line);
  for (const item of facts.upkeep) at(item.chat).upkeep.push(item);
  return [...chats].map(([chat, entry]) => ({ chat, ...entry }));
}

/** Where each push d9 sends is recorded, one JSON line per message, for the next run to check. */
const PUSHES_FILE = join(homedir(), "work/plan-audit/pushes.jsonl");
/** Which chat each scheduled run spot-audited, one JSON line `{ at, chat }` per run, so `spotPick` can prefer the chats audited longest ago. */
const SPOT_PICKS_FILE = join(homedir(), "work/plan-audit/spot-picks.jsonl");

/**
 * The chat this run spot-audits: one at random among the chats in `ids` not yet picked in the current cycle, where a cycle closes once every
 * chat in `ids` has been picked. So each chat gets one audit per `ids.length` runs, in a new random order each cycle, and a chat new to `ids`
 * joins the open cycle. Until 10-26 it picked from all of `ids` each run, and the 10-25 21:40Z, 10-26 04:2xZ and 06:24Z runs all audited
 * "spec and monitoring system", whose plan was done and whose one duty was green, about 10 of 58 audits since 10-20.
 */
export function spotPick(ids: readonly string[], picks: readonly { at: number; chat: string }[], random: () => number = Math.random): string {
  const open = new Set<string>();
  for (const pick of [...picks].sort((a, b) => a.at - b.at)) {
    if (!ids.includes(pick.chat)) continue;
    open.add(pick.chat);
    if (open.size === new Set(ids).size) open.clear();
  }
  const due = ids.filter(id => !open.has(id));
  return due[Math.floor(random() * due.length)]!;
}

/** The held steps and duties grouped by box and todo, with the detail section's title: "41 steps and 1 red duty wait on mac, For you t96". */
export function hostGroups<T extends { host: string; todo: string; duty?: string }>(steps: readonly T[]): { host: string; todo: string; title: string; steps: T[] }[] {
  const groups = new Map<string, { host: string; todo: string; steps: T[] }>();
  for (const step of steps) {
    const key = `${step.host}\n${step.todo}`;
    (groups.get(key) ?? groups.set(key, { host: step.host, todo: step.todo, steps: [] }).get(key)!).steps.push(step);
  }
  const count = (n: number, one: string, many: string) => n ? [`${n} ${n === 1 ? one : many}`] : [];
  return [...groups.values()].map(group => {
    const duties = group.steps.filter(step => step.duty !== undefined).length;
    const words = [...count(group.steps.length - duties, "step", "steps"), ...count(duties, "red duty", "red duties")].join(" and ");
    return { ...group, title: `${words} ${group.steps.length === 1 ? "waits" : "wait"} on ${group.host}, For you ${group.todo}` };
  });
}

/**
 * This box's hosts.json name (the machine's hostname when hosts.json does not read) and the other boxes Tailscale reads offline now
 * (`peerReach`); none when hosts.json or Tailscale does not read.
 */
async function awayHosts(): Promise<{ self: string; away: AwayHost[] }> {
  try {
    const registry = await loadHosts();
    const status = await readTailscaleStatus();
    const self = selfHost(registry)?.name ?? hostname();
    return { self, away: status ? registry.hosts.flatMap(host => {
      const reach = host.name === self ? { online: true as const } : peerReach(status, host.address);
      return reach.online ? [] : [{ name: host.name, ...host.hostname ? { hostname: host.hostname } : {}, ...reach.lastSeen ? { lastSeen: reach.lastSeen } : {} }];
    }) : [] };
  } catch { return { self: hostname(), away: [] }; }
}

/** What a push asks of a chat, after the list of its items. */
const PUSH_ASK = "Give each goal a live job this turn, each open step nobody moves a live job, a For you todo or a close (a blocked step that waits for another " +
  "step of your chat can name that step's live job as its job), each red duty a fix job on a step linked to it, each red duty whose live fix does not move its number a " +
  "root-cause job that replaces that fix, each duty that reads as a lagging window lastEventAt in its precheck, and each listed plan item a \"Done when\" " +
  "note, a duty metric or a close. Reply in your own chat, not to d9.";

/** One stuck step in a push: its id and title with the step its wait names, or the count of a chat whose check-in named no ids. */
const stuckItem = (step: StuckStep): string => step.id
  ? `${step.id} ${quote(step.text ?? "")}${step.waitsOn ? ` (blocked on ${step.waitsOn}, so it can name ${step.waitsOn}'s live job)` : ""}`
  : `${step.count ?? 1} with no ids in its check-in`;

/** One chat's line of the push list: its idle goals, its stuck steps, its red duty lines and its upkeep items. */
export function pushItems(entry: ReturnType<typeof pushList>[number]): string {
  return [
    entry.goals.length ? `goals with no live job ${entry.goals.map(goal => `${goal.id} ${quote(goal.text)}`).join(", ")}` : "",
    entry.steps.length ? `open steps nobody moves ${entry.steps.map(stuckItem).join(", ")}` : "",
    ...entry.duties,
    entry.upkeep.length ? `plan items to give a "Done when" note, move into a duty metric or close: ${entry.upkeep.map(item => `${item.id} ${quote(item.text)} ${item.why}`).join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

/**
 * The pushes the server sends itself (`PrecheckOutput.tells`), so they go out on every run whatever the pool does. From 17:03Z on 10-22 to
 * 01:00Z on 10-23 no d9 push went out: the 20:09Z, 22:09Z and 00:10Z jobs each failed their first turn on "API key for provider anthropic is
 * temporarily unavailable", sat until the runner replaced them, and the runs between were skipped, so 8 chats whose fix did not move never
 * got the root-cause ask.
 */
/** The tag a run's pushes open with, `[d9 push <ISO minute>Z]`, which the feed reads as a server note by its prefix (`D9_PUSH_PREFIX`). */
export const pushTag = (now: number): string => `${D9_PUSH_PREFIX}${new Date(now).toISOString().slice(0, 16)}Z]`;

export function pushTells(pushes: ReturnType<typeof pushList>, tag: string): { chat: string; text: string }[] {
  return pushes.map(entry => ({ chat: entry.chat, text: `${tag} The chat system duty (d9) found these in your chat: ${pushItems(entry)}. ${PUSH_ASK}` }));
}

/**
 * Whether this precheck records its pushes in PUSHES_FILE: only a scheduled or verify run (PRECHECK_MODE "run"), the one whose tells the server
 * sends. An after-job measure or a hand run recorded pushes that never went out, so the next run flagged them as never delivered: on 10-23 the
 * 14:24Z after-job measure and a 14:31Z precheck the server never logged left 4 such lines for Crawler VP and the Railway chat, and the 00:35 KST job was asked to steer
 * both again about messages neither was ever sent.
 */
export const recordsPushes = (mode: string | undefined): boolean => mode === "run";

/**
 * The pushes.jsonl line of each push: the plan and duty ids it names. A red duty with no live fix reads "(duty field d4/commits_not_live)"
 * rather than "(d4)": until 10-26 its push recorded no item, so the 04:32 KST run asked to steer Slack green again "about " nothing.
 */
export function pushRecords(pushes: ReturnType<typeof pushList>, tag: string, at: number): { at: number; chat: string; tag: string; items: string[] }[] {
  return pushes.map(entry => {
    const items = [...entry.goals.map(goal => goal.id), ...entry.steps.flatMap(step => step.id ? [step.id] : []),
      ...entry.duties.flatMap(line => [...line.matchAll(/\((d\d+|checkin)\)|\(duty field (d\d+|checkin)\//g)].map(match => (match[1] ?? match[2])!)),
      ...entry.upkeep.map(item => item.id)];
    return { at, chat: entry.chat, tag, items: [...new Set(items)] };
  });
}

/** What the spot audit reads: the chat's board, its duties, the chat service's job list and agent_observe, never its transcript or session file (global rule). */
export function spotAuditLines(input: { spot: string; title: string; host?: string | undefined; dataDir: string; jobs: readonly CatalogRow[];
  log: string; asks: readonly { at: string; text: string }[] }): string[] {
  const { spot, dataDir } = input;
  const working = input.jobs.filter(row => row.activity === "working");
  return [
    `## Spot audit: ${input.title}`, "",
    `1. The chat is ${spot}, and it runs on ${input.host ?? "a box this box has no catalog copy for"}.`,
    `2. Its board is ${join(dataDir, "boards", `${spot}.json`)}: read its open plan, each step's note and requirements, and its todos.`,
    `3. Its duties are ${join(dataDir, "duties", `${spot}.json`)}, and their runs are ${join(dataDir, "duties", `${spot}.runs.jsonl`)}.`,
    `4. The chat service's job list holds ${input.jobs.length} jobs of it, ${working.length} working now` +
      `${working.length ? `: ${working.map(row => `${row.sessionName ?? row.sessionId.slice(0, 8)} (${row.sessionId})`).join(", ")}` : ""}.`,
    "5. Read each job's status with agent_observe where it can see the chat, and compare the board, the duties and the jobs with the owner's asks below.",
    "6. Fix what is off: a step that is upkeep, a step with no done line or no live owner, a duty that checks something the owner did not ask for or misses what he did, a red duty with no fix job (one this file marks as red only on counts that age out owes none), and an ask of his that nothing on the board carries.",
    `7. Append what you found and what you fixed to ${input.log}, under a heading with the time and the chat's name, and send the owner nothing.`, "",
    "The owner's last messages in it, newest last:", "",
    ...input.asks.length ? input.asks.map(ask => `- ${ask.at}: ${JSON.stringify(ask.text)}`) : ["- None found in its last 4 MB of messages."], "",
  ];
}

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);
const section = (title: string, lines: readonly string[]): string => [`## ${title}`, "", ...lines.length ? lines.map((line, index) => `${index + 1}. ${line}`) : ["None."], ""].join("\n");

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("chat-system: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const dataDir = chatDataDir();
  const detail = `${output.replace(/\.json$/, "")}.md`;
  const files = await catalogCopyFiles(dataDir);
  const copies = files.map(copy => copy.text);
  const ids = await ownerChats(dataDir);
  const listed = listedSessions(copies, ids);
  const names = new Map(ids.map(id => [id, listed.get(id)?.name ?? id.slice(0, 8)] as const));
  const plan = await planInputs(dataDir, now, names);
  const parsed = files.map(copy => { try { return { host: copy.host, rows: (JSON.parse(copy.text) as { rows?: CatalogRow[] }).rows ?? [] }; } catch { return { host: copy.host, rows: [] }; } });
  const rows = parsed.flatMap(copy => copy.rows);
  const jobs = jobsByChat(rows, plan.boards);
  const { self, away } = await awayHosts();
  const todos = [...plan.boards].flatMap(([chat, board]) => (board?.todos ?? []).map(todo => ({ chat, todo })));
  const owners = withCatalogOwners(plan, jobs, now);
  const owned = planCounts({ ...plan, ...owners, away: new Set(away.map(host => host.name)), hosts: copyHosts([...parsed, ...await mirroredSessions()], self), holds: hostHolds(away, todos) });
  const runsByChat = new Map(plan.chats.map(chat => [chat.id, chat.runs]));
  const poolCut = await poolCutJobs(owned.redDuties, runsByChat, id => listedSessions(copies, [id]).get(id)?.file);
  const counts = { ...owned, redDuties: withoutWorkingRuns(owned.redDuties, runsByChat, rows, now, poolCut, await poolTrees()) };
  const text = (chat: string, id: string): string | undefined => {
    let found: string | undefined;
    walk(plan.boards.get(chat)?.plan ?? [], item => { if (item.id === id) found = item.text; });
    return found;
  };
  const hostHeld = owned.hostHeld.map((step: HostHeldStep) => ({ chat: step.chat.id, id: step.id, host: step.host, todo: step.todo,
    text: step.duty ?? text(step.chat.id, step.id) ?? "", ...step.waitsOn ? { waitsOn: step.waitsOn } : {}, ...step.duty ? { duty: step.duty } : {} }));
  const stuck = counts.stuck.flatMap((entry): ChatSystemFacts["stuck"] => entry.items.length
    ? entry.items.map(id => { const waitsOn = waitsOnStep(plan.boards.get(entry.chat.id) ?? null, id);
      return { chat: entry.chat.id, id, text: text(entry.chat.id, id) ?? "", ...waitsOn ? { waitsOn } : {} }; })
    : [{ chat: entry.chat.id, count: entry.value }]);
  const upkeep = plan.chats.filter(chat => !plan.pausedChats.has(chat.id)).flatMap(chat => planUpkeep(chat.id, plan.boards.get(chat.id) ?? null));
  const fleet = await dutyFleet({ dataDir, now, sessions: daemonSessions });
  const runsOf = (chat: string, duty: string) => (runsByChat.get(chat) ?? []).filter(run => run.duty === duty);
  const red = fleet.duties.filter(duty => !duty.green && !duty.pending).map((duty): RedDuty => {
    const own = runsOf(duty.chat, duty.duty);
    const since = agingSince(own);
    const under = duty.fix && duty.metric ? { underFix: fixStepStreak(own, duty.metric.key, duty.fix, itemsAbove(plan.boards.get(duty.chat) ?? null, duty.fix)) } : {};
    const until = agingUntil(own);
    return { ...duty, ...under, ...since === undefined ? {} : { agingSince: since }, ...until === undefined ? {} : { agingUntil: until } };
  });
  // A wait that names another chat's open todo holds its step, wherever that chat runs (`withLinkedBoards`).
  const linked = (chat: string): ChatBoard | null => { const board = plan.boards.get(chat); return board ? withLinkedBoards(board, chat, plan.boards) : null; };
  const idleGoals = plan.chats.filter(chat => !plan.pausedChats.has(chat.id)).map(chat => ({ chat: chat.id, goals: goalsWithNoJob(linked(chat.id),
    { now, named: plan.named.get(chat.id) ?? new Map(), jobs: jobs.get(chat.id) ?? [], activity: plan.ownerActivity, waking: plan.waking, poolWaiting: plan.poolWaiting,
      onHost: new Set(hostHeld.filter(step => step.chat === chat.id).map(step => step.id)) }) }));
  // The pushes the last run's job sent: those recorded after the last run of this duty began (LAST_RUNS_FILE, newest first).
  const lastRuns = JSON.parse(await readFile(process.env.LAST_RUNS_FILE ?? "", "utf8").catch(() => "[]")) as DutyRunRecord[];
  const since = lastRuns.find(run => run.verdict !== "skipped")?.at;
  const sent = since === undefined ? [] : (await readFile(PUSHES_FILE, "utf8").catch(() => "")).split("\n").flatMap(line => {
    try { const push = JSON.parse(line) as Push; return push.at >= since ? [push] : []; } catch { return []; }
  });
  const followUps: PushCheck[] = [];
  for (const push of sent) {
    const file = localCopy(pushedFile(listed, copies, push.session ?? push.chat));
    const reached = file ? pushReached(await tail(file.file, TRANSCRIPT_TAIL_BYTES), push.tag) : { delivered: false, read: false };
    const offline = file && away.some(host => host.name === file.host) ? { away: file.host } : {};
    followUps.push({ push, ...reached, jobStarted: (jobs.get(push.chat) ?? []).some(row => ms(row.created) > push.at), ...offline,
      ...pushSettled(linked(push.chat), push.items) ? { settled: true } : {} });
  }
  const tag = pushTag(now);
  const name = (chat: string): string => names.get(chat) ?? chat.slice(0, 8);
  const notMoving = fixNotMoving(red, name);
  const listedPushes = pushList({ idleGoals, stuck, stuckDuties: counts.redDuties, lagging: owned.lagging, notMoving, upkeep });
  const down: ChatDown[] = [];
  for (const chat of new Set([...listedPushes.map(entry => entry.chat), ...followUps.map(check => check.push.chat)])) {
    const file = localCopy(pushedFile(listed, copies, chat));
    const failed = file ? failingTurns(await tail(file.file, TRANSCRIPT_TAIL_BYTES), now) : undefined;
    if (!failed) continue;
    const who = await run(poolExecutable(), ["who", "--json", "--session", chat]).then(out => JSON.parse(out.stdout) as unknown, () => undefined);
    const manual = manualSelection(who, failed.provider ?? "anthropic");
    down.push({ chat, since: failed.since, turns: failed.turns, cause: [turnErrorCause(failed.error), manual].filter(Boolean).join(", ") });
  }
  const pushes = listedPushes.filter(entry => !down.some(item => item.chat === entry.chat));
  const cancels = parseJobCancels(JSON.parse(await readFile(join(dataDir, JOB_CANCELS_FILE), "utf8").catch(() => "{}")));
  const hostOf = new Map<string, string | null>();
  for (const copy of parsed) for (const row of copy.rows) if (!hostOf.has(row.sessionId) || copy.host === null) hostOf.set(row.sessionId, copy.host);
  const routes = downRoutes(stuck, new Set(down.map(entry => entry.chat)), { boards: plan.boards, named: owners.named, rows, chats: new Set(ids), hostOf,
    away: new Set(away.map(host => host.name)), dataDir, cancelled: new Set(Object.entries(cancels).flatMap(([session, cancel]) => cancelHolds(cancel) ? [session] : [])) }, name);
  const direct = routes.pushes;
  const result = chatSystemOutput({ names, stuck, upkeep, fleet: { pct: fleet.metrics.duties_green_pct, red }, stuckDuties: counts.redDuties, idleGoals, followUps, down,
    jobPushes: direct, stepMoves: routes.moves, detail, hostHeld });
  const fleetMissing = fleet.flagged.filter(slice => slice.kind === "fleet_data_missing");
  result.flagged!.push(...fleetMissing);

  // The spot audit: one owner chat each run, the open cycle's next at random (`spotPick`), read by the duty job against what the owner asked in it.
  const picks = (await readFile(SPOT_PICKS_FILE, "utf8").catch(() => "")).split("\n").flatMap(line => {
    try { const pick = JSON.parse(line) as { at: number; chat: string }; return typeof pick.at === "number" && typeof pick.chat === "string" ? [pick] : []; } catch { return []; }
  });
  const spot = spotPick(ids, picks);
  const session = localCopy(listed.get(spot)?.file);
  const asks = session ? ownerMessages(await tail(session.file, TRANSCRIPT_TAIL_BYTES), OWNER_MESSAGES) : [];
  const log = join(homedir(), "work/plan-audit/spot", `${today(now)}.md`);
  await mkdir(join(homedir(), "work/plan-audit/spot"), { recursive: true });
  if (recordsPushes(process.env.PRECHECK_MODE)) await appendFile(SPOT_PICKS_FILE, JSON.stringify({ at: now, chat: spot }) + "\n");
  result.flagged!.push({ kind: "spot_audit", chat: spot, excerpt: `Spot audit this run: ${names.get(spot)} (${spot}). Its files and the owner's last messages in it are in ${detail}; ` +
    `log what you found to ${log}, and send the owner nothing.` });

  const md = [
    `# Chat system run of ${new Date(now).toISOString()}`, "",
    `stuck_steps_all ${result.metrics.stuck_steps_all}, plan_upkeep_all ${result.metrics.plan_upkeep_all}, duties_green_pct ${result.metrics.duties_green_pct}, ` +
      `stuck_duties ${result.metrics.stuck_duties}, fix_not_moving ${result.metrics.fix_not_moving}, over ${ids.length} chats.`, "",
    ...fleetMissing.map(slice => `${slice.excerpt}\n`),
    ...spotAuditLines({ spot, title: name(spot), host: session?.host, dataDir, jobs: jobs.get(spot) ?? [], log, asks }),
    `## Push list (${pushes.length} chats)`, "",
    ...down.map(entry => `${downLine(entry, name(entry.chat))}. Its push would have named: ${pushItems(listedPushes.find(item => item.chat === entry.chat) ?? { chat: entry.chat, goals: [], steps: [], duties: [], upkeep: [] }) || "only the last run's push"}.\n`),
    ...direct.map(push => `${jobPushLine(push, name(push.chat))}, tagged ${tag}, and ${PUSHES_FILE} records it. Send it nothing again.\n`),
    ...routes.moves.length ? [section(`Steps of a down chat to move to a new root job (${routes.moves.length})`, routes.moves.map(move => moveLine(move, name(move.chat))))] : [],
    `The server sent each chat below its push, tagged ${tag}, when this run's precheck ended, and ${PUSHES_FILE} records each one. Send none of them again. ` +
      "Follow up only where a chat's answer shows it did not act.", "",
    ...pushes.map((entry, index) => `${index + 1}. ${name(entry.chat)} (${entry.chat}): ${pushItems(entry)}.`), "",
    section(`Pushes the last run sent (${followUps.length})`, followUps.map(check => `${name(check.push.chat)}${check.push.session ? ` job ${check.push.session}` : ""}: ${check.push.tag} about ${check.push.items.join(", ")}, ` +
      `${check.delivered ? "delivered" : check.away ? `queued while ${check.away} is offline` : "not delivered"}, ${check.read ? "read" : "not read"}, ${check.settled ? "and every step it named has closed since" : check.jobStarted ? "a job started since" : "no job started since"}.`)),
    section(`Open steps nobody moves (${result.metrics.stuck_steps_all})`, stuck.map(entry => entry.id
      ? `${name(entry.chat)}: ${entry.id} ${quote(entry.text ?? "")}.` : `${name(entry.chat)}: ${entry.count} open steps nobody moves, with no ids in its check-in.`)),
    ...hostGroups(hostHeld).map(group => section(group.title, group.steps.map(step => `${name(step.chat)}: ${step.id} ${quote(step.text)}` +
      `${step.waitsOn ? `, which waits on ${step.waitsOn}` : ""}.`))),
    ...hostHeld.length ? [] : [section("Steps and red duties that wait on an offline box (0)", [])],
    section(`Open plan items that are upkeep or have no done line (${upkeep.length})`, upkeep.map(item => `${name(item.chat)}: ${item.id} ${quote(item.text)} ${item.why}.`)),
    section(`Red duties (${red.length}, ${fleet.metrics.duties_green_pct}% green)`, red.map(duty => `${name(duty.chat)}: ${duty.name} (${duty.duty}), ` +
      `${duty.metric ? `${duty.metric.key} ${show(duty.metric.value)} against ${duty.metric.op} ${show(duty.metric.target)}, ` : ""}${missRuns(duty)}` +
      `${duty.fix ? `, fix step ${duty.fix}` : duty.working ? `, its job ${duty.working} works on it` : ""}` +
      `${duty.agingSince !== undefined ? `, red only on counts that age out (newest event ${new Date(duty.agingSince).toISOString().slice(0, 16)}Z` +
        `${duty.agingUntil !== undefined ? `, clears at ${new Date(duty.agingUntil).toISOString().slice(0, 16)}Z` : ""}), so it owes no fix job` : ""}.`)),
    section(`Red duties with no live fix job (${counts.redDuties.length})`, counts.redDuties.map(duty => `${duty.line}.`)),
    section(`Red duty metrics that wait on the owner's open For you todo (${owned.ownerHeld.length})`, owned.ownerHeld.map(duty => `${duty.line}.`)),
    section(`Red duties whose live fix job does not move the number (${notMoving.length})`, notMoving.map(duty => `${duty.line}.`)),
    section(`Red windowed counts with no lastEventAt, read as lagging windows (${owned.lagging.length})`, owned.lagging.map(duty => `${duty.line}.`)),
  ].join("\n");
  await writeFile(detail, md);
  if ((pushes.length || direct.length) && recordsPushes(process.env.PRECHECK_MODE)) {
    await mkdir(dirname(PUSHES_FILE), { recursive: true });
    await appendFile(PUSHES_FILE, [...pushRecords(pushes, tag, now), ...jobPushRecords(direct, tag, now)].map(line => JSON.stringify(line) + "\n").join(""));
  }
  await writeFile(output, JSON.stringify({ ...result, tells: [...pushTells(pushes, tag), ...jobPushTells(direct, tag, name)] }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
