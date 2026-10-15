import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BoardStore } from "../../src/chat-board-store.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { withWakes } from "../../src/checkin-load.ts";
import { activePause, checkInSettings } from "../../src/checkin-settings.ts";
import { jobFacts, liveJobs, liveWindowMs, ownerOf, OPEN, walk } from "../../src/checkin-steps.ts";
import { CHECK_IN_DUTY, CHECK_IN_DUTY_ID, headlineMetric, type DutyMetric, type DutyRunRecord, type FlaggedSlice } from "../../src/shared/chat-duties.ts";
import { CHANGE_APPROACH_MISSES, effectiveRun, metricStreaks, missStreak, type MetricStreak } from "../../src/shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { pendingWakes } from "../../src/wakes.ts";
import { chatChildren, daemonSessions, parseLooseJson, sessionRows, subagentsByParent, type DaemonSession } from "./board-classes.ts";

/**
 * The duty fleet: every active duty of every chat in `<dataDir>/chats.json`, the built-in check-in included unless its chat's check-in is paused,
 * judged by its newest measured run (`effectiveRun`, so a run whose own job fixed the miss counts green). The Chat system duty leads with
 * `duties_green_pct` and chases `stuck_duties` chat by chat: a duty that missed CHANGE_APPROACH_MISSES measured runs in a row with no live fix job.
 * `node --import tsx scripts/duties/duty-fleet.ts [--data-dir <dir>] [--sessions <file>] [--now <ms>]` prints the result as JSON.
 */

export interface FleetDuty {
  chat: string; duty: string; name: string;
  /** The newest measured run met every target. */
  green: boolean;
  /** Measured runs in a row, newest first, whose verdict is missed. */
  misses: number;
  /** The metric the stuck line names: the headline when it missed, else the longest miss streak. */
  metric?: MetricStreak;
  /** The plan step of a live fix job for a missed metric: the run's `fixes`, or a board step linked `<dutyId>/<metricKey>` whose job works now. */
  fix?: string;
  stuck: boolean;
}
export interface DutyFleet { metrics: { duties_green_pct: number; stuck_duties: number }; flagged: FlaggedSlice[]; duties: FleetDuty[] }

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };
const show = (value: number): string => String(Math.round(value * 10) / 10);
const bound = (streak: MetricStreak): string => `${streak.op === "<=" ? "at most" : "at least"} ${show(streak.target)}`;

/** The missed metric the line names: the duty's headline when it missed, else the one missed for the most runs in a row. */
function leadMetric(metrics: readonly DutyMetric[], streaks: readonly MetricStreak[]): MetricStreak | undefined {
  const headline = headlineMetric(metrics);
  return streaks.find(streak => streak.key === headline?.key) ?? [...streaks].sort((a, b) => b.misses - a.misses)[0];
}

/** Open plan steps by their `duty` link (`<dutyId>/<metricKey>`). */
function dutySteps(board: ChatBoard | null): Map<string, PlanItem[]> {
  const steps = new Map<string, PlanItem[]>();
  walk(board?.plan ?? [], item => {
    const link = (item as PlanItem & { duty?: unknown }).duty;
    if (typeof link === "string" && OPEN.has(item.status)) steps.set(link, [...steps.get(link) ?? [], item]);
  });
  return steps;
}

