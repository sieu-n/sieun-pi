import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardStore } from "../../src/chat-board-store.ts";
import { ownerChats } from "../../src/owner-chats.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { withWakes } from "../../src/checkin-load.ts";
import { activePause, checkInSettings } from "../../src/checkin-settings.ts";
import { jobFacts, liveJobs, liveWindowMs, ownerOf, OPEN, walk } from "../../src/checkin-steps.ts";
import { CHECK_IN_DUTY, CHECK_IN_DUTY_ID, headlineMetric, type DutyMetric, type DutyRunRecord, type FixLink, type FlaggedSlice } from "../../src/shared/chat-duties.ts";
import { CHANGE_APPROACH_MISSES, effectiveRun, metricStreaks, missStreak, type MetricStreak } from "../../src/shared/duty-streak.ts";
import type { ChatBoard, ChildAgent, PlanItem, SessionRow } from "../../src/shared/types.ts";
import { fixJobLive } from "../../src/shared/duty-fixes.ts";
import { pendingWakes } from "../../src/wakes.ts";
import { daemonList, listRows } from "../../src/daemon-list.ts";

/**
 * The duty fleet: every active duty of every chat in `<dataDir>/chats.json`, the built-in check-in included unless its chat's check-in is paused,
 * judged by its newest measured run (`effectiveRun`, so a run whose own job fixed the miss counts green). An archived chat and a clean-room test
 * chat (`clean-room-chats.json`) are not the owner's, so they are left out, and a duty with no measured run yet is pending, outside the share: at
 * 01:00Z on 10-18 the share fell from 44.4% to 27.2% on two new duties of the clean-room chats "skill references" (archived by its teardown) and
 * "LinkedIn index gaps". It gives AI harness goal p453 its
 * `duties_green_pct` and lists `stuck_duties` chat by chat: a duty that missed CHANGE_APPROACH_MISSES measured runs in a row with no live fix job.
 * `node --import tsx scripts/duties/duty-fleet.ts [--data-dir <dir>] [--sessions <file>] [--now <ms>]` prints the result as JSON.
 */

/** The fields of one `prime-agent sessions --json` entry the fleet reads. */
export interface DaemonSession {
  sessionId: string; sessionName?: string; firstMessage?: string; lifecycle?: string; activity?: string; lastActivityAt?: string;
  messageCount?: number; parentSessionId?: string; rlmChildId?: string;
}
/** JSON whose strings may hold raw control characters (session titles do): they are escaped before parsing. */
export function parseLooseJson(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") { out += ch + (text[i + 1] ?? ""); i++; continue; }
      if (ch === '"') inString = false;
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return JSON.parse(out);
}

/** The daemon's session list, through `daemonList`'s 30 s hello wait and second read. */
export const daemonSessions = async (): Promise<DaemonSession[]> => listRows<DaemonSession>(await daemonList());

const ms = (iso: string | undefined): number | undefined => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : undefined; };
/**
 * The sessions at work: each working session and every session above it. A job whose own turn ended while its subagent runs is working, as the
 * server's catalog counts it (`isWorking` with the subtree); 10-09 the job google serp idled at 14:02Z waiting on its exp-http-final subagent and
 * the old board classes CLI called its step an orphan.
 */
export function workingSessions(sessions: readonly DaemonSession[]): Set<string> {
  const parent = new Map(sessions.map(session => [session.sessionId, session.parentSessionId]));
  const working = new Set<string>();
  for (const session of sessions) {
    if (session.activity !== "working" || session.lifecycle === "archived") continue;
    for (let id: string | undefined = session.sessionId; id !== undefined && !working.has(id); id = parent.get(id)) working.add(id);
  }
  return working;
}

