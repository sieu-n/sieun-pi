/**
 * Boards, For you, duties and check-ins. A chat's board is the `chat.board` document of its root conversation in pi-host, changed through
 * the board reducer copied from today's chat (web/src/lib/api/shared/chat-board.ts). Duties and the check-in clock live in the chat
 * server's data dir, and a due duty, check-in or wake reaches the chat as an input from "board".
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BoardOp, BoardRow, BoardView, ChatBoard, CheckInPatch, CheckInView, DutyAction, DutyView, ForYouItem, PlanItem } from "../web/src/lib/api/types.ts";
import { applyBoardOp, BOARD_PREFIX, emptyBoard, needsGo, nextIds, parseBoard, parseBoardOps, stepGo } from "../web/src/lib/api/shared/chat-board.ts";
import type { Duty, DutyRunRecord, DutySchedule, DutyTrigger } from "../web/src/lib/api/shared/chat-duties.ts";
import { DEFAULT_MODEL } from "./config.ts";
import { measure, runStamp } from "./duty-run.ts";
import { dutyCard, judgedRun, missStreak, type DutyCardModel } from "../web/src/lib/api/shared/duty-card.ts";
import type { ChatAgent } from "../web/src/lib/api/shared/types.ts";
import type { Host } from "./host/types.ts";
import { readJson, writeJson, type Store } from "./store.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import type { Threads } from "./threads.ts";

export const BOARD_DOC = "chat.board";
const DEFAULT_CHECK_IN_MS = 120 * 60_000;
const BOARD_TTL_MS = 15_000;

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
  /** Boards read in the last BOARD_TTL_MS; a doc event or an owner op replaces one at once. */
  private readonly cache = new Map<string, { board: ChatBoard | null; at: number }>();
  /** The one pi-host read in flight per chat, which every caller shares. */
  private readonly reading = new Map<string, Promise<ChatBoard | null>>();
  private timer?: NodeJS.Timeout;

  /** This server's own base URL, which a duty job's brief names for the board. */
  selfUrl = "http://127.0.0.1:5184";

  constructor(readonly host: Host, readonly store: Store, readonly threads: Threads, readonly events: BoardEvents, private readonly log: (line: string) => void = () => {}) {}

  chats(): string[] {
    return this.threads.threadsList().filter(t => !t.archived && this.threads.meta(t.id).kind === "chat").map(t => t.id);
  }

  async board(chat: string): Promise<ChatBoard | null> {
    const cached = this.cache.get(chat);
    if (cached && Date.now() - cached.at < BOARD_TTL_MS) return cached.board;
    return this.read(chat);
  }

  /**
   * The last board read for a list page, even past its TTL, with a fresh read behind it. A pi-host call waits behind every command queued
   * there, such as a search that takes seconds, so For you, the board index and the sidebar count wait on pi-host only for a chat never read.
   */
  private async known(chat: string): Promise<ChatBoard | null> {
    const cached = this.cache.get(chat);
    if (!cached) return this.read(chat);
    if (Date.now() - cached.at >= BOARD_TTL_MS) void this.read(chat).catch(error => this.log(`board read for ${chat} failed: ${String(error)}`));
    return cached.board;
  }

  private read(chat: string): Promise<ChatBoard | null> {
    let pending = this.reading.get(chat);
    if (!pending) {
      pending = this.fetchBoard(chat).finally(() => this.reading.delete(chat));
      this.reading.set(chat, pending);
    }
    return pending;
  }

  /** A failed read keeps the board read before it; a doc event or op that lands while the read runs wins over it. */
  private async fetchBoard(chat: string): Promise<ChatBoard | null> {
    const startedAt = Date.now();
    const result = await this.host.docGet(chat, BOARD_DOC).then(value => ({ value }), () => null);
    const cached = this.cache.get(chat);
    if (cached && cached.at > startedAt) return cached.board;
    const board = result ? (result.value ? parseBoard(result.value) : null) : (cached?.board ?? null);
    this.cache.set(chat, { board, at: Date.now() });
    if (cached && JSON.stringify(cached.board) !== JSON.stringify(board) && board) this.events.board(chat, board, awaitingGo(board));
    return board;
  }

  async view(chat: string): Promise<BoardView> {
    const board = await this.board(chat);
    return { board, awaitingGo: awaitingGo(board) };
  }

  /** The owner's board ops; each one also reaches the chat as a `[board]` line, as today. */
  async apply(chat: string, raw: unknown, actor: "owner" | "agent" = "owner"): Promise<BoardView> {
    const ops: BoardOp[] = parseBoardOps(raw);
    const now = new Date().toISOString();
    let board = (await this.board(chat)) ?? emptyBoard(now);
    const summaries: string[] = [];
    for (const op of ops) {
      const result = applyBoardOp(board, op, actor, now, nextIds(board));
      board = result.board;
      summaries.push(result.summary);
    }
    await this.host.docPut(chat, BOARD_DOC, board);
    this.cache.set(chat, { board, at: Date.now() });
    this.events.board(chat, board, awaitingGo(board));
    this.events.forYou(await this.forYouCount());
    if (summaries.length && actor === "owner") {
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
    this.cache.set(chat, { board, at: Date.now() });
    if (board) this.events.board(chat, board, awaitingGo(board));
  }

  async forYou(): Promise<ForYouItem[]> {
    const out: ForYouItem[] = [];
    const chats = this.chats();
    const boards = await Promise.all(chats.map(chat => this.known(chat)));
    for (const [i, chat] of chats.entries()) {
      const board = boards[i];
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
    const chats = this.chats();
    const boards = await Promise.all(chats.map(chat => this.known(chat)));
    for (const [i, chat] of chats.entries()) {
      const board = boards[i];
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

  /**
   * Brings a Prime chat's board, duties, their runs and its check-in interval into a moved thread, from Prime's chat data dir (read only):
   * `boards/<prime id>.json` becomes the thread's `chat.board`, `duties/<prime id>.json` and `.runs.jsonl` become its duties file, and
   * `check-in-settings.json` gives the interval. `durable_import` moves the transcript; this moves the rest. Running it again replaces both.
   */
  async importPrime(chat: string, primeId: string, primeDir: string): Promise<{ board: boolean; duties: number; runs: number; checkInMs: number | null }> {
    if (!/^[0-9a-f-]{36}$/.test(primeId)) throw new Error(`A Prime chat id is a session uuid, got ${primeId}.`);
    if (!this.threads.thread(chat)) await this.threads.refresh();
    if (!this.threads.thread(chat)) throw new Error(`No thread ${chat}.`);
    const boardFile = join(primeDir, "boards", `${primeId}.json`);
    const board = existsSync(boardFile) ? parseBoard(JSON.parse(readFileSync(boardFile, "utf8"))) : null;
    if (board) {
      await this.host.docPut(chat, BOARD_DOC, board);
      this.cache.set(chat, { board, at: Date.now() });
      this.events.board(chat, board, awaitingGo(board));
      this.events.forYou(await this.forYouCount());
    }
    const prime = readJson<{ duties?: Duty[]; checkIn?: { lastRunAt?: number } }>(join(primeDir, "duties", `${primeId}.json`), {});
    const runs: Record<string, DutyRunRecord[]> = {};
    const runsFile = join(primeDir, "duties", `${primeId}.runs.jsonl`);
    let runCount = 0;
    if (existsSync(runsFile)) {
      for (const line of readFileSync(runsFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const run = JSON.parse(line) as DutyRunRecord;
          (runs[run.duty] ??= []).push(run);
        } catch {
          continue;
        }
      }
      for (const id of Object.keys(runs)) {
        runs[id] = runs[id]!.sort((a, b) => b.at - a.at).slice(0, 20);
        runCount += runs[id]!.length;
      }
    }
    const everyMs = readJson<Record<string, { everyMs?: number }>>(join(primeDir, "check-in-settings.json"), {})[primeId]?.everyMs ?? null;
    const file = this.file(chat);
    file.duties = prime.duties ?? [];
    file.runs = Object.fromEntries(Object.entries(runs).filter(([id]) => file.duties.some(d => d.id === id)));
    file.checkIn = { everyMs: everyMs ?? file.checkIn?.everyMs ?? DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: prime.checkIn?.lastRunAt ?? null };
    this.save(chat, file);
    // Each duty's precheck state (`<duty>.state.json`) carries what the last run saw, so the next run reads changes since then.
    const stateDir = join(this.store.dir, "boards", chat, "duties");
    mkdirSync(stateDir, { recursive: true });
    for (const duty of file.duties) {
      const from = join(primeDir, "duties", primeId, `${duty.id}.state.json`);
      if (existsSync(from)) copyFileSync(from, join(stateDir, `${duty.id}.state.json`));
    }
    return { board: board !== null, duties: file.duties.length, runs: Object.values(file.runs).reduce((sum, list) => sum + list.length, 0), checkInMs: everyMs };
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
      const runs = [...(file.runs[duty.id] ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
      const view: DutyView = {
        duty: { id: duty.id, name: duty.name, ownerWords: duty.ownerWords, goal: duty.goal, metrics: duty.metrics, status: duty.status, ...(duty.boardGoal ? { boardGoal: duty.boardGoal } : {}) },
        schedule: duty.schedule, paused: duty.status === "paused", nextAt: duty.status === "paused" ? null : nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt),
        running: false, runs, priority: "normal",
      };
      const newest = runs[0];
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
    duty.updatedAt = Date.now();
    this.save(chat, file);
    if (action.action === "run") void this.runDuty(chat, duty, "owner");
    return this.duties(chat);
  }

  private readonly dutyRuns = new Map<string, Promise<void>>();

  /**
   * One duty run: the precheck, the judged record, and a duty job when something is due (`measure` in duty-run.ts). The job is a durable
   * thread filed under the chat; its final answer reaches the chat as an input from that job. A second start while one runs shares it.
   */
  private runDuty(chat: string, duty: Duty, trigger: DutyTrigger): Promise<void> {
    const key = `${chat}/${duty.id}`;
    const going = this.dutyRuns.get(key);
    if (going) return going;
    const run = this.runDutyOnce(chat, duty.id, trigger).catch(error => this.log(`duty ${key} failed: ${String(error)}`)).finally(() => this.dutyRuns.delete(key));
    this.dutyRuns.set(key, run);
    return run;
  }

  private async runDutyOnce(chat: string, dutyId: string, trigger: DutyTrigger): Promise<void> {
    const before = this.file(chat);
    const duty = before.duties.find(d => d.id === dutyId);
    if (!duty) return;
    duty.lastRunAt = Date.now();
    duty.runCount += 1;
    this.save(chat, before);
    const dir = join(this.store.dir, "boards", chat, "duties");
    const working = new Set(this.threads.agents().filter(a => a.status === "working").map(a => a.name));
    const { record, brief } = await measure({
      duty, chat: { id: chat, name: this.threads.thread(chat)?.name ?? chat }, dir, trigger, previous: before.runs[dutyId] ?? [], board: await this.board(chat),
      liveJob: job => working.has(job), boardApi: `${this.selfUrl}/api/threads/${chat}/board`, log: this.log,
    });
    if (brief) {
      const name = `${duty.name} duty ${runStamp(record.at)}`;
      try {
        const job = await this.host.create({ name, model: DEFAULT_MODEL, thinkingLevel: "high", ...(duty.precheck.cwd ? { cwd: duty.precheck.cwd } : {}) });
        this.store.state.threads[job.id] = { kind: "job", parent: chat };
        this.store.saveState();
        await this.threads.refresh().catch(() => undefined);
        const submitted = await this.host.submit(job.id, { text: brief, requestId: `duty:${chat}:${duty.id}:${record.at}`, entry: { kind: "agent.message", data: { from: chat, via: `duty ${duty.id}` } } });
        record.job = { id: job.id, name };
        void this.reportDutyJob(chat, duty, job.id, submitted.submission);
      } catch (error) {
        this.log(`duty ${chat}/${duty.id}: the duty job did not start: ${String(error)}`);
      }
    }
    const after = this.file(chat);
    after.runs[dutyId] = [record, ...(after.runs[dutyId] ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
    this.save(chat, after);
    this.log(`duty ${chat.slice(0, 8)}/${duty.id}: ${record.verdict}, ${record.summary}${record.job ? `, job ${record.job.name}` : ""}`);
  }

  /** Posts the duty job's final answer to the chat, unless it says there is nothing to report. */
  private async reportDutyJob(chat: string, duty: Duty, job: string, submission: number): Promise<void> {
    try {
      const settled = await this.host.wait(job, submission);
      if (settled.answer === undefined) return;
      const got = await this.host.entries(job, { before: settled.answer + 1, limit: 1 });
      const message = got.entries[0]?.model?.[0];
      const text = !message ? "" : typeof message.content === "string" ? message.content : message.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n\n");
      if (!text.trim() || /^nothing to report\.?$/i.test(text.trim())) return;
      await this.host.submit(chat, { text: `[duty ${duty.id}] ${text}`, whenBusy: "followUp", requestId: `duty-report:${job}`, entry: { kind: "agent.message", data: { from: job, via: `duty ${duty.id}` } } });
    } catch (error) {
      this.log(`duty ${chat}/${duty.id}: its job's report did not reach the chat: ${String(error)}`);
    }
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
      if (dirty) this.save(chat, file);
      // Each due duty runs on its own; runDuty writes the duties file itself, so the tick does not wait for a precheck.
      for (const duty of file.duties) {
        if (duty.status !== "active") continue;
        if (nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt) > now) continue;
        void this.runDuty(chat, duty, "schedule");
      }
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