export async function dutyFleet(options: { dataDir: string; now: number; sessions: () => DaemonSession[] }): Promise<DutyFleet> {
  const { dataDir, now } = options;
  const listed = JSON.parse(await readFile(join(dataDir, "chats.json"), "utf8").catch(() => "{}")) as { ids?: unknown };
  const ids = (Array.isArray(listed.ids) ? listed.ids : []).filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id));
  const store = new DutyStore(dataDir);
  const boards = new BoardStore(dataDir);
  const settings = checkInSettings(join(dataDir, "check-in-settings.json"));
  const wakes = await pendingWakes(join(dataDir, "wakes"), now);
  const asleep = new Set(wakes.map(wake => wake.session));
  let sessions: DaemonSession[] | undefined;
  const roster = (): DaemonSession[] => (sessions ??= options.sessions());
  const duties: FleetDuty[] = [];
  for (const id of ids) {
    const file = await store.read(id);
    const runs = await store.runs(id);
    const setting = await settings.get(id);
    const active = [...(activePause(setting, now) === null ? [{ id: CHECK_IN_DUTY_ID, name: CHECK_IN_DUTY.name, metrics: CHECK_IN_DUTY.metrics }] : []),
      ...file.duties.filter(duty => duty.status === "active")];
    let board: ChatBoard | null | undefined;
    let live: ((item: PlanItem) => boolean) | undefined;
    for (const duty of active) {
      const own = runs.filter(run => run.duty === duty.id && measured(run));
      const newest = own[0];
      const green = newest !== undefined && effectiveRun(newest).verdict === "met";
      const streak = missStreak(own);
      const streaks = newest ? metricStreaks(own) : [];
      const entry: FleetDuty = { chat: id, duty: duty.id, name: duty.name, green, misses: streak, stuck: false };
      const metric = leadMetric(duty.metrics, streaks);
      if (metric) entry.metric = metric;
      if (!green && newest && streak >= CHANGE_APPROACH_MISSES) {
        const missed = new Set(streaks.map(item => item.key));
        let fix = Object.entries(newest.fixes ?? {}).find(([key, link]) => missed.has(key) && link.live)?.[1].step;
        if (fix === undefined) {
          board ??= await boards.read(id).catch(() => null);
          const linked = dutySteps(board);
          const candidates = [...missed].flatMap(key => linked.get(`${duty.id}/${key}`) ?? []);
          if (candidates.length) {
            // The check-in's working test (board-classes.ts): a running subtree, a session change within the chat's interval capped at LIVE_GAP_MS, or an owed wake.
            live ??= (() => {
              const all = roster();
              const children = chatChildren(all, id);
              const facts = withWakes(jobFacts(children, board, sessionRows(all), id, [], liveJobs(children, subagentsByParent(all), now, liveWindowMs(setting.everyMs), asleep)),
                wakes, key => children.find(child => child.id === key)?.sessionId);
              return (item: PlanItem) => ownerOf(item, facts)?.state === "working";
            })();
            fix = candidates.find(live)?.id;
          }
        }
        if (fix === undefined) entry.stuck = true;
        else entry.fix = fix;
      }
      duties.push(entry);
    }
  }
  const stuck = duties.filter(duty => duty.stuck);
  const names = stuck.length ? new Map(sessionRows(roster()).map(row => [row.id, row.name])) : new Map<string, string>();
  return {
    // Floored to a tenth, so one red duty reads under 100.
    metrics: { duties_green_pct: duties.length ? Math.floor(1000 * duties.filter(duty => duty.green).length / duties.length) / 10 : 100, stuck_duties: stuck.length },
    flagged: stuck.map(duty => ({ chat: duty.chat, kind: "stuck_duty", item: duty.duty,
      excerpt: `${names.get(duty.chat) ?? duty.chat}: ${duty.name} missed ${duty.misses} runs, ${duty.metric ? `${duty.metric.key} ${show(duty.metric.value)} against ${bound(duty.metric)}` : "no metric value"}, no live fix job` })),
    duties,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const now = arg("--now") ? Number(arg("--now")) : Date.now();
  const dataDir = arg("--data-dir") ?? join(homedir(), ".prime/agent/browser-chat");
  const sessionsFile = arg("--sessions");
  const loaded = sessionsFile ? parseLooseJson(await readFile(sessionsFile, "utf8")) as { sessions?: DaemonSession[] } | DaemonSession[] : undefined;
  const sessions = (): DaemonSession[] => loaded ? (Array.isArray(loaded) ? loaded : loaded.sessions ?? []) : daemonSessions();
  process.stdout.write(JSON.stringify(await dutyFleet({ dataDir, now, sessions }), null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