/** The catalog rows the check-in reads, from the daemon's sessions. */
export function sessionRows(sessions: readonly DaemonSession[]): SessionRow[] {
  const working = workingSessions(sessions);
  return sessions.map(session => ({ id: session.sessionId, name: (session.sessionName || session.firstMessage || session.sessionId).trim(),
    archived: session.lifecycle === "archived", working: working.has(session.sessionId), messageCount: session.messageCount ?? 0,
    ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}) }) as SessionRow);
}
/** A chat's direct subagents still listed (a deleted job is archived), as the server's child snapshots. */
export function chatChildren(sessions: readonly DaemonSession[], chatId: string): ChildAgent[] {
  const working = workingSessions(sessions);
  return sessions.filter(session => session.parentSessionId === chatId && session.rlmChildId && session.lifecycle !== "archived").map(session => {
    const at = ms(session.lastActivityAt);
    return { id: session.rlmChildId!, label: session.sessionName ?? session.rlmChildId!, ...(session.sessionName ? { sessionName: session.sessionName } : {}),
      sessionId: session.sessionId, status: working.has(session.sessionId) ? "running" : "done", ...(at !== undefined ? { lastActivityAt: at } : {}) } as ChildAgent;
  });
}
/** Every listed subagent by its parent's session id, as the check-in's `liveJobs` reads the daemon's roster. */
export function subagentsByParent(sessions: readonly DaemonSession[]): Map<string, ChildAgent[]> {
  const byParent = new Map<string, ChildAgent[]>();
  for (const session of sessions) if (session.parentSessionId) byParent.set(session.parentSessionId, [...byParent.get(session.parentSessionId) ?? [], ...chatChildren([session], session.parentSessionId)]);
  return byParent;
}

export interface FleetDuty {
  chat: string; duty: string; name: string;
  /** The newest measured run met every target. */
  green: boolean;
  /** No measured run yet: neither green nor red, and outside `duties_green_pct`. */
  pending?: true;
  /** Measured runs in a row, newest first, whose verdict is missed. */
  misses: number;
  /** The metric the stuck line names: the headline when it missed, else the longest miss streak. */
  metric?: MetricStreak;
  /** The plan step of a live fix job for a missed metric, the lead metric's first: the run's live `fixes` while the step is open, else an open board step linked `<dutyId>/<metricKey>` whose job works now. */
  fix?: string;
  /** The duty's own job, at work now, that owns the misses of this run. */
  working?: string;
  stuck: boolean;
}
export interface DutyFleet {
  metrics: { duties_green_pct: number; stuck_duties: number }; flagged: FlaggedSlice[]; duties: FleetDuty[];
  /** The daemon's session list could not be read, so no duty with a long miss streak was judged stuck, fixed or worked on this run. */
  sessionsMissing?: string;
}

/**
 * A duty that measures `duties_green_pct` reads this share, so it stays out of it. Counted in, its own red verdict held the share under 100,
 * which made it miss again: the AI harness chat's d9 read 98.3% at best with every other duty green, and each run listed d9 as a red duty with
 * no fix job and pushed its own chat about it (d9 run of 06:16Z on 10-20).
 */
export const readsTheShare = (duty: { metrics: readonly { key: string }[] }): boolean => duty.metrics.some(metric => metric.key === "duties_green_pct");

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/**
 * A duty's verdict now: that of its newest reading, a measured run's (after its job, when it has that measure) or a skipped run's that measured
 * all the same. A check-in whose last job still works records its next run as skipped with the board's measure, and until 10-22 the fleet read
 * the older run: over the 24 h to 07:40Z the newest measure would have changed the verdict at 126 of 2,592 chat samples, 51 to green and 75 to red.
 */
export function verdictNow(runs: readonly DutyRunRecord[]): "met" | "missed" | undefined {
  let best: { at: number; verdict: "met" | "missed" } | undefined;
  for (const run of runs) {
    const metrics = Object.values(run.metrics ?? {});
    const read = measured(run) ? { at: run.after?.at ?? run.at, verdict: effectiveRun(run).verdict as "met" | "missed" }
      : run.verdict === "skipped" && metrics.length ? { at: run.at, verdict: metrics.every(metric => metric.met) ? "met" as const : "missed" as const } : undefined;
    if (read && (!best || read.at > best.at)) best = read;
  }
  return best?.verdict;
}
const show = (value: number): string => String(Math.round(value * 10) / 10);
const bound = (streak: MetricStreak): string => `${streak.op === "<=" ? "at most" : "at least"} ${show(streak.target)}`;

