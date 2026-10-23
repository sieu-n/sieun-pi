import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseAgentQueue, poolExecutable } from "../../src/chat-pool.ts";
import { heldByTodo } from "../../src/checkin-end-state.ts";
import { planRiskSteps } from "../../src/checkin-findings.ts";
import { LIVE_GAP_MS, OPEN, parkedBy, walk } from "../../src/checkin-steps.ts";
import { listedSessions } from "../../src/daemon-faults.ts";
import { ownerChats } from "../../src/owner-chats.ts";
import { chatDataDir } from "../../src/owner-ok.ts";
import type { DutyRunRecord, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { serverNote } from "../../src/shared/chat-feed.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { CHANGE_APPROACH_MISSES, metricStreaks } from "../../src/shared/duty-streak.ts";
import { hasDoneLine, upkeepWords } from "../../src/shared/upkeep-title.ts";
import { daemonSessions, dutyFleet, type FleetDuty } from "./duty-fleet.ts";
import { catalogCopies, endsOnPoolWait, planCounts, planInputs, POOL_TAIL_BYTES, stepSessions } from "./whole-system.ts";

/**
 * The precheck of the AI harness chat's Chat system duty (d9). The owner on 10-19 (msg mvfb7zt0): "plan should be tasks all eventually clear -
 * duties are things that need constant montiroing thus set a heartbeat ... ALL PLANS SHOULD BE EPHEMERAL ... keeping this compliant on it's own
 * your duty. 당분간은 몰래 실사 감시도 하고". Across the owner's chats on both boxes (one chat service holds every board) it counts the open steps
 * nobody moves (headline), the open plan items that are upkeep or have no done line, the share of green duties, and the red duties with no live
 * fix job, and the red duties whose live fix job does not move the number. Each metric flags at most 3 examples, spread over chats, and the detail file next to OUTPUT_FILE lists them all. Each run also
 * picks one chat at random for the duty job's quiet spot audit and writes that chat's files and the owner's last messages in it there.
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

/** A red duty of the fleet, with the newest event time when every metric it misses is a windowed count that only ages out (`agingSince`). */
export type RedDuty = FleetDuty & { agingSince?: number };

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

/** A red duty whose live fix job does not move its number, with the push line that asks its chat to replace that fix. */
export interface NotMoving { chat: string; duty: string; line: string }

/**
 * The red duties whose lead metric's fix step has a live job while that metric missed CHANGE_APPROACH_MISSES or more runs in a row and is no
 * closer to its target than when the streak began (`MetricStreak.moved`, the duty job's "not moving toward the target" in `missLine`). The
 * whole streak counts, not only the misses under the current fix as `MetricStreak.stuck` reads them, since each new fix job starts that count
 * again: at 18:00Z on 10-22 api portal vp's d1 had missed 42 runs with probe_uptime_24h_pct never closer to 100 while p52's job was too new for
 * `stuck`, and so had SEO guy's d2 (16 runs) and CI and RepoOps' d4 (20 runs). A windowed count with no new event (`quietSince`) only waits.
 * measured: over the 7,011 runs in the 118 runs files on 10-22, a missed metric with no move reached its target within 10 more runs 86% of the
 * time after 1 miss, 76% after 2, 67% after 3 and 32% after 12 or more.
 */
export function fixNotMoving(red: readonly RedDuty[], name: (chat: string) => string): NotMoving[] {
  return red.flatMap(duty => {
    const metric = duty.metric;
    if (!duty.fix || metric?.fix?.step !== duty.fix || duty.agingSince !== undefined || metric.quietSince !== undefined || metric.moved ||
      metric.misses < CHANGE_APPROACH_MISSES) return [];
    return [{ chat: duty.chat, duty: duty.duty, line: `${name(duty.chat)}: ${duty.name} (${duty.duty}) missed ${metric.key} ${metric.misses} runs in a row, ` +
      `${show(metric.value)} against ${metric.op} ${show(metric.target)} and no closer than when the streak began, while its fix step ${duty.fix} has a live job. ` +
      `Replace that fix: start a root-cause job with rlm.create_session that finds why ${duty.fix} does not move the number and fixes that cause, ` +
      `give it its own step with duty "${duty.duty}/${metric.key}", and close or drop ${duty.fix} with a note naming the new step` }];
  });
}

/** A catalog row as the boxes' copies keep it (session-copy.json and src/host-catalogs.ts `copyPath`), with the fields the push reads. */
export interface CatalogRow { sessionId: string; sessionName?: string; sessionFile?: string; activity?: string; lastActivityAt?: string; created?: string }
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
      (row.activity === "working" || fresh(ms(row.lastActivityAt))));
  };
  const held = (item: PlanItem): boolean => {
    if (asked.has(item.id) || heldByTodo(item, todos) || parkedBy(item) !== undefined) return true;
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
      const at = row.activity === "working" ? now : ms(row.lastActivityAt);
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
 * model call and the run waits for its one rerun (`rerunCut`), as the duty runner's push reads it: a cut run that is no rerun and that no rerun
 * names. From 03:52Z to 06:16Z on 10-20 d9 counted its own d9, CI and RepoOps' d4 and frontend bro's check-in while their jobs waited for
 * pi-pool slots up to 07:23Z. A job whose transcript ends on a pool wait the runner has not recorded as a cut yet (`poolCut`) waits the same
 * way: at 07:01Z d9 counted CI and RepoOps' d4, whose 06:56Z verify job got a slot wait as its first reply and was parked to 08:16Z.
 * So does a job whose tree has a turn working or queued in pi-pool (`poolTrees`), as the duty runner's `treeWait` reads a subagent's wait: at
 * 16:03Z on 10-22 d9 counted Prospect feature bro's d2 while its 21:00 job waited on a subagent queued in pi-pool from 15:17Z to 16:05Z.
 */
export function withoutWorkingRuns<T extends { chat: string; duty: string }>(stuck: readonly T[], runs: ReadonlyMap<string, readonly DutyRunRecord[]>,
  rows: readonly CatalogRow[], now: number, poolCut: ReadonlySet<string> = new Set(), poolTrees: ReadonlySet<string> = new Set()): T[] {
  const at = new Map(rows.map(row => [row.sessionId, row.activity === "working" ? now : ms(row.lastActivityAt)] as const));
  return stuck.filter(entry => {
    const own = (runs.get(entry.chat) ?? []).filter(run => run.duty === entry.duty);
    const last = own.find(run => run.job !== undefined);
    const wrote = last?.job ? at.get(last.job.id) ?? 0 : 0;
    if (last && !last.after && now - wrote <= LIVE_GAP_MS && wrote > (last.cut?.at ?? 0)) return false;
    if (last?.job && !last.after && poolTrees.has(last.job.id)) return false;
    const cut = last?.cut ?? (last?.job && !last.after && poolCut.has(last.job.id) ? true : undefined);
    return !(cut && last!.trigger !== "rerun" && !own.some(run => run.rerunOf === last!.at));
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

/** One push the duty job sent a chat (`PUSHES_FILE`): when, the tag it put in the message, and the items it named. */
export interface Push { at: number; chat: string; tag: string; items: string[] }
/** How a push the last run's job sent went: whether its tag reached the chat's transcript, the chat answered after it, and a job started since. */
export interface PushCheck { push: Push; delivered: boolean; read: boolean; jobStarted: boolean }

/**
 * The transcript a push went to. A push can go to a session that is no owner chat, like the release owner 01a10810 or the metal box owner
 * 01a11d24, so it is looked up in the catalog by its own id; on 10-20 the 15:57Z run read both 13:45Z pushes as never delivered, though
 * each sat in its transcript from 14:03Z.
 */
export function pushedFile(listed: ReadonlyMap<string, { file?: string }>, copies: readonly string[], chat: string): string | undefined {
  return listed.get(chat)?.file ?? listedSessions(copies, [chat]).get(chat)?.file;
}

/** The tagged push in a chat's transcript lines: delivered when an agent message carries the tag, read when an assistant line comes after it. */
export function pushReached(lines: readonly string[], tag: string): { delivered: boolean; read: boolean } {
  let delivered = false;
  for (const line of lines) {
    if (!delivered) { if (line.includes('"agent_message"') && line.includes(tag)) delivered = true; continue; }
    if (line.includes('"role":"assistant"')) return { delivered, read: true };
  }
  return { delivered, read: false };
}

export interface ChatSystemFacts {
  names: ReadonlyMap<string, string>;
  stuck: readonly { chat: string; id?: string; text?: string; count?: number }[];
  upkeep: readonly PlanFlag[];
  fleet: { pct: number; red: readonly RedDuty[] };
  stuckDuties: readonly { chat: string; line: string }[];
  /** Per chat, the open goals with no live job (`goalsWithNoJob`) the run's job pushes it on, beside its stuck duties. */
  idleGoals: readonly { chat: string; goals: readonly PlanItem[] }[];
  /** The pushes the last run's job sent, as they went. */
  followUps: readonly PushCheck[];
  detail: string;
}

/** The precheck output from the facts: the five metrics, and per metric a count line with the detail path and up to 3 examples. */
export function chatSystemOutput(facts: ChatSystemFacts): PrecheckOutput {
  const name = (chat: string): string => facts.names.get(chat) ?? chat.slice(0, 8);
  const stuckCount = facts.stuck.reduce((sum, entry) => sum + (entry.count ?? 1), 0);
  const flagged: FlaggedSlice[] = [];
  const head = (kind: string, count: number, what: string, chats: number) => {
    if (count) flagged.push({ kind, excerpt: `${count} ${what} in ${chats} ${chats === 1 ? "chat" : "chats"}; every one is in ${facts.detail}.` });
  };
  const chats = (items: readonly { chat: string }[]) => new Set(items.map(item => item.chat)).size;
  head("stuck_steps", stuckCount, "open steps nobody moves", chats(facts.stuck));
  for (const entry of spread(facts.stuck, EXAMPLES)) {
    flagged.push({ kind: "stuck_steps", chat: entry.chat, ...entry.id ? { item: entry.id } : {},
      excerpt: entry.id ? `${name(entry.chat)}: ${entry.id} ${quote(entry.text ?? "")} is open and nobody moves it.` : `${name(entry.chat)}: ${entry.count} open steps nobody moves.` });
  }
  head("plan_upkeep", facts.upkeep.length, "open plan items that are upkeep or have no done line", chats(facts.upkeep));
  for (const item of spread(facts.upkeep, EXAMPLES)) flagged.push({ kind: "plan_upkeep", chat: item.chat, item: item.id, excerpt: `${name(item.chat)}: ${item.id} ${quote(item.text)} ${item.why}.` });
  head("red_duty", facts.fleet.red.length, "red duties", chats(facts.fleet.red));
  for (const duty of spread(facts.fleet.red.filter(duty => duty.agingSince === undefined), EXAMPLES)) {
    flagged.push({ kind: "red_duty", chat: duty.chat, item: duty.duty, excerpt: `${name(duty.chat)}: ${duty.name} (${duty.duty}) is red` +
      (duty.metric ? `, ${duty.metric.key} ${show(duty.metric.value)} against ${duty.metric.op} ${show(duty.metric.target)}` : "") + `, ${duty.misses === 1 ? "1 run" : `${duty.misses} runs in a row`}.` });
  }
  const aging = facts.fleet.red.filter(duty => duty.agingSince !== undefined);
  if (aging.length) flagged.push({ kind: "aging_duty", excerpt: `${aging.map(duty => `${name(duty.chat)} ${duty.duty}`).join(", ")} ${aging.length === 1 ? "is" : "are"} red only on ` +
    "counts over a trailing window with no new event since the run before, which fall as old events leave the window; they owe no fix job, so push nothing for them." });
  head("stuck_duty", facts.stuckDuties.length, "red duties with no live fix job", chats(facts.stuckDuties));
  for (const duty of spread(facts.stuckDuties, EXAMPLES)) flagged.push({ kind: "stuck_duty", chat: duty.chat, excerpt: `${duty.line}.` });
  const notMoving = fixNotMoving(facts.fleet.red, name);
  head("fix_not_moving", notMoving.length, "red duties whose live fix job does not move the number", chats(notMoving));
  for (const duty of spread(notMoving, EXAMPLES)) flagged.push({ kind: "fix_not_moving", chat: duty.chat, item: duty.duty, excerpt: `${duty.line}.` });
  const pushes = pushList({ ...facts, notMoving });
  if (pushes.length) flagged.push({ kind: "push", excerpt: `${pushes.length} ${pushes.length === 1 ? "chat has" : "chats have"} a goal with no live job, a red duty with no fix job ` +
    `or with a fix that does not move it, or a plan item that is upkeep or has no done line; ` +
    `message each one, as the push list in ${facts.detail} says.` });
  for (const check of facts.followUps.filter(check => !check.read || !check.jobStarted)) {
    flagged.push({ kind: "push_followup", chat: check.push.chat, excerpt: `${name(check.push.chat)}: the last run's push ${check.push.tag} about ${check.push.items.join(", ")} ` +
      `${!check.delivered ? "never reached its transcript" : !check.read ? "reached it, but the chat has not answered" : "was read, but no job started since"}; steer it again.` });
  }
  return {
    metrics: { stuck_steps_all: stuckCount, plan_upkeep_all: facts.upkeep.length, duties_green_pct: facts.fleet.pct, stuck_duties: facts.stuckDuties.length,
      fix_not_moving: notMoving.length },
    flagged,
  };
}

/**
 * Per chat, what the run's job pushes it on: its open goals with no live job, its red duties with no fix job or with a fix that does not move
 * them (`fixNotMoving`), its red windowed counts with no lastEventAt (`unreadWindows`), and its plan items that are upkeep or have no done line. Until 10-19 a chat with only plan items was on no push list, so no run messaged it: at 20:22Z the 26 items sat in 6
 * chats, and 4 of those chats were on no list.
 */
export function pushList(facts: Pick<ChatSystemFacts, "idleGoals" | "stuckDuties" | "upkeep"> & { lagging?: readonly { chat: string; line: string }[]; notMoving?: readonly NotMoving[] }):
  { chat: string; goals: readonly PlanItem[]; duties: string[]; upkeep: PlanFlag[] }[] {
  const chats = new Map<string, { goals: readonly PlanItem[]; duties: string[]; upkeep: PlanFlag[] }>();
  const at = (chat: string) => chats.get(chat) ?? chats.set(chat, { goals: [], duties: [], upkeep: [] }).get(chat)!;
  for (const entry of facts.idleGoals) if (entry.goals.length) at(entry.chat).goals = entry.goals;
  for (const duty of [...facts.stuckDuties, ...facts.lagging ?? [], ...facts.notMoving ?? []]) at(duty.chat).duties.push(duty.line);
  for (const item of facts.upkeep) at(item.chat).upkeep.push(item);
  return [...chats].map(([chat, entry]) => ({ chat, ...entry }));
}

/** Where each push d9 sends is recorded, one JSON line per message, for the next run to check. */
const PUSHES_FILE = join(homedir(), "work/plan-audit/pushes.jsonl");

/** What a push asks of a chat, after the list of its items. */
const PUSH_ASK = "Give each goal a live job this turn, each red duty a fix job on a step linked to it, each red duty whose live fix does not move its number a " +
  "root-cause job that replaces that fix, each duty that reads as a lagging window lastEventAt in its precheck, and each listed plan item a \"Done when\" " +
  "note, a duty metric or a close. Reply in your own chat, not to d9.";

/** One chat's line of the push list: its idle goals, its red duty lines and its upkeep items. */
export function pushItems(entry: ReturnType<typeof pushList>[number]): string {
  return (entry.goals.length ? `goals with no live job ${entry.goals.map(goal => `${goal.id} ${quote(goal.text)}`).join(", ")}` : "") +
    (entry.duties.length ? `${entry.goals.length ? "; " : ""}${entry.duties.join("; ")}` : "") +
    (entry.upkeep.length ? `${entry.goals.length || entry.duties.length ? "; " : ""}plan items to give a "Done when" note, move into a duty metric or close: ` +
      entry.upkeep.map(item => `${item.id} ${quote(item.text)} ${item.why}`).join(", ") : "");
}

/**
 * The pushes the server sends itself (`PrecheckOutput.tells`), so they go out on every run whatever the pool does. From 17:03Z on 10-22 to
 * 01:00Z on 10-23 no d9 push went out: the 20:09Z, 22:09Z and 00:10Z jobs each failed their first turn on "API key for provider anthropic is
 * temporarily unavailable", sat until the runner replaced them, and the runs between were skipped, so 8 chats whose fix did not move never
 * got the root-cause ask.
 */
export function pushTells(pushes: ReturnType<typeof pushList>, tag: string): { chat: string; text: string }[] {
  return pushes.map(entry => ({ chat: entry.chat, text: `${tag} The chat system duty (d9) found these in your chat: ${pushItems(entry)}. ${PUSH_ASK}` }));
}

/** The pushes.jsonl line of each push: the plan and duty ids it names. */
export function pushRecords(pushes: ReturnType<typeof pushList>, tag: string, at: number): { at: number; chat: string; tag: string; items: string[] }[] {
  return pushes.map(entry => {
    const items = [...entry.goals.map(goal => goal.id), ...entry.duties.flatMap(line => [...line.matchAll(/\((d\d+|checkin)\)/g)].map(match => match[1]!)),
      ...entry.upkeep.map(item => item.id)];
    return { at, chat: entry.chat, tag, items: [...new Set(items)] };
  });
}

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);
const section = (title: string, lines: readonly string[]): string => [`## ${title}`, "", ...lines.length ? lines.map((line, index) => `${index + 1}. ${line}`) : ["None."], ""].join("\n");

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("chat-system: OUTPUT_FILE is not set\n"); process.exit(2); }
  const now = Date.now();
  const dataDir = chatDataDir();
  const detail = `${output.replace(/\.json$/, "")}.md`;
  const copies = await catalogCopies(dataDir);
  const ids = await ownerChats(dataDir);
  const listed = listedSessions(copies, ids);
  const names = new Map(ids.map(id => [id, listed.get(id)?.name ?? id.slice(0, 8)] as const));
  const plan = await planInputs(dataDir, now, names);
  const rows = copies.flatMap(text => { try { const value = JSON.parse(text) as { rows?: CatalogRow[] }; return value.rows ?? []; } catch { return []; } });
  const jobs = jobsByChat(rows, plan.boards);
  const owned = planCounts({ ...plan, ...withCatalogOwners(plan, jobs, now) });
  const runsByChat = new Map(plan.chats.map(chat => [chat.id, chat.runs]));
  const poolCut = await poolCutJobs(owned.redDuties, runsByChat, id => listedSessions(copies, [id]).get(id)?.file);
  const counts = { ...owned, redDuties: withoutWorkingRuns(owned.redDuties, runsByChat, rows, now, poolCut, await poolTrees()) };
  const text = (chat: string, id: string): string | undefined => {
    let found: string | undefined;
    walk(plan.boards.get(chat)?.plan ?? [], item => { if (item.id === id) found = item.text; });
    return found;
  };
  const stuck = counts.stuck.flatMap((entry): ChatSystemFacts["stuck"] => entry.items.length
    ? entry.items.map(id => ({ chat: entry.chat.id, id, text: text(entry.chat.id, id) ?? "" }))
    : [{ chat: entry.chat.id, count: entry.value }]);
  const upkeep = plan.chats.filter(chat => !plan.pausedChats.has(chat.id)).flatMap(chat => planUpkeep(chat.id, plan.boards.get(chat.id) ?? null));
  const fleet = await dutyFleet({ dataDir, now, sessions: daemonSessions });
  const runsOf = (chat: string, duty: string) => (runsByChat.get(chat) ?? []).filter(run => run.duty === duty);
  const red = fleet.duties.filter(duty => !duty.green && !duty.pending).map((duty): RedDuty => {
    const since = agingSince(runsOf(duty.chat, duty.duty));
    return since === undefined ? duty : { ...duty, agingSince: since };
  });
  const idleGoals = plan.chats.filter(chat => !plan.pausedChats.has(chat.id)).map(chat => ({ chat: chat.id, goals: goalsWithNoJob(plan.boards.get(chat.id) ?? null,
    { now, named: plan.named.get(chat.id) ?? new Map(), jobs: jobs.get(chat.id) ?? [], activity: plan.ownerActivity, waking: plan.waking, poolWaiting: plan.poolWaiting }) }));
  // The pushes the last run's job sent: those recorded after the last run of this duty began (LAST_RUNS_FILE, newest first).
  const lastRuns = JSON.parse(await readFile(process.env.LAST_RUNS_FILE ?? "", "utf8").catch(() => "[]")) as DutyRunRecord[];
  const since = lastRuns.find(run => run.verdict !== "skipped")?.at;
  const sent = since === undefined ? [] : (await readFile(PUSHES_FILE, "utf8").catch(() => "")).split("\n").flatMap(line => {
    try { const push = JSON.parse(line) as Push; return push.at >= since ? [push] : []; } catch { return []; }
  });
  const followUps: PushCheck[] = [];
  for (const push of sent) {
    const file = localCopy(pushedFile(listed, copies, push.chat));
    const reached = file ? pushReached(await tail(file.file, TRANSCRIPT_TAIL_BYTES), push.tag) : { delivered: false, read: false };
    followUps.push({ push, ...reached, jobStarted: (jobs.get(push.chat) ?? []).some(row => ms(row.created) > push.at) });
  }
  const result = chatSystemOutput({ names, stuck, upkeep, fleet: { pct: fleet.metrics.duties_green_pct, red }, stuckDuties: counts.redDuties, idleGoals, followUps, detail });
  const fleetMissing = fleet.flagged.filter(slice => slice.kind === "fleet_data_missing");
  result.flagged!.push(...fleetMissing);
  const tag = `[d9 push ${new Date(now).toISOString().slice(0, 16)}Z]`;
  const name = (chat: string): string => names.get(chat) ?? chat.slice(0, 8);
  const notMoving = fixNotMoving(red, name);
  const pushes = pushList({ idleGoals, stuckDuties: counts.redDuties, lagging: owned.lagging, notMoving, upkeep });

  // The spot audit: one owner chat at random each run, read by the duty job against what the owner asked in it.
  const spot = ids[Math.floor(Math.random() * ids.length)]!;
  const transcript = localCopy(listed.get(spot)?.file);
  const asks = transcript ? ownerMessages(await tail(transcript.file, TRANSCRIPT_TAIL_BYTES), OWNER_MESSAGES) : [];
  const log = join(homedir(), "work/plan-audit/spot", `${today(now)}.md`);
  await mkdir(join(homedir(), "work/plan-audit/spot"), { recursive: true });
  result.flagged!.push({ kind: "spot_audit", chat: spot, excerpt: `Spot audit this run: ${names.get(spot)} (${spot}). Its files and the owner's last messages in it are in ${detail}; ` +
    `log what you found to ${log}, and send the owner nothing.` });

  const md = [
    `# Chat system run of ${new Date(now).toISOString()}`, "",
    `stuck_steps_all ${result.metrics.stuck_steps_all}, plan_upkeep_all ${result.metrics.plan_upkeep_all}, duties_green_pct ${result.metrics.duties_green_pct}, ` +
      `stuck_duties ${result.metrics.stuck_duties}, fix_not_moving ${result.metrics.fix_not_moving}, over ${ids.length} chats.`, "",
    ...fleetMissing.map(slice => `${slice.excerpt}\n`),
    `## Spot audit: ${name(spot)}`, "",
    `1. The chat is ${spot}, and it runs on ${transcript?.host ?? "a box whose transcript this box has no copy of"}.`,
    `2. Its plan is ${join(dataDir, "boards", `${spot}.json`)}.`,
    `3. Its duties are ${join(dataDir, "duties", `${spot}.json`)}, and their runs are ${join(dataDir, "duties", `${spot}.runs.jsonl`)}.`,
    `4. Its transcript is ${transcript?.file ?? "not on this box"}.`,
    "5. Read its open plan, its duties and their last runs, and its last turns, and compare them with the owner's asks below.",
    "6. Fix what is off: a step that is upkeep, a step with no done line or no live owner, a duty that checks something the owner did not ask for or misses what he did, a red duty with no fix job (one this file marks as red only on counts that age out owes none), and an ask of his that nothing on the board carries.",
    `7. Append what you found and what you fixed to ${log}, under a heading with the time and the chat's name, and send the owner nothing.`, "",
    "The owner's last messages in it, newest last:", "",
    ...asks.length ? asks.map(ask => `- ${ask.at}: ${JSON.stringify(ask.text)}`) : ["- None found in the transcript's last 4 MB."], "",
    `## Push list (${pushes.length} chats)`, "",
    `The server sent each chat below its push, tagged ${tag}, when this run's precheck ended, and ${PUSHES_FILE} records each one. Send none of them again. ` +
      "Follow up only where a chat's answer shows it did not act.", "",
    ...pushes.map((entry, index) => `${index + 1}. ${name(entry.chat)} (${entry.chat}): ${pushItems(entry)}.`), "",
    section(`Pushes the last run sent (${followUps.length})`, followUps.map(check => `${name(check.push.chat)}: ${check.push.tag} about ${check.push.items.join(", ")}, ` +
      `${check.delivered ? "delivered" : "not delivered"}, ${check.read ? "read" : "not read"}, ${check.jobStarted ? "a job started since" : "no job started since"}.`)),
    section(`Open steps nobody moves (${result.metrics.stuck_steps_all})`, stuck.map(entry => entry.id
      ? `${name(entry.chat)}: ${entry.id} ${quote(entry.text ?? "")}.` : `${name(entry.chat)}: ${entry.count} open steps nobody moves, with no ids in its check-in.`)),
    section(`Open plan items that are upkeep or have no done line (${upkeep.length})`, upkeep.map(item => `${name(item.chat)}: ${item.id} ${quote(item.text)} ${item.why}.`)),
    section(`Red duties (${red.length}, ${fleet.metrics.duties_green_pct}% green)`, red.map(duty => `${name(duty.chat)}: ${duty.name} (${duty.duty}), ` +
      `${duty.metric ? `${duty.metric.key} ${show(duty.metric.value)} against ${duty.metric.op} ${show(duty.metric.target)}, ` : ""}${duty.misses === 1 ? "1 run" : `${duty.misses} runs in a row`}` +
      `${duty.fix ? `, fix step ${duty.fix}` : duty.working ? `, its job ${duty.working} works on it` : ""}` +
      `${duty.agingSince !== undefined ? `, red only on counts that age out (newest event ${new Date(duty.agingSince).toISOString().slice(0, 16)}Z), so it owes no fix job` : ""}.`)),
    section(`Red duties with no live fix job (${counts.redDuties.length})`, counts.redDuties.map(duty => `${duty.line}.`)),
    section(`Red duties whose live fix job does not move the number (${notMoving.length})`, notMoving.map(duty => `${duty.line}.`)),
    section(`Red windowed counts with no lastEventAt, read as lagging windows (${owned.lagging.length})`, owned.lagging.map(duty => `${duty.line}.`)),
  ].join("\n");
  await writeFile(detail, md);
  if (pushes.length) {
    await mkdir(dirname(PUSHES_FILE), { recursive: true });
    await appendFile(PUSHES_FILE, pushRecords(pushes, tag, now).map(line => JSON.stringify(line) + "\n").join(""));
  }
  await writeFile(output, JSON.stringify({ ...result, tells: pushTells(pushes, tag) }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
