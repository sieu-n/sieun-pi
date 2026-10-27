/**
 * Boards, For you, duties and check-ins. A chat's board is the `chat.board` document of its root conversation in pi-host, changed through
 * the board reducer copied from today's chat (web/src/lib/api/shared/chat-board.ts). Duties and the check-in clock live in the chat
 * server's data dir, and a due duty, check-in or wake reaches the chat as an input from "board".
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BoardOp, BoardRow, BoardView, ChatBoard, CheckInPatch, CheckInView, DutyAction, DutyView, ForYouItem, PlanItem } from "../web/src/lib/api/types.ts";
import { applyBoardOp, BOARD_PREFIX, emptyBoard, needsGo, nextIds, parseBoard, parseBoardOps, stepGo } from "../web/src/lib/api/shared/chat-board.ts";
import type { Duty, DutyRunRecord, DutySchedule } from "../web/src/lib/api/shared/chat-duties.ts";
import { dutyCard, judgedRun, missStreak, type DutyCardModel } from "../web/src/lib/api/shared/duty-card.ts";
import type { ChatAgent } from "../web/src/lib/api/shared/types.ts";
import type { Host } from "./host/types.ts";
import { readJson, writeJson, type Store } from "./store.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import type { Threads } from "./threads.ts";

export const BOARD_DOC = "chat.board";
const DEFAULT_CHECK_IN_MS = 120 * 60_000;

export interface DutyFile { duties: Duty[]; runs: Record<string, DutyRunRecord[]>; checkIn?: { everyMs: number; pausedUntil: number | "forever" | null; lastAt: number | null } }
export type DutyViewOut = DutyView & { card: DutyCardModel; last: { verdict: string; at: number; streak: number; afterJob: boolean } | null };
export interface Wake { id: string; thread: string; conversation?: number; at: number; text: string }

export interface BoardEvents {
  board(chatId: string, board: ChatBoard, awaitingGo: string[]): void;
  forYou(count: number): void;
}

function walk(plan: readonly PlanItem[], visit: (item: PlanItem) => void): void {
  for (const item of plan) {
    visit(item);
    walk(item.children, visit);
  }
}

export function awaitingGo(board: ChatBoard | null): string[] {
  if (!board) return [];
  const out: string[] = [];
  walk(board.plan, item => {
    if (item.status !== "done" && item.status !== "dropped" && needsGo(item) && !stepGo(board, item)) out.push(item.id);
  });
  return out;
}

/** The next run of a schedule after `from`, with daily times read in the owner's zone. */
export function nextRun(schedule: DutySchedule, from: number): number {
  if (schedule.kind === "every") return from + schedule.minutes * 60_000;
  const [h, m] = schedule.at.split(":").map(Number);
  const local = new Date(from + OWNER_ZONE_OFFSET_MS);
  let at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h ?? 9, m ?? 0) - OWNER_ZONE_OFFSET_MS;
  if (at <= from) at += 86_400_000;
  return at;
}

export class Boards {
  private readonly cache = new Map<string, ChatBoard | null>();
  private timer?: NodeJS.Timeout;

  constructor(readonly host: Host, readonly store: Store, readonly threads: Threads, readonly events: BoardEvents, private readonly log: (line: string) => void = () => {}) {}

  chats(): string[] {
    return this.threads.threadsList().filter(t => !t.archived && this.threads.meta(t.id).kind === "chat").map(t => t.id);
  }

  async board(chat: string): Promise<ChatBoard | null> {
    if (this.cache.has(chat)) return this.cache.get(chat)!;
    const value = await this.host.docGet(chat, BOARD_DOC).catch(() => null);
    const board = value ? parseBoard(value) : null;
    this.cache.set(chat, board);
    return board;
  }

  async view(chat: string): Promise<BoardView> {
    const board = await this.board(chat);
    return { board, awaitingGo: awaitingGo(board) };
  }

  /** The owner's board ops; each one also reaches the chat as a `[board]` line, as today. */
  async apply(chat: string, raw: unknown): Promise<BoardView> {
    const ops: BoardOp[] = parseBoardOps(raw);
    const now = new Date().toISOString();
    let board = (await this.board(chat)) ?? emptyBoard(now);
    const summaries: string[] = [];
    for (const op of ops) {
      const result = applyBoardOp(board, op, "owner", now, nextIds(board));
      board = result.board;
      summaries.push(result.summary);
    }
    await this.host.docPut(chat, BOARD_DOC, board);
    this.cache.set(chat, board);
    this.events.board(chat, board, awaitingGo(board));
    this.events.forYou(await this.forYouCount());
    if (summaries.length) {
      await this.host.submit(chat, {
        text: `${BOARD_PREFIX}${summaries.join("\n")}`, whenBusy: "followUp", requestId: `board:${chat}:${board.rev}`,
        entry: { kind: "agent.message", data: { from: "owner", via: "board" } },
      }).catch(error => this.log(`board note to ${chat} failed: ${String(error)}`));
    }
    return { board, awaitingGo: awaitingGo(board) };
  }

