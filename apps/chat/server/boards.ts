/**
 * Boards, For you, duties and check-ins, keyed by agent id (`ag_<slug>`), or by thread id for a root chat no agent holds yet; a thread id
 * of an agent's work thread or root job resolves to the agent. An agent's board is the `chat.board` document of its work thread's root
 * conversation in pi-host, changed through the board reducer copied from today's chat (web/src/lib/api/shared/chat-board.ts), because
 * pi-host's `chat_board` tool reads it there. Duties and the check-in clock live in a duties file per board (duties-db.ts), and their
 * precheck files in the chat server's data dir under `agents/<agent id>/`.
 * A due duty or check-in starts a job filed under the agent, whose report reaches the work thread as an input from that job, and a due wake
 * reaches the thread that set it. Check-in jobs are server/check-in-job.ts, wakes server/wakes.ts.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentSummary, BoardOp, BoardRow, BoardView, BoardWrite, ChatBoard, CheckInPatch, CheckInView, DutyAction, DutyRow, DutyView, ForYouItem, PlanItem } from "../web/src/lib/api/types.ts";
import { applyBoardOp, BOARD_PREFIX, emptyBoard, needsGo, nextIds, parseBoard, parseBoardOps, stepGo } from "../web/src/lib/api/shared/chat-board.ts";
import { snoozed, waitingAsks } from "../web/src/lib/api/shared/snooze.ts";
import { newestAskFirst } from "../web/src/lib/api/shared/board-lists.ts";
import { boardDelta, boardKey, boardStep } from "../web/src/lib/api/shared/board-delta.ts";
import { morningTime, upsertDuty, type AfterMeasure, type Duty, type DutyRunRecord, type DutySchedule, type DutyTrigger } from "../web/src/lib/api/shared/chat-duties.ts";
import { asAfter, clearPrecheck, measure, measureAfter, runStamp, type PrecheckLaunch } from "./duty-run.ts";
import { dutyCard, judgedRun, missStreak } from "../web/src/lib/api/shared/duty-card.ts";
import type { ChatAgent } from "../web/src/lib/api/shared/types.ts";
import { threadModel, type Agents } from "./agents.ts";
import { agentFolderDir } from "./agent-folder.ts";
import { checkInDetail, checkInIdle, checkInJobBrief, checkInJobName, checkInPrecheck, checkInPrompt, datedName, planEveryMs, planHasOpenStep } from "./check-in-job.ts";
import type { Host } from "./host/types.ts";
import { readJson, type Store } from "./store.ts";
import type { BoardWriteStore } from "./board-writes-db.ts";
import type { DutyStore } from "./duties-db.ts";
import { retryWait, type Outbox } from "./outbox.ts";
import type { SearchSplit } from "./search-engine.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import type { Threads } from "./threads.ts";
import { StepOwners } from "./step-owners.ts";
import { armWake, startThreadWakes, wakeSession, wakeTarget, type BoxCheckRun, type ThreadWakeOptions, type Wake } from "./wakes.ts";
import type { WakeStore } from "./wakes-db.ts";

export const BOARD_DOC = "chat.board";

/** The runs that name the duty job `job`, in the order given: the run that started it and each later run measured beside it (`runDutyOnce`). */
const runsOfJob = (runs: readonly DutyRunRecord[], job: string): DutyRunRecord[] => runs.filter(run => run.job?.id === job);

/**
 * Writes the after-job measure of `job` onto each run that names it and has none, and returns them. A run that started after the measure was
 * taken keeps its own newer reading, so an older reading never turns a later met run red.
 */
export function landAfter(runs: readonly DutyRunRecord[], job: string, after: AfterMeasure): DutyRunRecord[] {
  const targets = runsOfJob(runs, job).filter(run => !run.after && run.at <= after.at);
  for (const run of targets) run.after = after;
  return targets;
}

/**
 * The names of the jobs at work: each summary that works or has a pending wake (its `<thread>--<conversation>` in `waking`), and every summary
 * above it through `parent`. A job that is idle only because it waits on its own working subagents, or on a wake it or a subagent set, counts
 * as working: a duty brief once called such jobs "not working", and duty runs nearly started duplicate fix jobs (11-21, p155-fix on a check wake).
 */
export function workingJobs(summaries: readonly AgentSummary[], waking: ReadonlySet<string>): Set<string> {
  const byId = new Map(summaries.map(a => [a.id, a]));
  const names = new Set<string>();
  const seen = new Set<string>();
  for (const summary of summaries) {
    if (summary.status !== "working" && !waking.has(wakeSession(summary.thread, summary.conversation))) continue;
    for (let at: AgentSummary | undefined = summary; at && !seen.has(at.id); at = at.parent ? byId.get(at.parent.id) : undefined) {
      seen.add(at.id);
      names.add(at.name);
    }
  }
  return names;
}

/** Prime's CHECK_IN_MS (legacy/prime/user-history/src/checkin-settings.ts). */
const DEFAULT_CHECK_IN_MS = 120 * 60_000;
/** Prime's CHECK_IN_RETRY_MS (chats.ts): a check-in whose job did not start tries again this soon, not a whole interval later. */
const CHECK_IN_RETRY_MS = 5 * 60_000;

/** A board's check-in setting, its last run, and the last check-in job it started, which a run skips behind while it works. */
interface CheckInState {
  everyMs: number; pausedUntil: number | "forever" | null; lastAt: number | null;
  /** `submission` is the job's first input and `reported` is set once its report went to the work thread (`reportCheckIn`). */
  job?: { id: string; name: string; submission?: number; reported?: true; archived?: true };
  /**
   * A check-in job that did not start yet, until a try lands (`runCheckIn`): `at` is the run whose request id its brief goes under, and
   * `job` the thread a failed try made, which the next try submits to instead of making another.
   */
  start?: { at: number; name: string; job?: { id: string } };
}
/**
 * A duty's precheck at work, per duty id, from its launch until the save that records its run (`run`) or its run's after-job measure
 * (`after`, on the run at `run`), so the next server process waits for it and records it after a restart (`resumePrechecks`). A run's `job`
 * is the duty job it made, which a resumed run submits to again instead of making a second one.
 */
export type PendingPrecheck = { at: number; launch: PrecheckLaunch }
  & ({ mode: "run"; trigger: DutyTrigger; job?: { id: string; name: string } } | { mode: "after"; run: number; job: string });
/**
 * `hidden` is when the owner hid the board from All boards and the Board sidebar; it still opens by its link. `lastId` is the number of the
 * highest duty id the board ever gave, which a remove writes, so a new duty never takes a removed duty's id (`dutyIdFloor`).
 */
export interface DutyFile {
  duties: Duty[]; runs: Record<string, DutyRunRecord[]>; pending?: Record<string, PendingPrecheck>; starts?: Record<string, DutyStart>; checkIn?: CheckInState;
  hidden?: number; lastId?: number;
}
/**
 * A duty job that did not start yet, per duty id, until a try lands (`startDutyJob`): pi-host refused its thread create or its brief's submit,
 * as it does while it restarts for an install. `run` is the `at` of the run whose record names the job once it starts, `job` the thread a
 * failed try made, which the next try submits to, and `retryAt` when the tick tries again.
 */
export interface DutyStart { run: number; name: string; brief: string; cwd?: string; job?: { id: string; name: string }; failures: number; retryAt: number }

/** The highest duty id number a duties file names: in `lastId`, a duty, its runs or a precheck at work. */
const dutyIdFloor = (file: DutyFile): number =>
  Math.max(file.lastId ?? 0, ...[...file.duties.map(duty => duty.id), ...Object.keys(file.runs ?? {}), ...Object.keys(file.pending ?? {})].map(id => Number(id.slice(1)) || 0));

/**
 * What a board change does to the two lists of every board: the chat's row in All boards and its asks in For you, or a null row and no
 * asks for a chat neither list shows, such as a walk's test agent. The page swaps them into its kept answers of GET /api/boards and GET
 * /api/for-you, so a board change needs no read of either: on 11-21 each change read both again, and his Board list waited 391 to 2,705 ms
 * behind 5 to 8 For you reads at a time (requests/2026-11-21.jsonl).
 */
export interface BoardLists { row: BoardRow | null; forYou: ForYouItem[] }

/**
 * Where the boards keep their records, in JSON files or chat.sqlite as APPS_CHAT_DB_KINDS says: the duties files, the board writes pi-host
 * has not taken and the wakes.
 */
export interface BoardsDb { duties: DutyStore; writes: BoardWriteStore; wakes: WakeStore }

