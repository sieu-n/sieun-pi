import { ApiError, get, OWNER_UI_HEADERS, post } from "./api.ts";
import { clockTime } from "./format.ts";
import type { DutyRunRecord, DutySchedule, DutyView } from "../shared/chat-duties.ts";
import { dutyState, judgedRun, missStreak } from "./duty-card.ts";
import { ThreadCache } from "./thread-side.svelte.ts";

export type DutyAction = "run" | "pause" | "resume" | "schedule";
const route = (id: string) => "api/threads/" + encodeURIComponent(id) + "/duties";
export const dutiesApi = {
  view: (id: string) => get<{ duties: DutyView[] }>(route(id), 60_000),
  act: (id: string, duty: string, action: DutyAction, schedule?: DutySchedule) => post<{ duties: DutyView[] }>(route(id), { duty, action, ...(schedule ? { schedule } : {}) }, undefined, OWNER_UI_HEADERS),
};

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

/** The next run as a sentence: "Next run at 23:07.", "Paused.", "Running now.", "Due now." */
export function nextLabel(view: DutyView, now: number): string {
  if (view.running) return "Running now.";
  if (view.nextAt === null) return "Paused.";
  return view.nextAt <= now ? "Due now." : `Next run at ${whenLabel(view.nextAt, now)}.`;
}

/**
 * What the owner reads for a run's verdict (owner 10-10, p256: "Use off target"): a run whose numbers came up short is "off target"; "missed"
 * is only for a slot that did not run at all (the server's `skipped`).
 */
export const VERDICT_WORDS = { met: "met", missed: "off target", error: "precheck failed", skipped: "missed" } as const;

/**
 * The last run in words, judged after its job when it has an after-job measure: "off target 5 runs in a row · 23:07 yesterday", "met after its
 * job · 23:40", "met · 23:07", "no run yet". The latest slot that did not run reads "missed". The streak counts measured runs only.
 */
export function lastLabel(view: DutyView, now: number): string {
  const newest = view.runs[0];
  const last = view.runs.find(run => run.verdict !== "skipped");
  if (newest && newest.verdict === "skipped" && (!last || newest.at > last.at)) return `${VERDICT_WORDS.skipped} · ${whenLabel(newest.at, now)}`;
  if (!last) return "no run yet";
  const judged = judgedRun(last, view.duty.metrics);
  const streak = judged.verdict === "missed" ? missStreak(view.runs, view.duty.metrics) : 0;
  const word = `${VERDICT_WORDS[judged.verdict]}${last.after ? " after its job" : ""}${streak > 1 ? ` ${streak} runs in a row` : ""}`;
  return `${word} · ${whenLabel(last.after?.at ?? last.at, now)}`;
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
 * One chat's duties for the board panel: pushed on the thread feed (`dutiesFeed`), asked again every 30 s while the panel shows, and after an action. A thread
 * that is not a chat, or a server without duties, reads as none (404). A failed or timed-out poll keeps the last duties, since on 10-18 each
 * chat release restarted the box chat (05:38, 05:41 and 05:44Z) and the poll that hit the restart emptied the card until the next one. A
 * poll waits 60 s, since at 06:02Z on 10-18 the box chat ran at 430% CPU and its duties answer took 9 to 18 s locally and passed the 20 s
 * default through the tailnet proxy twice in a row, so the card never showed.
 */
export class ChatDuties {
  error = $state<string | null>(null);
  private chat = $state("");
  /** The chat's duties from the last answer for it, so a switch back paints the card with no request. */
  get views(): DutyView[] { return dutyCache.value(this.chat) ?? NO_DUTIES; }

  watch(chat: string): () => void {
    this.chat = chat;
    this.error = null;
    void dutyCache.ensure(chat);
    const timer = setInterval(() => { void this.load(); }, POLL_MS);
    return () => clearInterval(timer);
  }

  load(): Promise<void> { return dutyCache.load(this.chat); }

  async act(duty: string, action: DutyAction, schedule?: DutySchedule): Promise<void> {
    const chat = this.chat;
    try {
      const { duties } = await dutiesApi.act(chat, duty, action, schedule);
      dutyCache.set(chat, duties);
      if (chat !== this.chat) return;
      this.error = null;
      if (action === "run") for (const delay of [3_000, 15_000, 60_000]) setTimeout(() => { void dutyCache.load(chat); }, delay);
    } catch (error) { if (chat === this.chat) this.error = error instanceof Error ? error.message : String(error); }
  }
}

const NO_DUTIES: DutyView[] = [];
/** Each chat's duties: a 404 (a thread that is not a chat, a server without duties) reads as none, and a failed poll keeps the last ones. */
const dutyCache = new ThreadCache<DutyView[]>(chat => dutiesApi.view(chat).then(body => body.duties),
  error => error instanceof ApiError && error.status === 404 ? NO_DUTIES : undefined);
/** The thread feed pushes a chat's duties after its snapshot (shared/thread-side.ts), so the card asks for none at a switch. */
export const dutiesFeed = { expect: (chat: string) => dutyCache.expect(chat), drop: (chat: string) => dutyCache.drop(chat), set: (chat: string, duties: DutyView[]) => dutyCache.set(chat, duties),
  /** The chat's duties as the mention chips name them; reactive, so a pushed or polled change re-renders the chips. */
  mentions: (chat: string): { id: string; name: string }[] => (dutyCache.value(chat) ?? NO_DUTIES).map(view => view.duty) };