  /** A doc event from pi-host: the chat wrote its board. */
  docChanged(chat: string, value: unknown): void {
    const board = value ? parseBoard(value) : null;
    this.cache.set(chat, board);
    if (board) this.events.board(chat, board, awaitingGo(board));
  }

  async forYou(): Promise<ForYouItem[]> {
    const out: ForYouItem[] = [];
    for (const chat of this.chats()) {
      const board = await this.board(chat);
      if (!board) continue;
      const steps = new Map<string, PlanItem>();
      walk(board.plan, item => steps.set(item.id, item));
      for (const todo of board.todos) {
        const step = todo.step ? steps.get(todo.step) : undefined;
        out.push({ chatId: chat, chatName: this.threads.thread(chat)?.name ?? chat, todo, ...(step ? { step: { id: step.id, text: step.text, status: step.status } } : {}) });
      }
    }
    return out.sort((a, b) => b.todo.at.localeCompare(a.todo.at));
  }

  async forYouCount(): Promise<number> {
    return (await this.forYou()).filter(item => !item.todo.done).length;
  }

  async index(): Promise<BoardRow[]> {
    const rows: BoardRow[] = [];
    for (const chat of this.chats()) {
      const board = await this.board(chat);
      if (!board) continue;
      let done = 0;
      let total = 0;
      walk(board.plan, item => {
        if (item.status === "dropped") return;
        total += 1;
        if (item.status === "done") done += 1;
      });
      const checkIn = this.checkIn(chat);
      rows.push({
        chatId: chat, chatName: this.threads.thread(chat)?.name ?? chat, rev: board.rev, progress: { done, total },
        openAsks: board.todos.filter(t => !t.done).length, needsGo: awaitingGo(board).length,
        checkIn: { nextAt: checkIn.nextAt, paused: checkIn.paused },
        duties: this.duties(chat).map(d => ({ id: d.duty.id, name: d.duty.name, nextAt: d.nextAt, lastVerdict: d.last?.verdict ?? null })),
      });
    }
    return rows;
  }

  // Duties and check-ins

  private file(chat: string): DutyFile {
    return readJson<DutyFile>(join(this.store.dir, "boards", chat, "duties.json"), { duties: [], runs: {} });
  }
  private save(chat: string, file: DutyFile): void {
    writeJson(join(this.store.dir, "boards", chat, "duties.json"), file);
  }

  chatAgents(chat: string): ChatAgent[] {
    return this.threads.agents({ archived: false }).filter(a => a.thread === chat && a.conversation !== 1 || a.parent?.id === chat).map(a => ({
      key: `thread:${a.id}`, sessionId: a.id, name: a.name, job: a.name, sender: a.name, link: a.thread === chat ? "subagent" as const : "root" as const,
      state: a.status === "working" ? "working" as const : a.status === "failed" ? "failed" as const : "idle" as const,
      ...(a.preview ? { activity: a.preview } : {}), lastActivityAt: new Date(a.updatedAt).toISOString(), steps: [],
    }));
  }

