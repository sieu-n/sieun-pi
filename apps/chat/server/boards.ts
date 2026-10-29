/**
 * Boards, For you, duties and check-ins, keyed by agent id (`ag_<slug>`), or by thread id for a root chat no agent holds yet; a thread id
 * of an agent's work thread or root job resolves to the agent. An agent's board is the `chat.board` document of its work thread's root
 * conversation in pi-host, changed through the board reducer copied from today's chat (web/src/lib/api/shared/chat-board.ts), because
 * pi-host's `chat_board` tool reads it there. Duties and the check-in clock live in the chat server's data dir under `agents/<agent id>/`,
 * and a due duty, check-in or wake reaches the work thread as an input from "board". Wakes are server/wakes.ts.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardOp, BoardRow, BoardView, ChatBoard, CheckInPatch, CheckInView, DutyAction, DutyRow, DutyView, ForYouItem, PlanItem } from "../web/src/lib/api/types.ts";
import { applyBoardOp, BOARD_PREFIX, emptyBoard, needsGo, nextIds, parseBoard, parseBoardOps, stepGo } from "../web/src/lib/api/shared/chat-board.ts";
import type { Duty, DutyRunRecord, DutySchedule, DutyTrigger } from "../web/src/lib/api/shared/chat-duties.ts";
import { DEFAULT_MODEL } from "./config.ts";
import { asAfter, measure, measureAfter, runStamp } from "./duty-run.ts";
import { dutyCard, judgedRun, missStreak } from "../web/src/lib/api/shared/duty-card.ts";
import type { ChatAgent } from "../web/src/lib/api/shared/types.ts";
import type { Agents } from "./agents.ts";
import type { Host } from "./host/types.ts";
import { readJson, writeJson, type Store } from "./store.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import type { Threads } from "./threads.ts";
import { armWake, startThreadWakes, wakeTarget, type CheckResult } from "./wakes.ts";

export const BOARD_DOC = "chat.board";
const DEFAULT_CHECK_IN_MS = 120 * 60_000;
const BOARD_TTL_MS = 15_000;

interface CheckInState { everyMs: number; pausedUntil: number | "forever" | null; lastAt: number | null }
export interface DutyFile { duties: Duty[]; runs: Record<string, DutyRunRecord[]>; checkIn?: CheckInState }

export interface BoardEvents {
  board(chatId: string, board: ChatBoard, awaitingGo: string[]): void;
  forYou(count: number): void;
  /** A chat's duty rows after a run starts or ends or a duty changes, so an open Duties card shows the new run without a reload. */
  duties(chatId: string, duties: DutyRow[]): void;
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

const BOARDS_CACHE = "boards";

export class Boards {
  /** Boards read in the last BOARD_TTL_MS; a doc event or an owner op replaces one at once. */
  private readonly cache = new Map<string, { board: ChatBoard | null; at: number }>();
  /** The one pi-host read in flight per chat, which every caller shares. */
  private readonly reading = new Map<string, Promise<ChatBoard | null>>();
  private timer?: NodeJS.Timeout;
  private stopWakes?: () => void;

  /** This server's own base URL, which a duty job's brief names for the board. */
  selfUrl = "http://127.0.0.1:5184";
  /** The check of a thread's check wake when the thread runs on another box: that box's relay runs it. Undefined runs it here. */
  checkOn: (thread: string) => ((command: string, timeoutMs: number) => Promise<CheckResult>) | undefined = () => undefined;

  constructor(
    readonly host: Host,
    readonly store: Store,
    readonly threads: Threads,
    readonly agents: Agents,
    readonly events: BoardEvents,
    private readonly log: (line: string) => void = () => {},
  ) {
    // The boards of the last run, read again on first use, so For you and the sidebar count answer while pi-host starts.
    for (const [chat, board] of Object.entries(store.cache<Record<string, ChatBoard | null>>(BOARDS_CACHE, {}))) this.cache.set(chat, { board, at: 0 });
  }

  private remember(chat: string, board: ChatBoard | null): void {
    const changed = JSON.stringify(this.cache.get(chat)?.board ?? null) !== JSON.stringify(board) || !this.cache.has(chat);
    this.cache.set(chat, { board, at: Date.now() });
    if (changed) this.store.saveCache(BOARDS_CACHE, Object.fromEntries([...this.cache].map(([id, entry]) => [id, entry.board])));
  }

  /** The board's key for an agent id, a DM room, or a thread id: the agent's id, else the root chat's thread id. */
  chatId(id: string): string {
    return this.agents.record(id)?.id ?? id;
  }