/** The missed metric the line names: the duty's headline when it missed, else the one missed for the most runs in a row. */
function leadMetric(metrics: readonly DutyMetric[], streaks: readonly MetricStreak[]): MetricStreak | undefined {
  const headline = headlineMetric(metrics);
  return streaks.find(streak => streak.key === headline?.key) ?? [...streaks].sort((a, b) => b.misses - a.misses)[0];
}

/** The board's steps by id, and its open steps by their `duty` link (`<dutyId>/<metricKey>`). */
function boardSteps(board: ChatBoard | null): { byId: Map<string, PlanItem>; linked: Map<string, PlanItem[]> } {
  const byId = new Map<string, PlanItem>();
  const linked = new Map<string, PlanItem[]>();
  walk(board?.plan ?? [], item => {
    byId.set(item.id, item);
    const link = (item as PlanItem & { duty?: unknown }).duty;
    if (typeof link === "string" && OPEN.has(item.status)) linked.set(link, [...linked.get(link) ?? [], item]);
  });
  return { byId, linked };
}

export async function dutyFleet(options: { dataDir: string; now: number; sessions: () => DaemonSession[] | Promise<DaemonSession[]> }): Promise<DutyFleet> {
  const { dataDir, now } = options;
  const ids = await ownerChats(dataDir);
  const store = new DutyStore(dataDir);
  const boards = new BoardStore(dataDir);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  const wakes = await pendingWakes(join(dataDir, "wakes"), now);
  const asleep = new Set(wakes.map(wake => wake.session));
  let sessions: DaemonSession[] | null | undefined;
  let sessionsMissing: string | undefined;
  const roster = async (): Promise<DaemonSession[] | null> => {
    if (sessions !== undefined) return sessions;
    try { sessions = await options.sessions(); } catch (error) { sessionsMissing = error instanceof Error ? error.message : String(error); sessions = null; }
    return sessions;
  };
  const duties: FleetDuty[] = [];
  for (const id of ids) {
    const file = await store.read(id);
    const runs = await store.runs(id);
    const setting = await settings.get(id);
    const active = [...(activePause(setting, now) === null ? [{ id: CHECK_IN_DUTY_ID, name: CHECK_IN_DUTY.name, metrics: CHECK_IN_DUTY.metrics }] : []),
      ...file.duties.filter(duty => duty.status === "active" && !readsTheShare(duty))];
    let board: ChatBoard | null | undefined;
    let live: ((item: PlanItem) => boolean) | undefined;
    for (const duty of active) {
      const own = runs.filter(run => run.duty === duty.id && measured(run));
      const newest = own[0];
      const green = verdictNow(runs.filter(run => run.duty === duty.id)) === "met";
      const streak = missStreak(own);
      const streaks = newest ? metricStreaks(own) : [];
      const entry: FleetDuty = { chat: id, duty: duty.id, name: duty.name, green, misses: streak, stuck: false, ...newest ? {} : { pending: true as const } };
      const metric = leadMetric(duty.metrics, streaks);
      if (metric) entry.metric = { ...metric };
      if (!green && newest) {
        board ??= await boards.read(id).catch(() => null);
        const { byId, linked } = boardSteps(board);
        // A run records its fixes when it runs, so the board says now whether a step closed since: a done or dropped step is never a fix.
        const open = (step: string): boolean => { const item = byId.get(step); return item === undefined || OPEN.has(item.status); };
        if (entry.metric?.fix && !open(entry.metric.fix.step)) delete entry.metric.fix;
        const all = streak >= CHANGE_APPROACH_MISSES ? await roster() : null;
        if (all) {
          // The check-in's working test: a running subtree, a session change within the chat's interval capped at LIVE_GAP_MS, or an owed wake.
          live ??= (() => {
            const children = chatChildren(all, id);
            const facts = withWakes(jobFacts(children, board, sessionRows(all), id, [], liveJobs(children, subagentsByParent(all), now, liveWindowMs(setting.everyMs), asleep)),
              wakes, key => children.find(child => child.id === key)?.sessionId);
            // The server's own test (`fixJobLive`) too: a fix job asleep on a board.wake is live though `prime-agent sessions` no longer lists it
            // (loaded sessions only); on 10-15 at 23:55 KST SEO guy's d1 read stuck here while its fix job slept on a 01:10Z wake.
            const rows = sessionRows(all);
            return (item: PlanItem) => ownerOf(item, facts)?.state === "working" || fixJobLive(item, id, rows, asleep);
          })();
          const working = live;
          // The lead metric's fix first, then the other missed metrics': for each, the live fix the run recorded while its step stays open, else an
          // open step linked to it whose job works now. On 10-18 at 00:46Z the AI harness chat's d7 missed clean_min_30, whose recorded fix p528
          // was done while p559 worked on it, and this named p529, the fix of stuck_steps_all.
          const fixOf = (key: string): FixLink | undefined => {
            const recorded = newest.fixes?.[key];
            if (recorded?.live && open(recorded.step)) return recorded;
            const item = linked.get(`${duty.id}/${key}`)?.find(working);
            return item && { step: item.id, ...item.job ? { job: item.job } : {}, live: true };
          };
          let fix: FixLink | undefined;
          for (const key of new Set([...metric ? [metric.key] : [], ...streaks.map(item => item.key)])) {
            fix = fixOf(key);
            if (!fix) continue;
            if (entry.metric?.key === key) entry.metric.fix = fix;
            break;
          }
          // The duty's own job still at work owns its misses this run: on 10-15 at 16:29Z ops guy's check-in read stuck 20 min into its 01:08 job.
          const job = fix === undefined ? runs.find(run => run.duty === duty.id && run.job)?.job : undefined;
          if (job && sessionRows(all).some(row => row.id === job.id && row.working)) entry.working = job.name;
          else if (fix === undefined) entry.stuck = true;
          else entry.fix = fix.step;
        }
      }
      duties.push(entry);
    }
  }
  const stuck = duties.filter(duty => duty.stuck);
  const judged = duties.filter(duty => !duty.pending);
  const names = new Map(sessionRows(stuck.length ? await roster() ?? [] : []).map(row => [row.id, row.name]));
  const missing: FlaggedSlice[] = sessionsMissing === undefined ? [] : [{ kind: "fleet_data_missing", excerpt: `The daemon's session list could not be read ` +
    `(${sessionsMissing.slice(0, 300)}), so no red duty was judged stuck, fixed or worked on this run; the green share still counts every duty.` }];
  return {
    // Floored to a tenth, so one red duty reads under 100.
    metrics: { duties_green_pct: judged.length ? Math.floor(1000 * judged.filter(duty => duty.green).length / judged.length) / 10 : 100, stuck_duties: stuck.length },
    flagged: [...missing, ...stuck.map(duty => ({ chat: duty.chat, kind: "stuck_duty", item: duty.duty,
      excerpt: `${names.get(duty.chat) ?? duty.chat}: ${duty.name} missed ${duty.misses} runs, ${duty.metric ? `${duty.metric.key} ${show(duty.metric.value)} against ${bound(duty.metric)}` : "no metric value"}, no live fix job` }))],
    duties,
    ...sessionsMissing === undefined ? {} : { sessionsMissing },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const now = arg("--now") ? Number(arg("--now")) : Date.now();
  const dataDir = arg("--data-dir") ?? join(homedir(), ".prime/agent/browser-chat");
  const sessionsFile = arg("--sessions");
  const loaded = sessionsFile ? parseLooseJson(await readFile(sessionsFile, "utf8")) as { sessions?: DaemonSession[] } | DaemonSession[] : undefined;
  const sessions = (): DaemonSession[] | Promise<DaemonSession[]> => loaded ? (Array.isArray(loaded) ? loaded : loaded.sessions ?? []) : daemonSessions();
  process.stdout.write(JSON.stringify(await dutyFleet({ dataDir, now, sessions }), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