export interface BoardEvents {
  /** `before` is the board kept before the change, null for a chat read for the first time. */
  board(chatId: string, board: ChatBoard, awaitingGo: string[], lists: BoardLists, before: ChatBoard | null): void;
  /** A chat's row in All boards after its duties file changed what the row shows, such as a check-in's next time or a duty's verdict. */
  row(chatId: string, row: BoardRow): void;
  forYou(count: number): void;
  /** Open For you asks whose Remind me came due, which the page notifies about (notices.ts). */
  asksDue?(items: ForYouItem[], at: number): void;
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
const readFileSafe = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

export class Boards {
  /** The boards kept, from pi-host, a doc event, a write, or the last run's file (`at` 0); a doc event or a write replaces one at once. */
  private readonly cache = new Map<string, { board: ChatBoard | null; at: number }>();
  /**
   * The chats whose kept board is pi-host's, read or written by this process. This server writes every board (`apply`, `importPrime`) and
   * pi-host's doc events bring the rest, so such a board is never read from pi-host again, and a write never waits on a read, which queues
   * behind pi-host's event loop as a put does (59 ms p50 and 379 ms p90 at box load 190 to 220 on 11-22, ~/work/p155-config).
   */
  private readonly loaded = new Set<string>();
  /** The one pi-host read in flight per chat, which every caller shares. */
  private readonly reading = new Map<string, Promise<ChatBoard | null>>();
  /**
   * Board writes answered but not yet in pi-host, by chat, kept in `db.writes` until their put lands (`putBoards`). A put waits behind
   * every command on pi-host's event loop: on 11-23 two of 100 walk writes waited 3,495 and 3,725 ms in the handler (p50 48.5 ms) while pi-host
   * reopened a session for a heartbeat and built 2,558 rows for an `agent_observe.list_agents()` (~/work/p231-slow-calls/p231-board-handler).
   */
  private readonly unput = new Map<string, ChatBoard>();
  /** The one put loop per chat, which writes its newest unput board until none is left. */
  private readonly putting = new Map<string, Promise<void>>();
  private putsStopped = false;
  /** Counts the For you count sends, so a count read before a later write never goes out after it. */
  private forYouSent = 0;
  private timer?: NodeJS.Timeout;
  /** Sends the For you count again when the soonest Remind me on an open todo comes due. */
  private snoozeTimer?: NodeJS.Timeout;
  /** Up to when the asks that came due were sent; a Remind me that falls due while the server is down sends none. */
  private dueSentTo = Date.now();
  private stopWakes?: () => void;
  /** Tells each chat what nobody owns on its board (server/step-owners.ts), on every tick. */
  readonly owners: StepOwners;

  /** This server's own base URL, which a duty job's brief names for the board. */
  selfUrl = "http://127.0.0.1:5184";
  /** The check of a thread's check wake when the thread runs on another box: that box's relay runs it. Undefined runs it here. */
  checkOn: (thread: string) => BoxCheckRun | undefined = () => undefined;
  /** What a due wake's text becomes before it goes out, and what runs once it went out: Remind me's agent reminders (later-agents.ts). */
  wakeHooks?: Pick<ThreadWakeOptions, "expand" | "delivered">;
  /** Where the owner's `[board]` line goes: the app's outbox, which keeps it on disk until pi-host takes it. */
  sends: Pick<Outbox, "submit"> = { submit: async (thread, input, after) => (await after, this.host.submit(thread, input)) };

  constructor(
    readonly host: Host,
    readonly store: Store,
    readonly threads: Threads,
    readonly agents: Agents,
    readonly db: BoardsDb,
    readonly events: BoardEvents,
    private readonly log: (line: string) => void = () => {},
  ) {
    // The boards of the last run, read again on first use, so For you and the sidebar count answer while pi-host starts.
    for (const [chat, board] of Object.entries(store.cache<Record<string, ChatBoard | null>>(BOARDS_CACHE, {}))) this.cache.set(chat, { board, at: 0 });
    // The writes the last process answered and had not put into pi-host yet; `start` puts them, and every read answers them meanwhile.
    for (const [chat, board] of db.writes.all()) {
      this.unput.set(chat, board);
      this.cache.set(chat, { board, at: Date.now() });
    }
    this.owners = new StepOwners(this, log);
  }

  /** Keeps a chat's board read or written now, and answers the one kept before it, which its board event's delta starts from. */
  private remember(chat: string, board: ChatBoard | null): ChatBoard | null {
    const before = this.cache.get(chat)?.board ?? null;
    const changed = JSON.stringify(before) !== JSON.stringify(board) || !this.cache.has(chat);
    this.cache.set(chat, { board, at: Date.now() });
    this.loaded.add(chat);
    if (changed) this.store.saveCache(BOARDS_CACHE, Object.fromEntries([...this.cache].map(([id, entry]) => [id, entry.board])));
    return before;
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
    if (this.unput.has(chat)) return this.unput.get(chat)!;
    if (this.loaded.has(chat)) return this.cache.get(chat)?.board ?? null;
    return this.read(chat);
  }

  /**
   * The board kept for a list page, the last run's one with a read behind it until this process read it. A pi-host call waits behind every
   * command queued there, such as a search that takes seconds, so For you, the board index and the sidebar count wait on pi-host only for a
   * chat with no board kept at all.
   */
  private async known(chat: string): Promise<ChatBoard | null> {
    if (this.unput.has(chat)) return this.unput.get(chat)!;
    const cached = this.cache.get(chat);
    if (this.loaded.has(chat)) return cached?.board ?? null;
    if (!cached) return this.read(chat);
    void this.read(chat).catch(error => this.log(`board read for ${chat} failed: ${String(error)}`));
    return cached.board;
  }

  /**
   * The board kept of a chat or agent (`known`), for a page that shows the board's counts
   * beside other data. A read of it waits behind every command queued on pi-host's socket: 59 ms at p50 and 379 ms at p90 in a probe at box
   * load 190 to 220 on 11-22 (~/work/p155-config).
   */
  latest(id: string): Promise<ChatBoard | null> {
    return this.known(this.chatId(id));
  }

  private read(chat: string): Promise<ChatBoard | null> {
    let pending = this.reading.get(chat);
    if (!pending) {
      pending = this.fetchBoard(chat).finally(() => this.reading.delete(chat));
      this.reading.set(chat, pending);
    }
    return pending;
  }