  /** The thread whose `chat.board` doc and inputs belong to a board key. */
  threadOf(chat: string): string {
    return this.agents.record(chat)?.workThread ?? chat;
  }

  nameOf(chat: string): string {
    return this.threads.agent(chat)?.name ?? this.agents.record(chat)?.name ?? this.threads.thread(chat)?.name ?? chat;
  }

  /**
   * The folder of a board's duties, their precheck state and its check-in: `agents/<agent id>/`, or a root chat's `boards/<thread>/`. An agent
   * whose files the migration has not copied yet keeps reading and writing its old `boards/<thread>/` folder, so nothing it holds goes missing.
   */
  dir(chat: string): string {
    const record = this.agents.record(chat);
    if (!record) return join(this.store.dir, "boards", chat);
    const fresh = join(this.store.dir, "agents", record.id);
    const old = join(this.store.dir, "boards", record.workThread);
    return existsSync(fresh) || !existsSync(old) ? fresh : old;
  }

  /** The agents that are not archived, and the root chats no agent holds yet. */
  chats(): string[] {
    const agents = this.agents.list().filter(a => !(this.threads.thread(a.workThread)?.archived ?? a.archived)).map(a => a.id);
    return [...agents, ...this.agents.unrecorded(this.threads.threadsList()).map(t => t.id)];
  }

  async board(id: string): Promise<ChatBoard | null> {
    const chat = this.chatId(id);
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
    const result = await this.host.docGet(this.threadOf(chat), BOARD_DOC).then(value => ({ value }), () => null);
    const cached = this.cache.get(chat);
    if (cached && cached.at > startedAt) return cached.board;
    const board = result ? (result.value ? parseBoard(result.value) : null) : (cached?.board ?? null);
    this.remember(chat, board);
    if (cached && JSON.stringify(cached.board) !== JSON.stringify(board)) {
      if (board) this.events.board(chat, board, awaitingGo(board));
      void this.forYouCount().then(count => this.events.forYou(count), () => undefined);
    }
    return board;
  }

  async view(id: string): Promise<BoardView> {
    const board = await this.board(id);
    return { board, awaitingGo: awaitingGo(board) };
  }

  /**
   * The owner's or an agent's board ops; each of the owner's also reaches the chat as a `[board]` line, as today. The answer carries each op's
   * summary line, which the chat's own `chat_board` call returns to it (packages/pi-host/src/durable/prime-chat.ts), as Prime's agent-board route does.
   */
  async apply(id: string, raw: unknown, actor: "owner" | "agent" = "owner"): Promise<BoardView & { summaries: string[] }> {
    const chat = this.chatId(id);
    const thread = this.threadOf(chat);
    const ops: BoardOp[] = parseBoardOps(raw);
    const now = new Date().toISOString();
    let board = (await this.board(chat)) ?? emptyBoard(now);
    const summaries: string[] = [];
    for (const op of ops) {
      const result = applyBoardOp(board, op, actor, now, nextIds(board));
      board = result.board;
      summaries.push(result.summary);
    }
    await this.host.docPut(thread, BOARD_DOC, board);
    this.remember(chat, board);
    this.events.board(chat, board, awaitingGo(board));
    this.events.forYou(await this.forYouCount());
    if (summaries.length && actor === "owner") {
      await this.host.submit(thread, {
        text: `${BOARD_PREFIX}${summaries.join("\n")}`, whenBusy: "followUp", requestId: `board:${chat}:${board.rev}`,
        entry: { kind: "agent.message", data: { from: "owner", via: "board" } },
      }).catch(error => this.log(`board note to ${chat} failed: ${String(error)}`));
    }
    return { board, awaitingGo: awaitingGo(board), summaries };
  }

  /** A doc event from pi-host: the thread wrote its board. */
  docChanged(thread: string, value: unknown): void {
    const chat = this.chatId(thread);
    const board = value ? parseBoard(value) : null;
    this.remember(chat, board);
    if (board) this.events.board(chat, board, awaitingGo(board));
  }