  duties(chat: string): DutyViewOut[] {
    const file = this.file(chat);
    const agents = this.chatAgents(chat);
    return file.duties.map(duty => {
      const runs = file.runs[duty.id] ?? [];
      const view: DutyView = {
        duty: { id: duty.id, name: duty.name, ownerWords: duty.ownerWords, goal: duty.goal, metrics: duty.metrics, status: duty.status, ...(duty.boardGoal ? { boardGoal: duty.boardGoal } : {}) },
        schedule: duty.schedule, paused: duty.status === "paused", nextAt: duty.status === "paused" ? null : nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt),
        running: false, runs, priority: "normal",
      };
      const newest = runs.at(-1);
      const judged = newest ? judgedRun(newest, duty.metrics) : null;
      return {
        ...view, card: dutyCard(view, agents),
        last: newest && judged ? { verdict: judged.verdict, at: newest.at, streak: missStreak(runs, duty.metrics), afterJob: newest.after !== undefined } : null,
      };
    });
  }

  async dutyAction(chat: string, action: DutyAction): Promise<DutyViewOut[]> {
    const file = this.file(chat);
    const duty = file.duties.find(d => d.id === action.duty);
    if (!duty) throw new Error(`No duty ${action.duty} on this chat.`);
    if (action.action === "pause") duty.status = "paused";
    else if (action.action === "resume") duty.status = "active";
    else if (action.action === "schedule") duty.schedule = action.schedule as DutySchedule;
    else if (action.action === "run") await this.runDuty(chat, duty, "owner");
    duty.updatedAt = Date.now();
    this.save(chat, file);
    return this.duties(chat);
  }

  private async runDuty(chat: string, duty: Duty, trigger: string): Promise<void> {
    duty.runCount += 1;
    duty.lastRunAt = Date.now();
    await this.host.submit(chat, {
      text: `[duty ${duty.id}] ${duty.name}: run it now (${trigger}). Goal: ${duty.goal}. On a miss: ${duty.onMiss}`, whenBusy: "followUp",
      requestId: `duty:${chat}:${duty.id}:${duty.runCount}`, entry: { kind: "agent.message", data: { from: "board", via: `duty ${duty.id}` } },
    });
  }

  checkIn(chat: string): CheckInView {
    const state = this.file(chat).checkIn ?? { everyMs: DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: null };
    const now = Date.now();
    const paused = state.pausedUntil === "forever" || (typeof state.pausedUntil === "number" && state.pausedUntil > now);
    const base = state.lastAt ?? this.threads.thread(chat)?.createdAt ?? now;
    return {
      everyMs: state.everyMs, paused, pausedUntil: paused ? state.pausedUntil : null,
      nextAt: paused ? (state.pausedUntil === "forever" ? null : Math.max(state.pausedUntil as number, base + state.everyMs)) : base + state.everyMs, lastAt: state.lastAt,
    };
  }

  setCheckIn(chat: string, patch: CheckInPatch): CheckInView {
    const file = this.file(chat);
    const state = file.checkIn ?? { everyMs: DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: null };
    if (patch.everyMs !== undefined) {
      if (!Number.isFinite(patch.everyMs) || patch.everyMs < 60_000) throw new Error("A check-in runs at most once a minute.");
      state.everyMs = Math.round(patch.everyMs);
    }
    if (patch.pause !== undefined) {
      const now = Date.now();
      if (patch.pause === null) state.pausedUntil = null;
      else if (patch.pause === "forever") state.pausedUntil = "forever";
      else if (patch.pause === "1h") state.pausedUntil = now + 3600_000;
      else state.pausedUntil = nextRun({ kind: "daily", at: "09:00" }, now);
    }
    file.checkIn = state;
    this.save(chat, file);
    return this.checkIn(chat);
  }

  // The clock: due check-ins, duties and wakes

  start(everyMs = 30_000): void {
    this.timer = setInterval(() => void this.tick().catch(error => this.log(`board tick failed: ${String(error)}`)), everyMs);
  }
  stop(): void {
    clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<void> {
    for (const chat of this.chats()) {
      const file = this.file(chat);
      let dirty = false;
      if (file.checkIn) {
        const view = this.checkIn(chat);
        if (view.nextAt !== null && view.nextAt <= now && this.threads.thread(chat)?.status !== "running") {
          file.checkIn.lastAt = now;
          dirty = true;
          await this.host.submit(chat, {
            text: "[check-in] Read your board and your jobs, move each open step, and tell the owner only what needs him.", whenBusy: "followUp",
            requestId: `checkin:${chat}:${now}`, entry: { kind: "agent.message", data: { from: "board", via: "check-in" } },
          }).catch(error => this.log(`check-in for ${chat} failed: ${String(error)}`));
        }
      }
      for (const duty of file.duties) {
        if (duty.status !== "active") continue;
        if (nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt) > now) continue;
        await this.runDuty(chat, duty, "schedule").catch(error => this.log(`duty ${duty.id} for ${chat} failed: ${String(error)}`));
        dirty = true;
      }
      if (dirty) this.save(chat, file);
    }
    await this.deliverWakes(now);
  }

  /** A wake is one JSON file in `<data dir>/wakes/`: `{id, thread, conversation?, at, text}`, delivered once at `at`. */
  async deliverWakes(now: number): Promise<void> {
    const dir = join(this.store.dir, "wakes");
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter(n => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const wake = readJson<Wake | null>(join(dir, name), null);
      if (!wake || wake.at > now) continue;
      try {
        await this.host.submit(wake.thread, {
          ...(wake.conversation && wake.conversation !== 1 ? { conversation: wake.conversation } : {}),
          text: `[wake] ${wake.text}`, whenBusy: "followUp", requestId: `wake:${wake.id}`, entry: { kind: "agent.message", data: { from: "board", via: "wake" } },
        });
        rmSync(join(dir, name), { force: true });
      } catch (error) {
        this.log(`wake ${wake.id} failed: ${String(error)}`);
      }
    }
  }
}
