import { get, OWNER_UI_HEADERS, post } from "./api.ts";
import { clockTime } from "./format.ts";
import type { DutyRunRecord, DutySchedule, DutyView } from "../shared/chat-duties.ts";

export type DutyAction = "run" | "pause" | "resume" | "schedule";
const route = (id: string) => "api/threads/" + encodeURIComponent(id) + "/duties";
export const dutiesApi = {
  view: (id: string) => get<{ duties: DutyView[] }>(route(id)),
  act: (id: string, duty: string, action: DutyAction, schedule?: DutySchedule) => post<{ duties: DutyView[] }>(route(id), { duty, action, ...(schedule ? { schedule } : {}) }, undefined, OWNER_UI_HEADERS),
};

/** The dot a duty row shows: its last verdict, or running, paused, or new before its first run. */
export type DutyState = "met" | "missed" | "error" | "paused" | "running" | "new";
export function dutyState(view: DutyView): DutyState {
  if (view.running) return "running";
  if (view.paused) return "paused";
  const last = view.runs.find(run => run.verdict !== "skipped");
  return last ? last.verdict as Exclude<DutyRunRecord["verdict"], "skipped"> : "new";
}

/** "daily 23:07", "every 30 min". */
export const scheduleLabel = (schedule: DutySchedule): string => schedule.kind === "daily" ? `daily ${schedule.at}` : `every ${schedule.minutes} min`;

const DAY = 24 * 60 * 60_000;
/** "23:07", "23:07 yesterday", "Oct 6 23:07", against the local day of `now`. */
export function whenLabel(at: number, now: number): string {
  const day = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const days = Math.round((day(now) - day(at)) / DAY);
  const time = clockTime(at);
  if (days === 0) return time;
  if (days === 1) return `${time} yesterday`;
  if (days === -1) return `${time} tomorrow`;
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** The row's next-run text: "next 23:07", "paused", "running now". */
export function nextLabel(view: DutyView, now: number): string {
  if (view.running) return "running now";
  if (view.nextAt === null) return "paused";
  return view.nextAt <= now ? "due now" : `next ${whenLabel(view.nextAt, now)}`;
}

/**
 * What the owner reads for a run's verdict (owner 10-10, p256: "Use off target"): a run whose numbers came up short is "off target"; "missed"
 * is only for a slot that did not run at all (the server's `skipped`).
 */
export const VERDICT_WORDS = { met: "met", missed: "off target", error: "precheck failed", skipped: "missed" } as const;

/**
 * The last run in words: "off target 2 of 7 · 23:07 yesterday", "met · 23:07", "no run yet". The latest slot that did not run reads "missed".
 * Slots that did not run count in neither number.
 */
export function lastLabel(view: DutyView, now: number): string {
  const newest = view.runs[0];
  const runs = view.runs.filter(run => run.verdict !== "skipped").slice(0, 7);
  const last = runs[0];
  if (newest && newest.verdict === "skipped" && (!last || newest.at > last.at)) return `${VERDICT_WORDS.skipped} · ${whenLabel(newest.at, now)}`;
  if (!last) return "no run yet";
  const word = VERDICT_WORDS[last.verdict];
  const misses = runs.filter(run => run.verdict === "missed").length;
  return `${word}${misses ? ` ${misses} of ${runs.length}` : ""} · ${whenLabel(last.at, now)}`;
}

/** The card header: "1 duty", "2 duties, 1 off target". */
export function dutiesCount(views: readonly DutyView[]): string {
  if (!views.length) return "";
  const short = views.filter(view => ["missed", "error"].includes(dutyState(view))).length;
  return `${views.length} ${views.length === 1 ? "duty" : "duties"}${short ? `, ${short} off target` : ""}`;
}

/** The pass and fail history, oldest first: one entry per run, skipped slots included as grey. */
export const history = (view: DutyView, count = 14): DutyRunRecord[] => view.runs.slice(0, count).reverse();

/** A metric's value in the duty's unit, one decimal at most. */
export const metricValue = (value: number, unit = ""): string => `${Math.round(value * 10) / 10}${unit}`;

const POLL_MS = 30_000;
/**
 * One chat's duties for the board panel: loaded when the chat opens, again every 30 s while the panel shows, and after an action. A thread
 * that is not a chat, or a server without duties, reads as none.
 */
export class ChatDuties {
  views = $state.raw<DutyView[]>([]);
  error = $state<string | null>(null);
  private chat = "";

  watch(chat: string): () => void {
    this.chat = chat;
    this.views = [];
    this.error = null;
    void this.load();
    const timer = setInterval(() => { void this.load(); }, POLL_MS);
    return () => clearInterval(timer);
  }

  async load(): Promise<void> {
    const chat = this.chat;
    try { const { duties } = await dutiesApi.view(chat); if (chat === this.chat) this.views = duties; }
    catch { if (chat === this.chat) this.views = []; }
  }

  async act(duty: string, action: DutyAction, schedule?: DutySchedule): Promise<void> {
    const chat = this.chat;
    try {
      const { duties } = await dutiesApi.act(chat, duty, action, schedule);
      if (chat !== this.chat) return;
      this.views = duties;
      this.error = null;
      if (action === "run") for (const delay of [3_000, 15_000, 60_000]) setTimeout(() => { if (chat === this.chat) void this.load(); }, delay);
    } catch (error) { if (chat === this.chat) this.error = error instanceof Error ? error.message : String(error); }
  }
}