  async forYou(): Promise<ForYouItem[]> {
    const out: ForYouItem[] = [];
    // A walk's test agent has no place in the owner's For you list or its badge.
    const chats = this.chats().filter(chat => !this.agents.store.isTest(chat));
    const boards = await Promise.all(chats.map(chat => this.known(chat)));
    for (const [i, chat] of chats.entries()) {
      const board = boards[i];
      if (!board) continue;
      const steps = new Map<string, PlanItem>();
      walk(board.plan, item => steps.set(item.id, item));
      for (const todo of board.todos) {
        const step = todo.step ? steps.get(todo.step) : undefined;
        out.push({ chatId: chat, chatName: this.nameOf(chat), todo, ...(step ? { step: { id: step.id, text: step.text, status: step.status } } : {}) });
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
        chatId: chat, chatName: this.nameOf(chat), rev: board.rev, progress: { done, total },
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
   * `check-in-settings.json` gives the interval. `durable_import` moves the transcript; this moves the rest. Running it again replaces the board
   * and the duties, and keeps the runs this server recorded since, merged with the imported ones by their start time.
   */
  async importPrime(id: string, primeId: string, primeDir: string): Promise<{ board: boolean; duties: number; runs: number; checkInMs: number | null }> {
    if (!/^[0-9a-f-]{36}$/.test(primeId)) throw new Error(`A Prime chat id is a session uuid, got ${primeId}.`);
    const chat = this.chatId(id);
    if (!this.threads.thread(this.threadOf(chat))) await this.threads.refresh();
    if (!this.threads.thread(this.threadOf(chat))) throw new Error(`No thread ${id}.`);
    const boardFile = join(primeDir, "boards", `${primeId}.json`);
    const board = existsSync(boardFile) ? parseBoard(JSON.parse(readFileSync(boardFile, "utf8"))) : null;
    if (board) {
      await this.host.docPut(this.threadOf(chat), BOARD_DOC, board);
      this.remember(chat, board);
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
    const kept = file.runs ?? {};
    file.runs = Object.fromEntries(file.duties.flatMap(duty => {
      const merged = new Map([...(runs[duty.id] ?? []), ...(kept[duty.id] ?? [])].map(run => [run.at, run] as const));
      return merged.size ? [[duty.id, [...merged.values()].sort((a, b) => b.at - a.at).slice(0, 20)]] : [];
    }));
    file.checkIn = { everyMs: everyMs ?? file.checkIn?.everyMs ?? DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: prime.checkIn?.lastRunAt ?? null };
    this.save(chat, file);
    // Each duty's precheck state (`<duty>.state.json`) carries what the last run saw, so the next run reads changes since then.
    const stateDir = join(this.dir(chat), "duties");
    mkdirSync(stateDir, { recursive: true });
    for (const duty of file.duties) {
      const from = join(primeDir, "duties", primeId, `${duty.id}.state.json`);
      if (existsSync(from)) copyFileSync(from, join(stateDir, `${duty.id}.state.json`));
    }
    return { board: board !== null, duties: file.duties.length, runs: Object.values(file.runs).reduce((sum, list) => sum + list.length, 0), checkInMs: everyMs };
  }

  // Duties and check-ins

  /** The file of a board's duties, their runs and its check-in. */
  dutiesPath(id: string): string {
    return join(this.dir(this.chatId(id)), "duties.json");
  }
  private file(chat: string): DutyFile {
    return readJson<DutyFile>(this.dutiesPath(chat), { duties: [], runs: {} });
  }
  private save(chat: string, file: DutyFile): void {
    writeJson(this.dutiesPath(chat), file);
  }

  /** The jobs of an agent: the conversations inside its work thread, and its root job threads. */
  chatAgents(id: string): ChatAgent[] {
    const chat = this.chatId(id);
    const thread = this.threadOf(chat);
    return this.threads.allSummaries({ archived: false }).filter(a => a.kind === "job" && ((a.thread === thread && a.conversation !== 1) || a.parent?.id === chat)).map(a => ({
      key: `thread:${a.id}`, sessionId: a.id, name: a.name, job: a.name, sender: a.name, link: a.thread === thread ? "subagent" as const : "root" as const,
      state: a.status === "working" ? "working" as const : a.status === "failed" ? "failed" as const : "idle" as const,
      ...(a.preview ? { activity: a.preview } : {}), lastActivityAt: new Date(a.updatedAt).toISOString(), steps: [],
    }));
  }

  duties(id: string): DutyRow[] {
    const chat = this.chatId(id);
    const file = this.file(chat);
    const agents = this.chatAgents(chat);
    return file.duties.map(duty => {
      const runs = [...(file.runs[duty.id] ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
      const view: DutyView = {
        duty: { id: duty.id, name: duty.name, ownerWords: duty.ownerWords, goal: duty.goal, metrics: duty.metrics, status: duty.status, ...(duty.boardGoal ? { boardGoal: duty.boardGoal } : {}) },
        schedule: duty.schedule, paused: duty.status === "paused", nextAt: duty.status === "paused" ? null : nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt),
        running: this.dutyRuns.has(`${chat}/${duty.id}`), runs, priority: "normal",
      };
      const newest = runs[0];
      const judged = newest ? judgedRun(newest, duty.metrics) : null;
      return {
        ...view, card: dutyCard(view, agents),
        last: newest && judged ? { verdict: judged.verdict, at: newest.at, streak: missStreak(runs, duty.metrics), afterJob: newest.after !== undefined } : null,
      };
    });
  }

  async dutyAction(id: string, action: DutyAction): Promise<DutyRow[]> {
    const chat = this.chatId(id);
    const file = this.file(chat);
    const duty = file.duties.find(d => d.id === action.duty);
    if (!duty) throw new Error(`No duty ${action.duty} on this chat.`);
    if (action.action === "pause") duty.status = "paused";
    else if (action.action === "resume") duty.status = "active";
    else if (action.action === "schedule") duty.schedule = action.schedule as DutySchedule;
    duty.updatedAt = Date.now();
    this.save(chat, file);
    if (action.action === "run") void this.runDuty(chat, duty, "owner");
    else this.events.duties(chat, this.duties(chat));
    return this.duties(chat);
  }

  private readonly dutyRuns = new Map<string, Promise<void>>();
  /** The after-job measure going per `<chat>/<duty>` (`afterJob`); a due run of the duty waits for it, as in Prime's `Duties.afters`. */
  private readonly afters = new Map<string, Promise<void>>();
  /** Duty jobs whose first turn this process still waits on (`reportDutyJob`), so a thread list read before their submit cannot read them as ended. */
  private readonly waiting = new Set<string>();
  /** The duties whose last job's end is being read now (`jobEnded`), so a tick reads each once. */
  private readonly endChecks = new Set<string>();

  /**
   * One duty run: the precheck, the judged record, and a duty job when something is due (`measure` in duty-run.ts). The job is a durable
   * thread filed under the chat; what it sends reaches the chat as an input from that job (`reportDutyJob`). A second start while one runs shares it.
   */
  private runDuty(chat: string, duty: Duty, trigger: DutyTrigger): Promise<void> {
    const key = `${chat}/${duty.id}`;
    const going = this.dutyRuns.get(key);
    if (going) return going;
    // A run waits for the after-job measure going on the duty, so the two never run its precheck side by side (Prime's push waits the same way).
    const run = (this.afters.get(key) ?? Promise.resolve()).then(() => this.runDutyOnce(chat, duty.id, trigger)).catch(error => this.log(`duty ${key} failed: ${String(error)}`)).finally(() => {
      this.dutyRuns.delete(key);
      this.events.duties(chat, this.duties(chat));
    });
    this.dutyRuns.set(key, run);
    this.events.duties(chat, this.duties(chat));
    return run;
  }

  private async runDutyOnce(chat: string, dutyId: string, trigger: DutyTrigger): Promise<void> {
    const before = this.file(chat);
    const duty = before.duties.find(d => d.id === dutyId);
    if (!duty) return;
    duty.lastRunAt = Date.now();
    duty.runCount += 1;
    this.save(chat, before);
    const dir = join(this.dir(chat), "duties");
    const thread = this.threadOf(chat);
    const working = new Set(this.threads.allSummaries().filter(a => a.status === "working").map(a => a.name));
    const { record, brief } = await measure({
      duty, chat: { id: chat, name: this.nameOf(chat) }, dir, trigger, previous: before.runs[dutyId] ?? [], board: await this.board(chat),
      liveJob: job => working.has(job), boardApi: `${this.selfUrl}/api/threads/${thread}/board`, log: this.log,
    });
    if (brief) {
      const name = `${duty.name} duty ${runStamp(record.at)}`;
      try {
        // The duty job works where its precheck runs, else in its chat's project folder, so it reads that folder's AGENTS.md chain.
        const cwd = duty.precheck.cwd || this.threads.thread(thread)?.cwd;
        const job = await this.host.create({ name, model: DEFAULT_MODEL, thinkingLevel: "high", ...(cwd ? { cwd } : {}) });
        this.store.state.threads[job.id] = { kind: "job", parent: chat };
        this.store.saveState();
        this.agents.alias(job.id, chat);
        await this.threads.refresh().catch(() => undefined);
        const submitted = await this.host.submit(job.id, { text: brief, requestId: `duty:${chat}:${duty.id}:${record.at}`, entry: { kind: "agent.message", data: { from: chat, via: `duty ${duty.id}` } } });
        record.job = { id: job.id, name };
        void this.reportDutyJob(chat, duty, job.id, submitted.submission);
      } catch (error) {
        this.log(`duty ${chat}/${duty.id}: the duty job did not start: ${String(error)}`);
      }
    }
    const after = this.file(chat);
    // The last job's run with no after-job measure yet takes this run's measure, as Prime's `launch` writes it, unless that job still works
    // and this run started none, since then the job's own end measures it (`afterJob`).
    const lastRun = (after.runs[dutyId] ?? []).filter(run => run.job).sort((a, b) => b.at - a.at)[0];
    const measured = asAfter(record);
    if (lastRun?.job && !lastRun.after && measured && (record.job || !working.has(lastRun.job.name))) lastRun.after = measured;
    after.runs[dutyId] = [record, ...(after.runs[dutyId] ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
    this.save(chat, after);
    this.log(`duty ${chat.slice(0, 8)}/${duty.id}: ${record.verdict}, ${record.summary}${record.job ? `, job ${record.job.name}` : ""}`);
  }

  /**
   * Posts what the duty job sent with send_message to the chat, as one input; a job that never called it posts its final answer. Nothing
   * sent, or "nothing to report", posts nothing.
   */
  private async reportDutyJob(chat: string, duty: Duty, job: string, submission: number): Promise<void> {
    this.waiting.add(job);
    try {
      const settled = await this.host.wait(job, submission);
      const text = (await this.threads.said(job, 1, settled)).map(m => m.text).join("\n\n");
      if (!text.trim() || /^nothing to report\.?$/i.test(text.trim())) return;
      await this.host.submit(this.threadOf(chat), { text: `[duty ${duty.id}] ${text}`, whenBusy: "followUp", requestId: `duty-report:${job}`, entry: { kind: "agent.message", data: { from: job, via: `duty ${duty.id}` } } });
    } catch (error) {
      this.log(`duty ${chat}/${duty.id}: its job's report did not reach the chat: ${String(error)}`);
    } finally {
      this.waiting.delete(job);
      await this.threads.refresh().catch(() => undefined);
      void this.afterJob(chat, duty.id);
    }
  }

  /**
   * Whether a duty job has ended, as Prime's `jobs.ended` reads it: its thread is listed and idle with no wake set on it, in pi-host or in this
   * server's wake files, and every conversation of its tree is idle, read from pi-host now. A failed job is not ended: its run keeps its own verdict.
   */
  private async jobEnded(job: string): Promise<boolean> {
    const row = this.threads.thread(job);
    if (!row || row.status !== "idle" || row.wakeAt !== undefined || this.waiting.has(job)) return false;
    let names: string[] = [];
    try { names = readdirSync(this.wakeDir).filter(name => name.endsWith(".json")); } catch { names = []; }
    for (const name of names) {
      const session = readJson<{ session?: unknown }>(join(this.wakeDir, name), {}).session;
      if (typeof session === "string" && wakeTarget(session).thread === job) return false;
    }
    const nodes = await this.host.tree(job).catch(() => null);
    return nodes !== null && nodes.every(node => node.status === "idle");
  }

  /**
   * Measures a duty's last job's run again once that job has ended (Prime's `Duties.endJob` and `measureAfter`), and writes the measure into
   * the run as `after`, which the card reads as the run's verdict and streak once its job's fixes are in (`effectiveRun`). Only the duty's newest
   * run with a job is looked at; an older one gets the next run's measure (`runDutyOnce`). One measure goes per duty, and none beside a run of it.
   */
  afterJob(chat: string, dutyId: string): Promise<void> {
    const key = `${chat}/${dutyId}`;
    const going = this.afters.get(key);
    if (going) return going;
    if (this.dutyRuns.has(key) || this.endChecks.has(key)) return Promise.resolve();
    const file = this.file(chat);
    const duty = file.duties.find(d => d.id === dutyId);
    const runs = [...(file.runs[dutyId] ?? [])].sort((a, b) => b.at - a.at);
    const run = runs.find(entry => entry.job);
    if (!duty || !run?.job || run.after) return Promise.resolve();
    const job = run.job;
    this.endChecks.add(key);
    return this.jobEnded(job.id).catch(() => false).then(ended => {
      this.endChecks.delete(key);
      if (!ended || this.dutyRuns.has(key) || this.afters.has(key)) return;
      const task = (async () => {
        const after = await measureAfter({ duty, dir: join(this.dir(chat), "duties"), runs, log: this.log });
        const latest = this.file(chat);
        const target = latest.runs[dutyId]?.find(entry => entry.at === run.at);
        if (!target || target.after) return;
        target.after = after;
        this.save(chat, latest);
        this.log(`duty ${chat.slice(0, 8)}/${dutyId}: after its job ${job.name}, ${after.verdict}, ${after.summary}`);
        this.events.duties(chat, this.duties(chat));
      })().catch(error => this.log(`duty ${key}: the after-job measure of ${job.name} failed: ${String(error)}`)).finally(() => this.afters.delete(key));
      this.afters.set(key, task);
      return task;
    });
  }

  /**
   * A board's check-in setting: the one its file holds, else every 2 hours from the agent's or root chat's start. A walk's test agent gets no
   * check-in until one is set for it.
   */
  private checkInState(chat: string, file = this.file(chat)): CheckInState | null {
    if (file.checkIn) return file.checkIn;
    return this.agents.store.isTest(chat) ? null : { everyMs: DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: null };
  }

  checkIn(id: string): CheckInView {
    const chat = this.chatId(id);
    const state = this.checkInState(chat);
    if (!state) return { everyMs: DEFAULT_CHECK_IN_MS, paused: false, pausedUntil: null, nextAt: null, lastAt: null };
    const now = Date.now();
    const paused = state.pausedUntil === "forever" || (typeof state.pausedUntil === "number" && state.pausedUntil > now);
    const base = state.lastAt ?? this.agents.record(chat)?.createdAt ?? this.threads.thread(this.threadOf(chat))?.createdAt ?? now;
    return {
      everyMs: state.everyMs, paused, pausedUntil: paused ? state.pausedUntil : null,
      nextAt: paused ? (state.pausedUntil === "forever" ? null : Math.max(state.pausedUntil as number, base + state.everyMs)) : base + state.everyMs, lastAt: state.lastAt,
    };
  }

  setCheckIn(id: string, patch: CheckInPatch): CheckInView {
    const chat = this.chatId(id);
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
    this.stopWakes = startThreadWakes({ dir: this.wakeDir, host: this.host, log: this.log, checkOn: thread => this.checkOn(thread) });
  }
  stop(): void {
    clearInterval(this.timer);
    this.stopWakes?.();
  }

  async tick(now = Date.now()): Promise<void> {
    for (const chat of this.chats()) {
      const file = this.file(chat);
      let dirty = false;
      const state = this.checkInState(chat, file);
      if (state) {
        const view = this.checkIn(chat);
        if (view.nextAt !== null && view.nextAt <= now && this.threads.thread(this.threadOf(chat))?.status !== "running") {
          file.checkIn = { ...state, lastAt: now };
          dirty = true;
          await this.host.submit(this.threadOf(chat), {
            text: "[check-in] Read your board and your jobs, move each open step, and tell the owner only what needs him.", whenBusy: "followUp",
            requestId: `checkin:${chat}:${now}`, entry: { kind: "agent.message", data: { from: "board", via: "check-in" } },
          }).catch(error => this.log(`check-in for ${chat} failed: ${String(error)}`));
        }
      }
      if (dirty) this.save(chat, file);
      // Each due duty runs on its own; runDuty writes the duties file itself, so the tick does not wait for a precheck.
      for (const duty of file.duties) {
        void this.afterJob(chat, duty.id);
        if (duty.status !== "active" || this.afters.has(`${chat}/${duty.id}`)) continue;
        if (nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt) > now) continue;
        void this.runDuty(chat, duty, "schedule");
      }
    }
  }

  get wakeDir(): string {
    return join(this.store.dir, "wakes");
  }

  /**
   * Sets a wake for a thread's conversation, as the board skill's `board.wake(...)` asks for it from a durable thread's kernel: a run, a time
   * or a check (server/wakes.ts). The same file id twice writes one file, so a retried request sets one wake.
   */
  async addWake(id: string, body: Record<string, unknown>): ReturnType<typeof armWake> {
    const thread = this.threadOf(this.chatId(id));
    if (!this.threads.thread(thread)) await this.threads.refresh().catch(() => undefined);
    if (!this.threads.thread(thread)) throw new Error(`No thread ${thread}.`);
    const remote = this.checkOn(thread);
    return remote ? armWake(this.wakeDir, thread, body, remote) : armWake(this.wakeDir, thread, body);
  }
}