  /** A failed read keeps the board kept before it and leaves the chat unread; a doc event or op that lands while the read runs wins over it. */
  private async fetchBoard(chat: string): Promise<ChatBoard | null> {
    const startedAt = Date.now();
    const result = await this.host.docGet(this.threadOf(chat), BOARD_DOC).then(value => ({ value }), () => null);
    const cached = this.cache.get(chat);
    if (cached && cached.at > startedAt) return cached.board;
    if (this.unput.has(chat)) return this.unput.get(chat)!;
    if (!result) return cached?.board ?? null;
    const board = result.value ? parseBoard(result.value) : null;
    const before = this.remember(chat, board);
    if (cached && JSON.stringify(cached.board) !== JSON.stringify(board)) {
      if (board) this.changed(chat, board, before);
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
   * A caller that names the board it holds (`base`, `boardKey`) gets only what changed when that was the board before the ops (`BoardWrite`).
   */
  apply(id: string, raw: unknown, actor?: "owner" | "agent"): Promise<BoardView & { summaries: string[] }>;
  apply(id: string, raw: unknown, actor: "owner" | "agent", base: unknown, split?: SearchSplit): Promise<BoardWrite & { summaries: string[] }>;
  async apply(id: string, raw: unknown, actor: "owner" | "agent" = "owner", base?: unknown, split?: SearchSplit): Promise<BoardWrite & { summaries: string[] }> {
    const chat = this.chatId(id);
    const thread = this.threadOf(chat);
    const ops: BoardOp[] = parseBoardOps(raw);
    const now = new Date().toISOString();
    let mark = performance.now();
    const read = await this.board(chat);
    if (split) split.read = performance.now() - mark;
    // Ops on a board this process never got from pi-host would replace it with the last run's copy or an empty one.
    if (!this.loaded.has(chat) && !this.unput.has(chat)) throw new Error(`pi-host did not answer the read of ${chat}'s board, so no op was applied; try again.`);
    // The board kept now, which a write that landed during the read already changed.
    const before = this.unput.get(chat) ?? (this.cache.has(chat) ? this.cache.get(chat)!.board : read);
    let board = before ?? emptyBoard(now);
    const summaries: string[] = [];
    for (const op of ops) {
      const result = applyBoardOp(board, op, actor, now, nextIds(board));
      board = result.board;
      summaries.push(result.summary);
    }
    // The write answers once it is stored on this server; pi-host gets it behind, in order (`putBoards`).
    const { put, kept } = this.keep(chat, board);
    this.changed(chat, board, this.remember(chat, board));
    this.sendForYou();
    // The chat's `[board]` line goes after the answer: no part of the answer waits on it, and a pi-host submit waits behind every command
    // queued there. On 11-20 to 11-23 the owner's board writes, which send it, ran p50 226 ms in the handler against 52 ms for the agents'
    // own writes, which do not (requests/*.jsonl, ~/work/p231-slow-calls).
    if (summaries.length && actor === "owner") {
      const images = ops.flatMap(op => op.op === "todo_update" && op.reply ? this.replyImages(op.reply) : []);
      // It follows the board into pi-host, so the turn it starts reads the board it names, and waits in the outbox while pi-host is away.
      void this.sends.submit(thread, {
        text: `${BOARD_PREFIX}${summaries.join("\n")}`, ...(images.length ? { images } : {}), whenBusy: "followUp", requestId: `board:${chat}:${board.rev}`,
        entry: { kind: "agent.message", data: { from: "owner", via: "board" } },
      }, put).catch(error => this.log(`board note to ${chat} failed: ${String(error)}`));
    }
    mark = performance.now();
    await kept;
    if (split) split.journal = performance.now() - mark;
    const step = before && typeof base === "string" && base === boardKey(before) ? boardStep(before, board) : null;
    return step ? { delta: boardDelta(base as string, board, [step]), awaitingGo: awaitingGo(board), summaries } : { board, awaitingGo: awaitingGo(board), summaries };
  }

  /**
   * Keeps a board in `db.writes` until pi-host has it, and starts its put: `kept` settles once the board is stored, and `put` once no board
   * of the chat waits for a put.
   */
  private keep(chat: string, board: ChatBoard): { kept: Promise<void>; put: Promise<void> } {
    this.unput.set(chat, board);
    const kept = this.db.writes.put(chat, board, this.unput);
    return { kept, put: this.putBoards(chat) };
  }

  /**
   * Puts a chat's newest unput board into pi-host until none is left, and settles then. Each put writes the whole board, so a board a later
   * write replaced before its put started is never sent. A failed put tries again (`retryWait`) and keeps the board in `db.writes`.
   */
  private putBoards(chat: string): Promise<void> {
    let running = this.putting.get(chat);
    if (!running) {
      running = this.putLoop(chat).finally(() => {
        this.putting.delete(chat);
        // A write that came between the loop's last look and here starts the loop again.
        if (this.unput.has(chat) && !this.putsStopped) void this.putBoards(chat);
      });
      this.putting.set(chat, running);
    }
    return running;
  }

  private async putLoop(chat: string): Promise<void> {
    for (let failures = 0; ;) {
      const board = this.unput.get(chat);
      if (!board || this.putsStopped) return;
      const began = performance.now();
      try {
        // newerOnly: a put of an older board that lands late, such as one still at work when this process stopped, never replaces a later one.
        await this.host.docPut(this.threadOf(chat), BOARD_DOC, board, { newerOnly: true });
      } catch (error) {
        if (this.putsStopped) return;
        failures += 1;
        const wait = retryWait(failures);
        this.log(`board put for ${chat} failed ${failures} times, retry in ${wait} ms: ${String(error)}`);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, wait);
          this.stopping.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        continue;
      }
      // After the stop, the kept boards are the next process's, which puts them again; this process writes no more to them.
      if (this.putsStopped) return;
      failures = 0;
      const ms = Math.round(performance.now() - began);
      // Over 1 s is 20 times the 48.5 ms p50 of 11-23's writes, which is worth a line in the log.
      if (ms > 1_000) this.log(`board put for ${chat} took ${ms} ms in pi-host`);
      if (this.unput.get(chat) === board) {
        this.unput.delete(chat);
        void this.db.writes.remove(chat, this.unput);
      }
    }
  }

  /** Sends the For you count after a write without holding its answer; a count read before a later write's is dropped. */
  private sendForYou(): void {
    const sent = ++this.forYouSent;
    void this.forYouCount().then(count => {
      if (sent === this.forYouSent) this.events.forYou(count);
    }, error => this.log(`For you count failed: ${String(error)}`));
  }

  /** The images the owner attached to an answer, as `![name](/api/uploads/<file>)` in its text, so the chat sees them with the `[board]` line. */
  private replyImages(reply: string): { data: string; mimeType: string }[] {
    const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    return [...reply.matchAll(/\(\/api\/uploads\/([\w.-]+)\)/g)].flatMap(([, name]) => {
      const mimeType = MIME[name!.split(".").at(-1)!.toLowerCase()];
      if (!mimeType) return [];
      try {
        return [{ data: readFileSync(this.store.imagePath(name!)).toString("base64"), mimeType }];
      } catch {
        return [];
      }
    });
  }

  /** A doc event from pi-host: the thread wrote its board. */
  docChanged(thread: string, value: unknown): void {
    const chat = this.chatId(thread);
    // A write not yet in pi-host is newer than any doc event before its put.
    if (this.unput.has(chat)) return;
    const board = value ? parseBoard(value) : null;
    const before = this.remember(chat, board);
    if (board) this.changed(chat, board, before);
  }

  /** The chats All boards and For you list; a walk's test agent has no place in either, nor in the For you badge. */
  private listed(): string[] {
    return this.chats().filter(chat => !this.agents.store.isTest(chat));
  }

  /**
   * Sends a board's change with its row and its asks, as GET /api/boards and GET /api/for-you would show them now, and the board kept before
   * it (`remember`), from which a page that holds that board gets only what changed.
   */
  private changed(chat: string, board: ChatBoard, before: ChatBoard | null): void {
    const row = this.listed().includes(chat) ? this.rowOf(chat, board) : null;
    if (row) this.sentRows.set(chat, JSON.stringify(row));
    this.events.board(chat, board, awaitingGo(board), row ? { row, forYou: this.asksOf(chat, board) } : { row: null, forYou: [] }, before);
  }

  private asksOf(chat: string, board: ChatBoard): ForYouItem[] {
    const steps = new Map<string, PlanItem>();
    walk(board.plan, item => steps.set(item.id, item));
    return board.todos.map(todo => {
      const step = todo.step ? steps.get(todo.step) : undefined;
      return { chatId: chat, chatName: this.nameOf(chat), todo, ...(step ? { step: { id: step.id, text: step.text, status: step.status } } : {}) };
    });
  }

  async forYou(): Promise<ForYouItem[]> {
    const chats = this.listed();
    const boards = await Promise.all(chats.map(chat => this.known(chat)));
    return chats.flatMap((chat, i) => (boards[i] ? this.asksOf(chat, boards[i]) : [])).sort(newestAskFirst);
  }

  /**
   * Open todos that no Remind me hides. The soonest reminder `snoozeDue` has not sent yet arms the timer, so a count read after its time but
   * before its timer ran still sends its notices and its row.
   */
  async forYouCount(now = Date.now()): Promise<number> {
    const items = await this.forYou();
    const due = items.filter(item => snoozed(item.todo, this.dueSentTo)).map(item => Date.parse(item.todo.remindAt!));
    clearTimeout(this.snoozeTimer);
    if (due.length) {
      // setTimeout takes at most 2^31-1 ms (about 24.8 days); a later reminder re-arms when this one fires.
      this.snoozeTimer = setTimeout(() => void this.snoozeDue().catch(() => undefined), Math.min(Math.max(Math.min(...due) - now + 50, 0), 2 ** 31 - 1));
      this.snoozeTimer.unref?.();
    }
    return waitingAsks(items.map(item => item.todo), now);
  }

  /** The soonest Remind me came due: the asks back on For you go out as notices, and the count again. */
  private async snoozeDue(now = Date.now()): Promise<void> {
    const since = this.dueSentTo;
    this.dueSentTo = now;
    const due = (await this.forYou()).filter(item => {
      const at = item.todo.remindAt ? Date.parse(item.todo.remindAt) : NaN;
      return !item.todo.done && at > since && at <= now;
    });
    if (due.length) this.events.asksDue?.(due, now);
    // Each board row counts the asks that came due again, as the badge does.
    for (const chat of new Set(due.map(item => item.chatId))) this.rowChanged(chat);
    this.events.forYou(await this.forYouCount(now));
  }

  async index(): Promise<BoardRow[]> {
    const chats = this.listed();
    const boards = await Promise.all(chats.map(chat => this.known(chat)));
    return chats.flatMap((chat, i) => (boards[i] ? [this.rowOf(chat, boards[i])] : []));
  }

  private rowOf(chat: string, board: ChatBoard): BoardRow {
    let done = 0;
    let total = 0;
    walk(board.plan, item => {
      if (item.status === "dropped") return;
      total += 1;
      if (item.status === "done") done += 1;
    });
    const checkIn = this.checkIn(chat);
    return {
      chatId: chat, chatName: this.nameOf(chat), rev: board.rev, progress: { done, total },
      openAsks: waitingAsks(board.todos, Date.now()), needsGo: awaitingGo(board).length,
      checkIn: { nextAt: checkIn.nextAt, paused: checkIn.paused },
      duties: this.duties(chat).map(d => ({ id: d.duty.id, name: d.duty.name, nextAt: d.nextAt, lastVerdict: d.last?.verdict ?? null })),
      ...(this.peek(chat)?.hidden ? { hidden: true } : {}),
    };
  }

  /** Hides a board from All boards and the Board sidebar, or shows it again; open boards read the change from the board event. */
  async setHidden(id: string, hidden: boolean): Promise<{ hidden: boolean }> {
    const chat = this.chatId(id);
    const file = this.file(chat);
    if (hidden) file.hidden = Date.now();
    else delete file.hidden;
    await this.save(chat, file);
    const board = await this.known(chat);
    if (board) this.changed(chat, board, board);
    return { hidden };
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
    const imported = existsSync(boardFile) ? parseBoard(JSON.parse(readFileSync(boardFile, "utf8"))) : null;
    const current = imported ? await this.board(chat) : null;
    if (imported && !this.loaded.has(chat) && !this.unput.has(chat)) throw new Error(`pi-host did not answer the read of ${chat}'s board, so nothing was imported; try again.`);
    // Its rev goes above the board it replaces, which the put's newerOnly would keep otherwise.
    const board = imported && { ...imported, rev: Math.max(imported.rev, (current?.rev ?? -1) + 1) };
    if (board) {
      // Through the same journal and put loop as a write, so a put of an older board still waiting never lands over it.
      await this.keep(chat, board).kept;
      this.changed(chat, board, this.remember(chat, board));
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

  /** The file of a board's duties, their runs and its check-in, or with the kind in chat.sqlite its export for the week after the move. */
  dutiesPath(id: string): string {
    return join(this.dir(this.chatId(id)), "duties.json");
  }
  /** The duties file's key in `db.duties`: its path in the data dir. */
  private dutiesKey(chat: string): string {
    return relative(this.store.dir, this.dutiesPath(chat));
  }
  /** A board's duties, their runs and its check-in, as a copy to change and save. */
  dutyFile(id: string): DutyFile {
    return this.file(this.chatId(id));
  }
  /** Stores a board's duties file; the promise settles once it is stored. */
  saveDuties(id: string, file: DutyFile): Promise<void> {
    return this.save(this.chatId(id), file);
  }
  private file(chat: string): DutyFile {
    return this.db.duties.get(this.dutiesKey(chat));
  }
  /** The duties file as kept, for a read that changes nothing. */
  private peek(chat: string): DutyFile | undefined {
    return this.db.duties.peek(this.dutiesKey(chat));
  }
  private save(chat: string, file: DutyFile): Promise<void> {
    const done = this.db.duties.save(this.dutiesKey(chat), file);
    this.rowChanged(chat);
    this.dutiesChanged(chat);
    return done;
  }

  /** Each chat's duty rows as the page last got them from an event, so a change that alters no row sends nothing. */
  private readonly sentDuties = new Map<string, string>();

  /**
   * Sends a chat's duty rows when they differ from the rows sent last. Every write of the duties file, each run's start and end, an account
   * wait and a job that starts or stops working come here, so the page's kept answer stays the server's. Before, a job's working state and a
   * run's report mark changed the rows with no event, so a kept card could differ from the server's and the next open's refresh changed it: in
   * the p155 sweep on 11-23 such a refresh of agent factory's duties counted as a 1,214 ms wait (~/work/p155-sweep/fix-duties/notes.md).
   */
  private dutiesChanged(chat: string): void {
    const duties = this.duties(chat);
    const text = JSON.stringify(duties);
    if ((this.sentDuties.get(chat) ?? "[]") === text) return;
    this.sentDuties.set(chat, text);
    this.events.duties(chat, duties);
  }

  /** Each job's name, working state and archive mark as its agent's duty rows last read it (`jobsChanged`). */
  private readonly jobStates = new Map<string, string>();

  /**
   * The thread list's changed and removed jobs: the agent of a job that started or stopped working, was renamed or was archived gets its duty
   * rows checked, since a card names its newest job and fix jobs as working or not (duty-card.ts `jobLive`). A job's other changes, such as
   * its preview line, check nothing.
   */
  jobsChanged(changed: readonly AgentSummary[], removed: readonly string[]): void {
    const chats = new Set<string>();
    for (const job of changed) {
      const state = JSON.stringify([job.name, job.status === "working", job.archived]);
      if (this.jobStates.get(job.id) === state) continue;
      this.jobStates.set(job.id, state);
      if (job.agent) chats.add(job.agent.id);
    }
    for (const id of removed) if (this.jobStates.delete(id)) for (const chat of this.sentDuties.keys()) chats.add(chat);
    for (const chat of chats) this.dutiesChanged(chat);
  }

  /** Each listed chat's row as the page last got it from an event, so a save that changes nothing it shows sends nothing. */
  private readonly sentRows = new Map<string, string>();

  private rowChanged(chat: string): void {
    const board = this.cache.get(chat)?.board;
    if (!board || !this.listed().includes(chat)) return;
    const row = this.rowOf(chat, board);
    const text = JSON.stringify(row);
    if (this.sentRows.get(chat) === text) return;
    this.sentRows.set(chat, text);
    this.events.row(chat, row);
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
    const file = this.peek(chat) ?? { duties: [], runs: {} };
    const agents = this.chatAgents(chat);
    return file.duties.map(duty => {
      const runs = [...(file.runs[duty.id] ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
      const view: DutyView = {
        duty: { id: duty.id, name: duty.name, ownerWords: duty.ownerWords, goal: duty.goal, metrics: duty.metrics, status: duty.status, ...(duty.boardGoal ? { boardGoal: duty.boardGoal } : {}) },
        schedule: duty.schedule, paused: duty.status === "paused", nextAt: duty.status === "paused" ? null : nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt),
        running: this.dutyRuns.has(`${chat}/${duty.id}`), runs, priority: "normal",
      };
      // A run skipped behind a job that still works measured nothing, so the card's last verdict is the newest run that did (`dutyState`).
      const newest = runs.find(run => run.verdict !== "skipped") ?? runs[0];
      const judged = newest ? judgedRun(newest, duty.metrics) : null;
      const waitingSince = this.accountWaits.get(`${chat}/${duty.id}`);
      return {
        ...view, card: dutyCard(view, agents),
        last: newest && judged ? { verdict: judged.verdict, at: newest.at, streak: missStreak(runs, duty.metrics), afterJob: newest.after !== undefined } : null,
        ...(waitingSince !== undefined ? { waitingForAccountSince: waitingSince } : {}),
      };
    });
  }

  /** Whether an id names an agent, a thread or a root chat this server knows, so a duty is never filed under a typo. */
  has(id: string): boolean {
    const chat = this.chatId(id);
    return this.agents.record(chat) !== undefined || this.threads.thread(chat) !== undefined;
  }

  async dutyAction(id: string, action: DutyAction): Promise<{ duties: DutyRow[]; result?: string }> {
    if (action.action === "set" || action.action === "remove") {
      const out = action.action === "set" ? this.setDuty(id, action.duty) : this.removeDuty(id, action.duty);
      await this.db.duties.written();
      return out;
    }
    const chat = this.chatId(id);
    const file = this.file(chat);
    const duty = file.duties.find(d => d.id === action.duty);
    if (!duty) throw new Error(`No duty ${action.duty} on this chat.`);
    if (action.action === "pause") duty.status = "paused";
    else if (action.action === "resume") duty.status = "active";
    else if (action.action === "schedule") duty.schedule = action.schedule;
    else if (action.action === "goal") duty.goal = action.goal;
    duty.updatedAt = Date.now();
    await this.save(chat, file);
    if (action.action === "run") void this.runDuty(chat, duty, "owner");
    return { duties: this.duties(chat) };
  }

  /**
   * Adds a duty, or updates the definition of the board's duty with the same name and keeps its id, runs, run state and schedule
   * (`upsertDuty`, as Prime's scripts/duties/add.ts does). With no `schedule`, a new duty runs daily at a free minute of the high morning band
   * (`morningTime`), the band of a chat, among the daily times of every board here. `result` is "added d3", "updated d1" or "unchanged d1".
   */
  private setDuty(id: string, definition: unknown, now = Date.now()): { duties: DutyRow[]; result: string } {
    const cwd = (definition as { precheck?: { cwd?: unknown } } | null)?.precheck?.cwd;
    if (typeof cwd === "string" && !isAbsolute(cwd)) throw new Error(`precheck.cwd ${cwd} is relative; add.ts resolves it against the duty file's folder.`);
    const chat = this.chatId(id);
    const taken = new Set(this.chats().flatMap(other => (this.peek(other)?.duties ?? []).flatMap(duty => duty.schedule.kind === "daily" ? [duty.schedule.at] : [])));
    const file = this.file(chat);
    const result = upsertDuty(file.duties, definition, now, morningTime(taken, "high", Math.random), dutyIdFloor(file));
    if (!result.startsWith("unchanged")) this.save(chat, file);
    return { duties: this.duties(chat), result };
  }

  /** Deletes a duty for good, as Prime's scripts/duties/remove.ts does: its definition, its runs and its precheck state and outputs. */
  private removeDuty(id: string, dutyId: string): { duties: DutyRow[]; result: string } {
    const chat = this.chatId(id);
    const file = this.file(chat);
    const at = file.duties.findIndex(duty => duty.id === dutyId);
    if (at < 0) return { duties: this.duties(chat), result: `no duty ${dutyId}` };
    file.lastId = dutyIdFloor(file);
    file.duties.splice(at, 1);
    delete file.runs[dutyId];
    delete file.pending?.[dutyId];
    delete file.starts?.[dutyId];
    this.save(chat, file);
    const stateDir = join(this.dir(chat), "duties");
    let names: string[] = [];
    try { names = readdirSync(stateDir); } catch { names = []; }
    for (const name of names) if (name.startsWith(`${dutyId}.`) || name.startsWith(`${dutyId}-`)) rmSync(join(stateDir, name), { force: true });
    return { duties: this.duties(chat), result: `removed ${dutyId}` };
  }

  private readonly dutyRuns = new Map<string, Promise<void>>();
  /** Aborted when this server stops, which ends each precheck wait without a record (`resumePrechecks`). */
  private stopping = new AbortController();
  /** The after-job measure going per `<chat>/<duty>` (`afterJob`); a due run of the duty waits for it, as in Prime's `Duties.afters`. */
  private readonly afters = new Map<string, Promise<void>>();
  /** Duty jobs whose first turn this process still waits on (`reportDutyJob`), so a thread list read before their submit cannot read them as ended. */
  private readonly waiting = new Set<string>();
  /** The duties whose last job's end is being read now (`jobEnded`), so a tick reads each once. */
  private readonly endChecks = new Set<string>();
  /** Per `<chat>/<duty>`, since when its newest job waits for a model account (`readAccountWait`), which `duties()` puts on the card. */
  private readonly accountWaits = new Map<string, number>();
  /** The duties whose account wait is being read now, so a tick reads each once. */
  private readonly waitReads = new Set<string>();
  /** Duty jobs that got a model answer, whose entries `readAccountWait` reads no more. */
  private readonly answered = new Set<string>();

  /**
   * Whether a duty's or check-in's job still works: it or a subagent under it works or waits on a wake (`workingJobs`), this server still waits
   * on its first turn, or pi-host reads it running or sleeping. A job pi-pool holds for an account slot sleeps and is missing from `working`,
   * and after a restart `waiting` no longer holds it.
   */
  private jobBusy(job: { id: string; name: string }, working: ReadonlySet<string>): boolean {
    const status = this.threads.thread(job.id)?.status;
    return working.has(job.name) || this.waiting.has(job.id) || status === "running" || status === "sleeping";
  }

  /**
   * One duty run: the precheck, the judged record, and a duty job when something is due (`measure` in duty-run.ts). The job is a durable
   * thread filed under the chat; what it sends reaches the chat as an input from that job (`reportDutyJob`). A second start while one runs shares it.
   */
  private runDuty(chat: string, duty: Pick<Duty, "id">, trigger: DutyTrigger, resume?: Extract<PendingPrecheck, { mode: "run" }>): Promise<void> {
    const key = `${chat}/${duty.id}`;
    const going = this.dutyRuns.get(key);
    if (going) return going;
    // A run waits for the after-job measure going on the duty, so the two never run its precheck side by side (Prime's push waits the same way).
    const run = (this.afters.get(key) ?? Promise.resolve()).then(() => this.runDutyOnce(chat, duty.id, trigger, resume))
      .catch(error => this.log(this.stopping.signal.aborted ? `duty ${key}: the next server process records its run` : `duty ${key} failed: ${String(error)}`)).finally(() => {
      this.dutyRuns.delete(key);
      this.dutiesChanged(chat);
    });
    this.dutyRuns.set(key, run);
    this.dutiesChanged(chat);
    return run;
  }

  /** Writes a duty's precheck at work, or with null clears it, into `file`, which the caller saves. */
  private static pend(file: DutyFile, dutyId: string, entry: PendingPrecheck | null): DutyFile {
    const pending = { ...file.pending };
    if (entry) pending[dutyId] = entry;
    else delete pending[dutyId];
    if (Object.keys(pending).length) file.pending = pending;
    else delete file.pending;
    return file;
  }

  /** A run, or with `resume` the rest of a run whose precheck a stopped server process launched: no new precheck, the same time and trigger. */
  private async runDutyOnce(chat: string, dutyId: string, trigger: DutyTrigger, resume?: Extract<PendingPrecheck, { mode: "run" }>): Promise<void> {
    const before = this.file(chat);
    const duty = before.duties.find(d => d.id === dutyId);
    if (!duty) {
      if (resume) this.save(chat, Boards.pend(before, dutyId, null));
      return;
    }
    const at = resume?.at ?? Date.now();
    const working = workingJobs(this.threads.allSummaries(), new Set(this.pendingWakes().map(wake => wake.session)));
    if (!resume) {
      duty.lastRunAt = at;
      duty.runCount += 1;
      this.save(chat, before);
    }
    // A run behind the duty's last job that still works measures and records its run but starts no job, as Prime's `Duties.launch` does. Until
    // 11-23 such a run skipped its precheck too: the fable auditor's 16:06Z sweep job of 11-22 waited 3 h 44 min for a Fable account, and every
    // due sweep behind it recorded "skipped" and measured nothing.
    const lastJob = [...(before.runs[dutyId] ?? [])].sort((a, b) => b.at - a.at).find(run => run.job)?.job;
    const busy = lastJob && !resume?.job && this.jobBusy(lastJob, working) ? lastJob : undefined;
    const dir = join(this.dir(chat), "duties");
    const thread = this.threadOf(chat);
    const { record, brief } = await measure({
      duty, chat: { id: chat, name: this.nameOf(chat) }, dir, trigger, previous: before.runs[dutyId] ?? [], board: await this.board(chat),
      liveJob: job => working.has(job), boardApi: `${this.selfUrl}/api/threads/${thread}/board`, now: at, log: this.log, signal: this.stopping.signal,
      ...(resume ? { resume: resume.launch } : {}),
      launched: launch => this.save(chat, Boards.pend(this.file(chat), dutyId, { mode: "run", at, trigger, launch })),
    });
    if (busy) {
      record.summary += await this.besideBusyJob(chat, duty, busy, record, brief);
      // The run names the job it measured beside, so the job's after-job measure lands on it too (`afterJob`) and the card reads the state
      // after the job's work. On 11-23 the fable auditor's 10:06 and 13:06 KST sweeps handed their briefs to the 07:06 job, which ended at
      // 15:07 with findings_unposted 0, and d1 still read missed 10, 2 runs in a row, until the next sweep.
      record.job = { id: busy.id, name: busy.name };
    } else if (brief) {
      // The duty job works where its precheck runs, else in its chat's project folder, so it reads that folder's AGENTS.md chain.
      const cwd = duty.precheck.cwd || this.threads.thread(thread)?.cwd;
      // A run resumed after a stop that came after its job was made submits to that job, and the request id lands the brief once.
      const kept = this.file(chat).starts?.[dutyId];
      const made = resume?.job ?? (kept?.run === record.at ? kept.job : undefined);
      const job = await this.startDutyJob(chat, duty, {
        run: record.at, name: `${duty.name} duty ${runStamp(record.at)}`, brief, ...(cwd ? { cwd } : {}), ...(made ? { job: made } : {}), failures: 0, retryAt: 0,
      });
      if (job) {
        record.job = job;
        void this.reportDutyJob(chat, duty, job.id, job.submission);
      }
    }
    const after = this.file(chat);
    // A newer run replaces an older run's job that never started: its brief reads the newer measure.
    if (after.starts?.[dutyId] && after.starts[dutyId].run !== record.at) Boards.keepStart(after, dutyId, null);
    // The last job's runs with no after-job measure yet take this run's measure, as Prime's `launch` writes it, unless that job still works
    // and this run started none, since then the job's own end measures them (`afterJob`).
    const newestJob = (after.runs[dutyId] ?? []).filter(run => run.job).sort((a, b) => b.at - a.at)[0]?.job;
    const measured = asAfter(record);
    if (newestJob && measured && !busy && (record.job || !working.has(newestJob.name))) {
      landAfter(after.runs[dutyId] ?? [], newestJob.id, measured);
    }
    after.runs[dutyId] = [record, ...(after.runs[dutyId] ?? [])].sort((a, b) => b.at - a.at).slice(0, 20);
    // Only this run's own precheck entry is cleared, with its files, so an entry another measure wrote keeps its files.
    const pending = after.pending?.[dutyId];
    const launch = pending?.mode === "run" && pending.at === at ? pending.launch : undefined;
    this.save(chat, launch ? Boards.pend(after, dutyId, null) : after);
    if (launch) void clearPrecheck(launch).catch(error => this.log(`duty ${chat.slice(0, 8)}: clearing its precheck files failed: ${String(error)}`));
    this.log(`duty ${chat.slice(0, 8)}/${duty.id}: ${record.verdict}, ${record.summary}${record.job ? `, job ${record.job.name}` : ""}`);
  }

  /** Writes a duty job that did not start, or with null clears it, into `file`, which the caller saves. */
  private static keepStart(file: DutyFile, dutyId: string, entry: DutyStart | null): DutyFile {
    const starts = { ...file.starts };
    if (entry) starts[dutyId] = entry;
    else delete starts[dutyId];
    if (Object.keys(starts).length) file.starts = starts;
    else delete file.starts;
    return file;
  }

  /**
   * Makes a duty run's job and submits its brief, or submits to `start.job`, the job an earlier try made. A try that fails keeps the start in
   * `starts`, and the tick tries again after `retryWait` (`retryDutyStart`) with the same request id, so a submit that did land lands once.
   * Until 11-23 a failed start was only logged: at 19:07:55Z the fable auditor's sweep job got "pi-host is shutting down" during a pi-host
   * install, its job thread kept 0 inputs, and d1 read findings_unposted 1 until the next sweep 3 h later.
   */
  private async startDutyJob(chat: string, duty: Pick<Duty, "id">, start: DutyStart): Promise<{ id: string; name: string; submission: number } | undefined> {
    let job = start.job;
    try {
      if (!job) {
        // The job runs on its chat's model, so a Fable advisor's sweep judges on Fable and every Opus agent's duty stays on Opus.
        const made = await this.threads.create({ name: start.name, ...threadModel(this.threads.thread(this.threadOf(chat))), ...(start.cwd ? { cwd: start.cwd } : {}) }, made => {
          this.store.state.threads[made.id] = { kind: "job", parent: chat };
          this.store.saveState();
          this.agents.alias(made.id, chat);
          const file = this.file(chat);
          const pending = file.pending?.[duty.id];
          if (pending?.mode === "run" && pending.at === start.run) this.save(chat, Boards.pend(file, duty.id, { ...pending, job: { id: made.id, name: start.name } }));
        });
        job = { id: made.id, name: start.name };
        await this.threads.refresh().catch(() => undefined);
      }
      const submitted = await this.host.submit(job.id, { text: start.brief, requestId: `duty:${chat}:${duty.id}:${start.run}`, entry: { kind: "agent.message", data: { from: chat, via: `duty ${duty.id}` } } });
      const file = this.file(chat);
      if (file.starts?.[duty.id]?.run === start.run) this.save(chat, Boards.keepStart(file, duty.id, null));
      return { id: job.id, name: start.name, submission: submitted.submission };
    } catch (error) {
      const failures = start.failures + 1;
      const wait = retryWait(failures);
      this.save(chat, Boards.keepStart(this.file(chat), duty.id, { ...start, ...(job ? { job } : {}), failures, retryAt: Date.now() + wait }));
      this.log(`duty ${chat}/${duty.id}: the duty job did not start (try ${failures}), it tries again in ${wait} ms: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Tries again to start a duty job that did not start (`startDutyJob`) and names it on its run, which then reports and gets its after-job
   * measure as a run whose job started at once. It goes as the duty's run (`dutyRuns`), so no run of the duty starts beside it.
   */
  private retryDutyStart(chat: string, dutyId: string): Promise<void> {
    const key = `${chat}/${dutyId}`;
    const going = this.dutyRuns.get(key);
    if (going) return going;
    const run = (async () => {
      const file = this.file(chat);
      const duty = file.duties.find(d => d.id === dutyId);
      const start = file.starts?.[dutyId];
      if (!start) return;
      if (!duty) {
        this.save(chat, Boards.keepStart(file, dutyId, null));
        return;
      }
      const job = await this.startDutyJob(chat, duty, start);
      if (!job) return;
      const after = this.file(chat);
      const record = after.runs[dutyId]?.find(entry => entry.at === start.run);
      if (record) {
        record.job = job;
        this.save(chat, after);
      }
      this.log(`duty ${chat.slice(0, 8)}/${dutyId}: started its job ${job.name} on try ${start.failures + 1}`);
      void this.reportDutyJob(chat, duty, job.id, job.submission);
    })().catch(error => this.log(`duty ${key}: starting its job again failed: ${String(error)}`)).finally(() => {
      this.dutyRuns.delete(key);
      this.dutiesChanged(chat);
    });
    this.dutyRuns.set(key, run);
    this.dutiesChanged(chat);
    return run;
  }

  /**
   * What a run does beside the duty's last job that still works, and the words it adds to the run's summary. A job with no model answer yet
   * waits for an account and has read nothing, so it keeps its place in pi-pool's line: a due run steers this run's brief into it, which it
   * reads after its first answer, and a run with nothing due stops it. A job that answered works its brief, and the run leaves it alone.
   */
  private async besideBusyJob(chat: string, duty: Duty, job: { id: string; name: string }, record: DutyRunRecord, brief: string | null): Promise<string> {
    const waits = !(await this.answeredOnce(job.id).catch(() => true));
    if (!waits) return `; its job ${job.name} still works, so this run started none`;
    try {
      if (!brief) {
        await this.host.abort(job.id);
        return `; stopped its job ${job.name}, which still waited for a model account, since nothing is due`;
      }
      const text = `A newer ${duty.name} run measured while you waited for a model account: ${record.summary}. Work from the brief below instead of your first brief, since its precheck is newer.\n\n${brief}`;
      await this.host.submit(job.id, { text, whenBusy: "steer", requestId: `duty-handoff:${job.id}:${record.at}`, entry: { kind: "agent.message", data: { from: chat, via: `duty ${duty.id}` } } });
      return `; its job ${job.name} still waits for a model account and got this run's brief`;
    } catch (error) {
      this.log(`duty ${chat.slice(0, 8)}/${duty.id}: reaching its waiting job ${job.name} failed: ${String(error)}`);
      return `; its job ${job.name} still waits for a model account, and reaching it failed`;
    }
  }

  /** Whether a duty job got a model answer that is no error; pi-pool's "the token hook gave no token" errors are no answer (`readAccountWait`). */
  private async answeredOnce(job: string): Promise<boolean> {
    if (this.answered.has(job)) return true;
    const { entries } = await this.host.entries(job, { after: 0, limit: 50, lean: true });
    const answer = entries.some(entry => entry.model?.some(message => message.role === "assistant" && message.stopReason !== "error"));
    if (answer) this.answered.add(job);
    return answer;
  }

  /**
   * Posts what the duty job sent with send_message to the chat, as one input; a job that never called it posts its final answer. Nothing
   * sent, or "nothing to report", posts nothing.
   */
  private async reportDutyJob(chat: string, duty: Duty, job: string, submission: number): Promise<void> {
    this.waiting.add(job);
    try {
      await this.deliverReport(chat, duty.id, job, submission);
    } catch (error) {
      this.log(`duty ${chat}/${duty.id}: its job's report did not reach the chat: ${String(error)}`);
    } finally {
      this.waiting.delete(job);
      await this.threads.refresh().catch(() => undefined);
      void this.afterJob(chat, duty.id);
    }
  }

  /**
   * Sends the job's report to the chat once its first turn settled and marks the run's job `reported`. The request id makes a second send land
   * once, so the after-job measure sends it again when a restart of this server cut `reportDutyJob` off: on 11-22 the fable auditor's first sweep
   * report was lost that way while its job waited for a Fable slot across two apps/chat releases.
   */
  private async deliverReport(chat: string, dutyId: string, job: string, submission: number): Promise<void> {
    const settled = await this.host.wait(job, submission);
    const text = (await this.threads.said(job, 1, settled)).map(m => m.text).join("\n\n");
    if (text.trim() && !/^nothing to report\.?$/i.test(text.trim())) {
      await this.host.submit(this.threadOf(chat), { text: `[duty ${dutyId}] ${text}`, whenBusy: "followUp", requestId: `duty-report:${job}`, entry: { kind: "agent.message", data: { from: job, via: `duty ${dutyId}` } } });
    }
    const file = this.file(chat);
    const run = file.runs[dutyId]?.find(entry => entry.job?.id === job && entry.job.submission === submission);
    if (run?.job && !run.job.reported) {
      run.job.reported = true;
      this.save(chat, file);
    }
  }

  /**
   * Whether a duty job has ended, as Prime's `jobs.ended` reads it: its thread is listed and idle with no wake set on it, in pi-host or in this
   * server's wakes, and every conversation of its tree is idle, read from pi-host now. A failed job is not ended: its run keeps its own verdict.
   */
  private async jobEnded(job: string): Promise<boolean> {
    const row = this.threads.thread(job);
    if (!row || row.status !== "idle" || row.wakeAt !== undefined || this.waiting.has(job)) return false;
    if (this.pendingWakes().some(wake => wakeTarget(wake.session).thread === job)) return false;
    const nodes = await this.host.tree(job).catch(() => null);
    return nodes !== null && nodes.every(node => node.status === "idle");
  }

  /**
   * Measures a duty's last job's runs again once that job has ended (Prime's `Duties.endJob` and `measureAfter`), and writes the measure into
   * each run that names the job as `after`, which the card reads as the run's verdict and streak once its job's fixes are in (`effectiveRun`).
   * Only the duty's newest job is looked at; an older one's runs get the next run's measure (`runDutyOnce`). One measure goes per duty, and none
   * beside a run of it.
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
    // The run that started the job holds its first input; a later run measured beside the job names it with none (`runDutyOnce`).
    const started = runsOfJob(runs, job.id).at(-1)?.job ?? job;
    this.endChecks.add(key);
    return this.jobEnded(job.id).catch(() => false).then(ended => {
      this.endChecks.delete(key);
      if (!ended || this.dutyRuns.has(key) || this.afters.has(key)) return;
      const task = (async () => {
        if (started.submission !== undefined && !started.reported) await this.deliverReport(chat, dutyId, job.id, started.submission);
        await this.measureAfterJob(chat, duty, runs, run.at, job.name);
      })().catch(error => this.log(`duty ${key}: the after-job measure of ${job.name} failed: ${String(error)}`)).finally(() => this.afters.delete(key));
      this.afters.set(key, task);
      return task;
    });
  }

  /** The after-job measure of the run at `runAt`, or with `resume` the rest of one whose precheck a stopped server process launched. */
  private async measureAfterJob(chat: string, duty: Duty, runs: readonly DutyRunRecord[], runAt: number, jobName: string, resume?: Extract<PendingPrecheck, { mode: "after" }>): Promise<void> {
    const at = resume?.at ?? Date.now();
    const after = await measureAfter({
      duty, chat, dir: join(this.dir(chat), "duties"), runs, now: at, log: this.log, signal: this.stopping.signal, ...(resume ? { resume: resume.launch } : {}),
      launched: launch => this.save(chat, Boards.pend(this.file(chat), duty.id, { mode: "after", at, run: runAt, job: jobName, launch })),
    });
    const latest = this.file(chat);
    const pending = latest.pending?.[duty.id];
    const launch = pending?.mode === "after" && pending.at === at ? pending.launch : undefined;
    // The measure goes onto every run that names the job: the run that started it and each later run measured beside it.
    const job = latest.runs[duty.id]?.find(entry => entry.at === runAt)?.job;
    const targets = job ? landAfter(latest.runs[duty.id] ?? [], job.id, after) : [];
    this.save(chat, launch ? Boards.pend(latest, duty.id, null) : latest);
    if (launch) void clearPrecheck(launch).catch(error => this.log(`duty ${chat.slice(0, 8)}: clearing its precheck files failed: ${String(error)}`));
    if (targets.length) this.log(`duty ${chat.slice(0, 8)}/${duty.id}: after its job ${jobName}, ${after.verdict}, ${after.summary}`);
  }

  /**
   * Waits again for each precheck a stopped server process launched and records it as that process would have, before the first tick, so a
   * tick, an owner's run or a job's end shares the wait instead of starting a second precheck of the duty.
   */
  private resumePrechecks(): void {
    for (const chat of this.chats()) {
      const file = this.file(chat);
      for (const [dutyId, entry] of Object.entries(file.pending ?? {})) {
        const key = `${chat}/${dutyId}`;
        this.log(`duty ${chat.slice(0, 8)}/${dutyId}: waiting again for its ${entry.mode} precheck from ${new Date(entry.at).toISOString()}`);
        if (entry.mode === "run") {
          void this.runDuty(chat, { id: dutyId }, entry.trigger, entry);
          continue;
        }
        const duty = file.duties.find(d => d.id === dutyId);
        const runs = [...(file.runs[dutyId] ?? [])].sort((a, b) => b.at - a.at);
        const task = (duty ? this.measureAfterJob(chat, duty, runs, entry.run, entry.job, entry) : Promise.resolve(this.save(chat, Boards.pend(this.file(chat), dutyId, null))))
          .catch(error => this.log(`duty ${key}: the after-job measure of ${entry.job} failed: ${String(error)}`)).finally(() => this.afters.delete(key));
        this.afters.set(key, task);
      }
    }
  }

  /**
   * A board's check-in setting: the one its file holds, else every 2 hours from the agent's or root chat's start (Prime's CHECK_IN_MS). A
   * walk's test agent gets no check-in until one is set for it.
   */
  private checkInState(chat: string, file = this.file(chat)): CheckInState | null {
    if (file.checkIn) return file.checkIn;
    return this.agents.store.isTest(chat) ? null : { everyMs: DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: null };
  }

  /**
   * The check-in as it runs, in Prime's shape (shared/types.ts `CheckInState`): while the board has no open step it runs daily (Prime's
   * `planCheckIn`), `everyMs` reads that daily interval and `planEveryMs` the setting. The board is the last one read, and a board never read
   * counts as open, as Prime counts a chat it has no plan for.
   */
  checkIn(id: string): CheckInView {
    const chat = this.chatId(id);
    const state = this.checkInState(chat);
    if (!state) return { everyMs: DEFAULT_CHECK_IN_MS, paused: false, pausedUntil: null, nextAt: null, lastAt: null };
    const now = Date.now();
    const paused = state.pausedUntil === "forever" || (typeof state.pausedUntil === "number" && state.pausedUntil > now);
    const cached = this.cache.get(chat);
    const everyMs = planEveryMs(state.everyMs, cached ? planHasOpenStep(cached.board) : true);
    const base = state.lastAt ?? this.agents.record(chat)?.createdAt ?? this.threads.thread(this.threadOf(chat))?.createdAt ?? now;
    return {
      everyMs, ...(everyMs !== state.everyMs ? { planEveryMs: state.everyMs } : {}), paused, pausedUntil: paused ? state.pausedUntil : null,
      nextAt: paused ? (state.pausedUntil === "forever" ? null : Math.max(state.pausedUntil as number, base + everyMs)) : base + everyMs, lastAt: state.lastAt,
      ...(state.job ? { job: { id: state.job.id, name: state.job.name } } : {}),
    };
  }

  setCheckIn(id: string, patch: CheckInPatch): CheckInView {
    const chat = this.chatId(id);
    const file = this.file(chat);
    const state: CheckInState = file.checkIn ?? { everyMs: DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: null };
    if (patch.everyMs !== undefined) {
      if (!Number.isFinite(patch.everyMs) || patch.everyMs < 60_000) throw new Error("A check-in runs at most once a minute.");
      state.everyMs = Math.round(patch.everyMs);
    }
    if (patch.pause !== undefined) {
      const now = Date.now();
      if (patch.pause === null) state.pausedUntil = null;
      else if (patch.pause === "forever") state.pausedUntil = "forever";
      else if (patch.pause === "1h") state.pausedUntil = now + 3600_000;
      else if (patch.pause === "tomorrow") state.pausedUntil = nextRun({ kind: "daily", at: "09:00" }, now);
      else if (typeof patch.pause === "object" && Number.isFinite(patch.pause.until) && patch.pause.until > now) state.pausedUntil = Math.round(patch.pause.until);
      else throw new Error('pause is "1h", "tomorrow", "forever", { until: <ms ahead of now> } or null.');
    }
    file.checkIn = state;
    this.save(chat, file);
    return this.checkIn(chat);
  }

  /** The check-in run going per board (`runCheckIn`), so a tick while one starts its job starts no second. */
  private readonly checkIns = new Map<string, Promise<void>>();

  /**
   * One check-in, as Prime's chat runs it (chat-duty-run.ts `Duties.checkIn`): no job while the last check-in job still works, none when
   * nothing is due (`checkInIdle`), else one check-in job filed under the agent as `runDutyOnce` files a duty job, with Prime's brief
   * (server/check-in-job.ts) and the run's detail file beside the duties. A job that did not start is kept in `start` and tried again under
   * its first run's name and request id, on the thread a failed try made: until 11-23 each try made a new thread and left the last one empty.
   */
  private async runCheckIn(chat: string, at: number): Promise<void> {
    const { job: last, start: kept } = this.file(chat).checkIn ?? {};
    const working = workingJobs(this.threads.allSummaries(), new Set(this.pendingWakes().map(wake => wake.session)));
    if (last && this.jobBusy(last, working)) {
      this.log(`check-in ${chat.slice(0, 8)}: skipped, the last check-in job ${last.name} still works`);
      return;
    }
    const board = await this.board(chat);
    const record = this.agents.record(chat);
    const briefFile = record ? join(agentFolderDir(this.agents.agentsDirOf(record), record), "brief.md") : undefined;
    // An agent on another box keeps its brief there, where its job reads it; one here counts only when the file holds text.
    const brief = briefFile && (record?.agentsDir !== undefined || readFileSafe(briefFile).trim()) ? briefFile : undefined;
    const precheck = checkInPrecheck(board, this.chatAgents(chat), working);
    if (checkInIdle(precheck, { brief })) {
      this.log(`check-in ${chat.slice(0, 8)}: nothing due, no job`);
      return;
    }
    const taken = new Set(this.threads.threadsList().map(thread => thread.name));
    const first = checkInJobName(this.nameOf(chat), at);
    const name = kept?.name ?? (taken.has(first) ? datedName(first, at) : first);
    const run = kept?.at ?? at;
    const dir = join(this.dir(chat), "check-ins");
    mkdirSync(dir, { recursive: true });
    const detail = join(dir, `checkin-${runStamp(at)}.md`);
    writeFileSync(detail, checkInDetail(precheck, at), { mode: 0o600 });
    const thread = this.threadOf(chat);
    const text = checkInJobBrief({
      agent: this.nameOf(chat), workThread: thread, job: name, at, prompt: checkInPrompt(precheck, { brief }), detail,
      boardApi: `${this.selfUrl}/api/threads/${thread}/board`, steerApi: `${this.selfUrl}/api/threads/${thread}/job-steer`, itemsApi: `${this.selfUrl}/api/c/${thread}/items`,
    });
    const work = this.threads.thread(thread);
    let job = kept?.job;
    let submitted: { submission: number };
    try {
      if (!job) {
        job = await this.threads.create({ name, ...threadModel(work), ...(work?.cwd ? { cwd: work.cwd } : {}) }, made => {
          this.store.state.threads[made.id] = { kind: "job", parent: chat };
          this.store.saveState();
          this.agents.alias(made.id, chat);
        });
        await this.threads.refresh().catch(() => undefined);
      }
      submitted = await this.host.submit(job.id, { text, requestId: `checkin:${chat}:${run}`, entry: { kind: "agent.message", data: { from: chat, via: "check-in" } } });
    } catch (error) {
      // As Prime's chat does, a job that did not start is tried again in CHECK_IN_RETRY_MS (slack green guy 10-12: "daemon client closed").
      const failed = this.file(chat);
      if (failed.checkIn) {
        failed.checkIn.start = { at: run, name, ...(job ? { job: { id: job.id } } : {}) };
        failed.checkIn.lastAt = at - this.checkIn(chat).everyMs + CHECK_IN_RETRY_MS;
        this.save(chat, failed);
      }
      throw new Error(`the check-in job did not start, so it tries again in 5 min: ${String(error)}`);
    }
    const file = this.file(chat);
    delete file.checkIn?.start;
    if (file.checkIn) file.checkIn.job = { id: job.id, name, submission: submitted.submission };
    else file.checkIn = { everyMs: DEFAULT_CHECK_IN_MS, pausedUntil: null, lastAt: at, job: { id: job.id, name, submission: submitted.submission } };
    this.save(chat, file);
    this.log(`check-in ${chat.slice(0, 8)}: started ${name}`);
    void this.reportCheckIn(chat, { id: job.id, submission: submitted.submission });
  }

  /**
   * Posts what the check-in job sent with send_message to the work thread as one `[check-in]` input; nothing sent, or "nothing to report",
   * posts nothing. Its final answer stays in the job, as a Prime check-in job reports only through agent_message: on 11-22 the fable
   * auditor's job ended on "Nothing changed", and posting that answer cost the work thread a turn that said "Nothing to change on the board".
   * The request id lets a second send after a restart land once (`tick`).
   */
  private async reportCheckIn(chat: string, job: { id: string; submission: number }): Promise<void> {
    this.waiting.add(job.id);
    try {
      const settled = await this.host.wait(job.id, job.submission);
      const text = (await this.threads.sent(job.id, 1, settled)).map(m => m.text).join("\n\n");
      if (text.trim() && !/^nothing to report\.?$/i.test(text.trim())) {
        await this.host.submit(this.threadOf(chat), { text: `[check-in] ${text}`, whenBusy: "followUp", requestId: `checkin-report:${job.id}`, entry: { kind: "agent.message", data: { from: job.id, via: "check-in" } } });
      }
      const file = this.file(chat);
      if (file.checkIn?.job?.id === job.id) {
        file.checkIn.job.reported = true;
        this.save(chat, file);
      }
    } catch (error) {
      this.log(`check-in ${chat.slice(0, 8)}: its job's report did not reach the work thread: ${String(error)}`);
    } finally {
      this.waiting.delete(job.id);
      await this.threads.refresh().catch(() => undefined);
    }
  }

  /** The check-in jobs whose archive is being checked now (`archiveCheckIn`), so a tick checks each once. */
  private readonly archiving = new Set<string>();

  /**
   * Archives a check-in job that reported and has ended (`jobEnded`), as Prime's chat archives a duty job at its end ("duty_job_end"), so the
   * agent's Jobs list keeps only the check-in at work. Its own `rlm.create_session` jobs are threads of their own and stay.
   */
  private async archiveCheckIn(chat: string, job: string): Promise<void> {
    if (this.archiving.has(job)) return;
    this.archiving.add(job);
    try {
      if (!(await this.jobEnded(job).catch(() => false))) return;
      this.threads.put(await this.host.set(job, { archived: true }));
      const file = this.file(chat);
      if (file.checkIn?.job?.id === job) {
        file.checkIn.job.archived = true;
        this.save(chat, file);
      }
    } catch (error) {
      this.log(`check-in ${chat.slice(0, 8)}: archiving ${job} failed: ${String(error)}`);
    } finally {
      this.archiving.delete(job);
    }
  }

  /**
   * Delivers a message to a job of the agent, by its name or session id, as an input from `from` (Prime's `Chats.steerJob`, which a check-in job
   * calls through scripts/job-steer.ts). A job inside the work thread is out of reach of another thread's `agent_message`, so the check-in job
   * steers through this. A job that is working takes it as a steer, and an idle one as a new turn.
   */
  async steerJob(id: string, input: { job?: unknown; text?: unknown; from?: unknown }): Promise<{ job: string; submission: number }> {
    if (typeof input.job !== "string" || !input.job.trim() || typeof input.text !== "string" || !input.text.trim()) throw new Error("A job steer is { job: <name or session id>, text }.");
    const chat = this.chatId(id);
    const thread = this.threadOf(chat);
    const wanted = input.job.trim();
    const all = this.threads.allSummaries({ archived: false });
    // The agent's root jobs, such as its duty and check-in jobs, and every conversation inside one or inside the work thread: on 11-22 the
    // agent factory check-in could not chase the subagents of a duty job, which this list missed.
    const roots = new Set(all.filter(a => a.kind === "job" && a.conversation === 1 && a.parent?.id === chat).map(a => a.thread));
    const jobs = all.filter(a => a.kind === "job" && (a.parent?.id === chat || (a.conversation !== 1 && (a.thread === thread || roots.has(a.thread)))));
    const target = jobs.find(a => a.name === wanted) ?? jobs.find(a => a.id === wanted || (a.conversation === 1 && a.thread === wanted));
    if (!target) throw new Error(`No job ${wanted} of ${this.nameOf(chat)}; its jobs are ${jobs.map(a => a.name).join(", ") || "none"}.`);
    const from = typeof input.from === "string" && input.from.trim() ? input.from.trim() : chat;
    const submitted = await this.host.submit(target.thread, {
      ...(target.conversation !== 1 ? { conversation: target.conversation } : {}), text: input.text, whenBusy: "steer",
      requestId: `steer:${target.id}:${Date.now()}`, entry: { kind: "agent.message", data: { from, via: "job-steer" } },
    });
    return { job: target.name, submission: submitted.submission };
  }

  // The clock: due check-ins, duties and wakes

  start(everyMs = 30_000): void {
    if (this.stopping.signal.aborted) this.stopping = new AbortController();
    this.putsStopped = false;
    for (const chat of this.unput.keys()) void this.putBoards(chat);
    this.resumePrechecks();
    this.timer = setInterval(() => void this.tick().catch(error => this.log(`board tick failed: ${String(error)}`)), everyMs);
    this.stopWakes = startThreadWakes({ wakes: this.db.wakes, host: this.host, log: this.log, checkOn: thread => this.checkOn(thread), ...this.wakeHooks });
  }
  stop(): void {
    // A precheck at work runs on outside this process, and its wait ends here with its pending entry kept for the next server process.
    this.stopping.abort();
    this.putsStopped = true;
    clearInterval(this.timer);
    clearTimeout(this.snoozeTimer);
    this.stopWakes?.();
  }

  async tick(now = Date.now()): Promise<void> {
    for (const chat of this.chats()) {
      const file = this.file(chat);
      const state = this.checkInState(chat, file);
      const last = state?.job;
      // A check-in job's report that a restart of this server cut off goes now, under the same request id, so it lands once.
      if (last?.submission !== undefined && !last.reported && !this.waiting.has(last.id)) void this.reportCheckIn(chat, { id: last.id, submission: last.submission });
      if (last?.reported && !last.archived) void this.archiveCheckIn(chat, last.id);
      if (state && !this.checkIns.has(chat)) {
        // The last board read sets the interval (`checkIn`); a board never read is read now, so one with no open step waits a day.
        if (!this.cache.has(chat)) await this.known(chat).catch(() => null);
        const view = this.checkIn(chat);
        if (view.nextAt !== null && view.nextAt <= now) {
          this.save(chat, { ...file, checkIn: { ...state, lastAt: now } });
          const run = this.runCheckIn(chat, now).catch(error => this.log(`check-in ${chat}: ${String(error)}`)).finally(() => this.checkIns.delete(chat));
          this.checkIns.set(chat, run);
        }
      }
      // Each due duty runs on its own; runDuty writes the duties file itself, so the tick does not wait for a precheck.
      for (const duty of file.duties) {
        const start = file.starts?.[duty.id];
        if (start && start.retryAt <= now) void this.retryDutyStart(chat, duty.id);
        void this.afterJob(chat, duty.id);
        void this.readAccountWait(chat, duty.id, file.runs[duty.id] ?? []);
        if (duty.status !== "active" || this.afters.has(`${chat}/${duty.id}`)) continue;
        if (nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt) > now) continue;
        void this.runDuty(chat, duty, "schedule");
      }
    }
    void this.owners.tick(now).catch(error => this.log(`owners tick failed: ${String(error)}`));
  }

  /**
   * Reads whether a duty's newest job waits for a model account and keeps since when in `accountWaits`, with a `duties` event on a change, so
   * the card says "waiting for a model account since 12:01". The job waits while pi-host reads it running or sleeping and either its place in
   * pi-pool's turn queue is `queued` or it has no model answer yet. A job pi-pool holds for an account slot reads `none` in the turn queue, and
   * its only answers are errors such as "the token hook gave no token" (the fable auditor's sweep jobs, 11-22), so an error is no answer.
   */
  private async readAccountWait(chat: string, dutyId: string, runs: readonly DutyRunRecord[]): Promise<void> {
    const key = `${chat}/${dutyId}`;
    if (this.waitReads.has(key)) return;
    this.waitReads.add(key);
    try {
      const sorted = [...runs].sort((a, b) => b.at - a.at);
      const run = sorted.find(entry => entry.job);
      const status = run?.job ? this.threads.thread(run.job.id)?.status : undefined;
      let since: number | undefined;
      if (run?.job && (status === "running" || status === "sleeping")) {
        const job = run.job.id;
        const ticket = await this.host.ticket(job).catch(() => null);
        // The job waits since the run that started it, the oldest run that names it.
        if (ticket?.place.state === "queued" || !(await this.answeredOnce(job))) since = runsOfJob(sorted, job).at(-1)!.at;
      }
      if (since === this.accountWaits.get(key)) return;
      if (since === undefined) this.accountWaits.delete(key);
      else this.accountWaits.set(key, since);
      this.dutiesChanged(chat);
    } catch (error) {
      this.log(`duty ${key}: reading whether its job waits for an account failed: ${String(error)}`);
    } finally {
      this.waitReads.delete(key);
    }
  }

  /**
   * Whether a work thread's own conversation runs a turn. pi-host reads a thread as running while any job conversation in it runs, and on
   * 10-29 that kept agent factory's work thread, with two jobs live all day, from its first check-in for an hour after its turn ended.
   */
  rootRunning(thread: string): boolean {
    const root = this.threads.tree(thread).find(node => node.id === 1);
    return root ? root.status === "running" : this.threads.thread(thread)?.status === "running";
  }

  /** The wakes the ticker still owes at `now` (`owedWakes`), as the step owners read them. */
  owedWakes(now: number): Promise<Wake[]> {
    return this.db.wakes.owed(now);
  }

  /**
   * Sets a wake for a thread's conversation, as the board skill's `board.wake(...)` asks for it from a durable thread's kernel: a run, a time
   * or a check (server/wakes.ts). The same file id twice writes one file, so a retried request sets one wake. The wake goes back to the thread
   * that armed it. Until 11-20 a job thread aliased to an agent had its wakes set on the agent's work thread, where its conversation is missing,
   * so the 22 job wakes set there from 10-29 to 11-19 failed on every tick and their jobs slept until someone messaged them.
   */
  async addWake(id: string, body: Record<string, unknown>): Promise<ReturnType<typeof armWake>> {
    const thread = this.wakeThread(id);
    if (!this.threads.thread(thread)) await this.threads.refresh().catch(() => undefined);
    if (!this.threads.thread(thread)) throw new Error(`No thread ${thread}.`);
    return armWake(this.db.wakes, thread, body);
  }

  /** The wakes set on a thread's conversation that have not gone out yet, which pi-host reads to keep a child running until they do. */
  wakes(id: string, conversation: number): Wake[] {
    const session = wakeSession(this.wakeThread(id), conversation);
    return this.pendingWakes().filter(wake => wake.session === session);
  }

  /**
   * Deletes the wakes set on a thread's conversation that have not gone out, which pi-host asks for when a job is removed, so a removed job's
   * check stops running and its wake never reaches it. Returns how many went.
   */
  dropWakes(id: string, conversation: number): number {
    const session = wakeSession(this.wakeThread(id), conversation);
    const dropped = this.db.wakes.list().filter(({ wake }) => wake.session === session);
    for (const { id } of dropped) void this.db.wakes.remove(id);
    if (dropped.length) this.log(`wakes: dropped ${dropped.length} of ${session}, a removed job`);
    return dropped.length;
  }

  /** The wakes not gone out yet on any conversation of these threads, as an agent's Threads tab lists them. */
  wakesOn(threads: ReadonlySet<string>): Wake[] {
    return this.pendingWakes().filter(wake => threads.has(wakeTarget(wake.session).thread));
  }

  /** Every wake that has not gone out yet. */
  private pendingWakes(): Wake[] {
    return this.db.wakes.list().map(({ wake }) => wake);
  }

  /** The thread a wake request names: a thread id as it is, and an agent id as the agent's work thread. */
  private wakeThread(id: string): string {
    return id.startsWith("ag_") ? this.threadOf(id) : id;
  }
}
