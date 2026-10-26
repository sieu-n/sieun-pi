import type { IdIndex } from "./id-index.ts";
import { sessionHandles } from "./shared/created-sessions.ts";
import { cachedJsonFile, type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";
import type { Ledger } from "./chat-corrections.ts";
import type { CheckInRecord } from "./chat-checkin.ts";
import type { CheckInSettings } from "./checkin-settings.ts";
import type { DutyRef } from "./checkin-findings.ts";
import type { PrState } from "./checkin-done.ts";
import type { DutyRunRecord } from "./shared/chat-duties.ts";
import type { HeldTurns } from "./held-turns.ts";
import type { Unstarted } from "./brief-keeper.ts";
import type { ClaudeState } from "./chat-recovery.ts";
import type { CheckInRun, CheckInStart } from "./chat-duty-run.ts";
import type { JobResumes } from "./job-resume.ts";
import type { PrimeUpdate } from "./prime-update.ts";
import type { InterruptedReport, JobOf } from "./shared/interrupted.ts";
import type { Wake } from "./wakes.ts";
import type { AwayHost } from "./shared/host-hold.ts";
import type { StalledCall } from "./shared/stalled-calls.ts";
import type { ArtifactDisk } from "./checkin-load.ts";
import type { JobCancelRecord } from "./job-cancels.ts";
import type { ArchiveBy, ServiceArchive } from "./service-archives.ts";
import type { Leftovers } from "./job-leftovers.ts";
import type { PoolPlaces } from "./chat-turn-queue.ts";
import type { BoardOp, ChatBoard, ChatWait, ChildAgent, FirstMessage, ModelInfo, QueueState, RetryState, SessionRow, ThinkingLevel, ThreadMessage } from "./shared/types.ts";

export type SubagentDelete = "deleted" | "not_held" | "running";

/** What the Chats class (src/chats.ts) reads and drives: the thread backend, the check-in sources, and the job, reply-check and brief-check records. */

/**
 * Which chat started a root, by its session name or id. The chat's extension writes a name when a cell calls rlm.create_session; the duty
 * runner writes a duty job's session id (src/chat-duty-job.ts). The root's extension reads it at start and again at its first prompt.
 */
export interface JobRegistry {
  /** Files `names` under the chat's name and, when known, its session id (`chatId`), which `rootsOf` matches when no name is at hand. */
  add(names: readonly string[], chat: string, chatId?: string): Promise<void>;
  chatOf(name: string): Promise<string | undefined>;
  /** The session id of the chat a name was filed under, when the add knew it. */
  chatIdOf(name: string): Promise<string | undefined>;
  /** The session names (or ids, for a duty job) a chat (by any of its names: its session name, its id) started. */
  rootsOf(chat: readonly string[]): Promise<string[]>;
  /** Drops entries: a retired duty job. */
  remove(names: readonly string[]): Promise<void>;
}
/**
 * Registers under `chat` the root every create_session handle in a tool result's text names (`sessionHandles`). A cell that names its roots
 * with a variable (`name=name` in a loop) has no literal for tool_call to read (AI harness 10-14: the 15:01 KST check-in started skill rules
 * land, stale tree guard land and skill rewrite land that way, and the 17:01 and 19:02 check-ins read their steps as held by other threads).
 */
export async function registerPrintedRoots(registry: Pick<JobRegistry, "add">, text: string, chat: string, chatId?: string): Promise<string[]> {
  const names = [...new Set(sessionHandles(text).map(handle => handle.name).filter(Boolean))];
  if (names.length) await registry.add(names, chat, chatId);
  return names;
}
const REGISTRY_KEEP_MS = 30 * 24 * 60 * 60_000;
/**
 * The job names filed under each chat name and chat id, built once per parsed registry. Until 10-20 each ask walked all 1,050 jobs, and the
 * catalog asks for each chat on each projection: 8.2 s of a 308 s profile of a scratch serve on a copy of the live data dir with its chats.
 */
type RootIndex = { names: string[]; byChat: Map<string, number[]> };
const rootIndexes = new WeakMap<object, RootIndex>();
function rootIndex(state: { jobs: Record<string, { chat: string; chatId?: string }> }): RootIndex {
  let index = rootIndexes.get(state);
  if (index) return index;
  index = { names: Object.keys(state.jobs), byChat: new Map() };
  for (const [at, name] of index.names.entries()) {
    const entry = state.jobs[name]!;
    for (const key of entry.chatId !== undefined && entry.chatId !== entry.chat ? [entry.chat, entry.chatId] : [entry.chat]) {
      const places = index.byChat.get(key);
      if (places) places.push(at); else index.byChat.set(key, [at]);
    }
  }
  rootIndexes.set(state, index);
  return index;
}
/**
 * `<data dir>/chat-jobs.json`: `{ jobs: { [sessionName or id]: { chat, chatId?, at } } }` through locked-json; entries older than 30 days go on
 * the next add. `chatId` came on 10-18: checkin-precheck.ts --roster drops an idle chat's row, so the precheck had only the chat's id, and
 * slack green guy's own roots, filed under its name, read as held elsewhere.
 */
export function jobRegistry(path: string, now: () => number = Date.now): JobRegistry {
  type Entry = { chat: string; at: number; chatId?: string };
  const file: JsonFile<{ jobs: Record<string, Entry> }> = { path, label: "Chat job registry", initial: () => ({ jobs: {} }), parse(value: unknown) {
    const jobs = typeof value === "object" && value !== null && "jobs" in value && typeof value.jobs === "object" && value.jobs !== null ? value.jobs as Record<string, unknown> : {};
    return { jobs: Object.fromEntries(Object.entries(jobs).filter((entry): entry is [string, Entry] => {
      const job = entry[1] as Partial<Entry> | null;
      return typeof job === "object" && job !== null && typeof job.chat === "string" && typeof job.at === "number";
    })) };
  } };
  return {
    async add(names, chat, chatId) {
      const at = now();
      await transactJsonFile(file, state => {
        for (const [name, entry] of Object.entries(state.jobs)) if (at - entry.at > REGISTRY_KEEP_MS) delete state.jobs[name];
        for (const name of names) state.jobs[name] = { chat, at, ...(chatId ? { chatId } : {}) };
      });
    },
    async chatOf(name) { return (await cachedJsonFile(file)).jobs[name]?.chat; },
    async chatIdOf(name) { return (await cachedJsonFile(file)).jobs[name]?.chatId; },
    async rootsOf(chat) {
      const { names, byChat } = rootIndex(await cachedJsonFile(file));
      // In the registry's order, as the walk over every job gave them.
      return [...new Set(chat.flatMap(key => byChat.get(key) ?? []))].sort((left, right) => left - right).map(at => names[at]!);
    },
    async remove(names) { await transactJsonFile(file, state => { for (const name of names) delete state.jobs[name]; }); },
  };
}

/** The time of the newest item each chat got a check for, on disk so a server restart neither loses nor repeats the check. */
export interface CheckRecord {
  /** Records `at` as the chat's last checked item; true when it is newer than the one on record, so this caller sends the check. */
  claim(id: string, at: number): Promise<boolean>;
}
/** A record file such as `<data dir>/correction-checks.json` through locked-json: `{ [key]: at }`. */
export function checkRecord(path: string): CheckRecord {
  const file: JsonFile<Record<string, number>> = { path, label: "Check record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))) : {} };
  return {
    async claim(id, at) {
      return (await transactJsonFile(file, state => { if ((state[id] ?? -Infinity) >= at) return false; state[id] = at; return true; })).result;
    },
  };
}
/** An owner message older than this when the server first looks at it gets no `[correction check]`: the owner has moved on. */
export const CHECK_MAX_AGE_MS = 60 * 60_000;

/** The jobs a `[brief check]` was sent for, on disk so a server restart does not send it again. */
export interface BriefCheckRecord {
  /** Records the job; true when it was not on record, so this caller sends the check. */
  claim(childId: string, spawnedAt: number): Promise<boolean>;
}
/** `<data dir>/brief-checks.json` through locked-json: `{ [childId]: spawn time }`. Entries a day old go on the next claim. */
export function briefCheckRecord(path: string, now: () => number = Date.now): BriefCheckRecord {
  const file: JsonFile<Record<string, number>> = { path, label: "Brief check record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1]))) : {} };
  return {
    async claim(childId, spawnedAt) {
      return (await transactJsonFile(file, state => {
        if (state[childId] !== undefined) return false;
        for (const [id, at] of Object.entries(state)) if (now() - at > 24 * 60 * 60_000) delete state[id];
        state[childId] = spawnedAt;
        return true;
      })).result;
    },
  };
}
/**
 * The finished jobs the cleanup already deleted, on disk so a service restart does not delete them again. The daemon keeps listing a deleted
 * subagent's session under its chat, so after each restart the cleanup read it as a finished job again: on 10-14 frontend bro's email app outside
 * in was "deleted" 5 times (02:18Z to 03:36Z, each after a service start), and every later delete_rlm_subagent answered `deleted: false`.
 */
export interface DeletedJobRecord {
  /** The chat's jobs on record that its `listed` subagents still hold. */
  gone(chat: string, listed: readonly string[]): Promise<Set<string>>;
  /** Records a delete and drops each job of the chat that its `listed` subagents no longer hold, so the record stays as small as the listing. */
  add(chat: string, childId: string, at: number, listed: readonly string[]): Promise<void>;
}
/**
 * `<data dir>/deleted-jobs.json`: `{ [chat]: { [childId]: delete time } }`. `gone` reads the file without the lock, since every write replaces
 * it whole by rename: on 10-14 from 07:42Z every chat's cleanup ran `gone` under the lock at the same tick, and each one gave up after the
 * lock's 3 s wait with "Deleted job record is busy" (service.log, 12 lines from 07:42Z to 09:22Z and no delete after 07:12Z).
 */
export function deletedJobRecord(path: string): DeletedJobRecord {
  const file: JsonFile<Record<string, Record<string, number>>> = { path, label: "Deleted job record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Record<string, number>] => typeof entry[1] === "object" && entry[1] !== null)) : {} };
  return {
    async gone(chat, listed) {
      const jobs = (await snapshotJsonFile(file))[chat] ?? {};
      return new Set(Object.keys(jobs).filter(id => listed.includes(id)));
    },
    async add(chat, childId, at, listed) {
      await transactJsonFile(file, state => {
        const jobs: Record<string, number> = { ...state[chat], [childId]: at };
        for (const id of Object.keys(jobs)) if (id !== childId && !listed.includes(id)) delete jobs[id];
        state[chat] = jobs;
      });
    },
  };
}

/**
 * When the service last sent a message for a stopped subagent through its parent (`AgentOutbox`, `relayNote`), by the subagent's session id.
 * The relay leaves no wake file, and the subagent runs only once its parent passes the message on, so until then it is still owed that turn.
 * mac-management 10-22 01:16:36Z: the 30 min wake of metal agent queue went to the chat, which Prime had parked on its quota until 02:00Z,
 * and the cleanup ended the job at 01:47Z as quiet with no wake.
 */
export interface RelayRecord {
  add(session: string, at: number): Promise<void>;
  /** The time of the session's last relay, or undefined when none is on record. */
  at(session: string): Promise<number | undefined>;
}
/** `<data dir>/relayed.json`: `{ [session id]: last relay time }`, read without the lock since every write replaces it whole by rename. */
export function relayRecord(path: string): RelayRecord {
  const file: JsonFile<Record<string, number>> = { path, label: "Relay record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number")) : {} };
  return {
    async add(session, at) { await transactJsonFile(file, state => { state[session] = Math.max(at, state[session] ?? at); }); },
    async at(session) { return (await snapshotJsonFile(file))[session]; },
  };
}

/**
 * The jobs the failed-turn check (`Chats.wakeJob`) found fine, each with the activity stamp it had then, on disk so a service restart does not
 * look at them again. The check kept them in memory only, so after each restart it opened every job of the last 24 h with its file page and
 * attach: 384 opens in the first minute after the 21:33:56Z restart on 10-18, while the chat's main thread was 74 to 97% busy for 4 minutes.
 */
export interface QuietJobRecord {
  read(): Promise<Map<string, string>>;
  write(quiet: ReadonlyMap<string, string>): Promise<void>;
}
/** `<data dir>/quiet-jobs.json`: `{ [job session id]: activity stamp }`, written whole by rename. */
export function quietJobRecord(path: string): QuietJobRecord {
  const file: JsonFile<Record<string, string>> = { path, label: "Quiet job record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {} };
  return {
    async read() { return new Map(Object.entries(await snapshotJsonFile(file))); },
    async write(quiet) { await transactJsonFile(file, state => { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, Object.fromEntries(quiet)); }); },
  };
}

/** The server notices held for chats Prime parked on a provider wait (`Chats.tell`), oldest first. */
export interface HeldNoticeRecord {
  read(): Promise<ReadonlyMap<string, readonly string[]>>;
  /** Holds one more notice for the chat, behind the ones it holds; answers how many it holds now. */
  add(chat: string, message: string): Promise<number>;
  /** Drops the chat's oldest `count` notices, once they went. */
  drop(chat: string, count: number): Promise<void>;
  forget(chat: string): Promise<void>;
}

/** `<data dir>/held-notices.json`: `{ [chat id]: [notice, ...] }`, oldest first, written whole by rename. */
export function heldNoticeRecord(path: string): HeldNoticeRecord {
  const file: JsonFile<Record<string, string[]>> = { path, label: "Held notice record", initial: () => ({}), parse: value => typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(item => typeof item === "string"))) : {} };
  const keep = (state: Record<string, string[]>, chat: string, left: string[]) => { if (left.length) state[chat] = left; else delete state[chat]; };
  return {
    async read() { return new Map(Object.entries(await snapshotJsonFile(file))); },
    async add(chat, message) { return (await transactJsonFile(file, state => { keep(state, chat, [...state[chat] ?? [], message]); return state[chat]!.length; })).result; },
    async drop(chat, count) { await transactJsonFile(file, state => keep(state, chat, (state[chat] ?? []).slice(count))); },
    async forget(chat) { await transactJsonFile(file, state => keep(state, chat, [])); },
  };
}

/** A job spawned longer ago than this when the server first sees it gets no `[brief check]`, so a restart does not check every old job. */
export const BRIEF_CHECK_MAX_AGE_MS = 30 * 60_000;

/** What chats need from the thread hub. ThreadHub satisfies it; tests pass a fake. */
export interface ChatThreads {
  create(input: { cwd: string; provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; name: string; kind: "chat"; host?: string; first?: FirstMessage }): Promise<{ id: string }>;
  /** Keeps the chat attached and resumes it after each daemon restart; every chat is pinned. */
  pin(id: string): void;
  unpin(id: string): void;
  setSteeringMode(id: string, mode: "all" | "one-at-a-time"): Promise<void>;
  /** The attached session's heartbeat prompt, undefined when it has none. */
  heartbeat(id: string): Promise<string | undefined>;
  clearHeartbeat(id: string): Promise<void>;
  /** Sends text as a steer: it joins the running turn or starts one. A steer to a chat whose last turn failed can wait in its queue unseen. */
  prompt(id: string, input: { message: string; images: []; mode: "steer" }): Promise<void>;
  /**
   * Starts a new turn in a chat whose last turn failed: sends the text and resumes the session's queued input, so neither waits unseen.
   * `abort` first stops a provider retry that holds the turn.
   */
  restart(id: string, message: string, abort?: boolean): Promise<void>;
  /** Stops the running turn or provider retry; the input pump stays suspended until `resumeQueue` or `restart`. */
  abort(id: string): Promise<void>;
  /** Reopens the session's input pump, so queued input runs now. */
  resumeQueue(id: string): Promise<void>;
  /**
   * Deletes a finished subagent of the chat (the daemon's delete_rlm_subagent, the path `rlm.delete_subagent` takes). The daemon checks the
   * subagent's turn in the same request and refuses one that streams or holds an unfinished action (`running`); `not_held` means the chat no
   * longer holds that subagent (the daemon answers `deleted: false`) though its session may still be listed.
   */
  deleteSubagent(id: string, childId: string): Promise<SubagentDelete>;
  /** Whether the daemon shows the session in a turn, a tool call or a background bash now (`isSessionActive`); false when it is not resident. */
  sessionActive(id: string): Promise<boolean>;
  /** Undoes an archive: the session comes back as a saved thread that resumes on the next pin or reply. */
  unarchive(id: string): Promise<void>;
  /** Resumes the session and attaches it; throws when the daemon does not resume it. */
  resume(id: string): Promise<unknown>;
  /** Archives the session: its turn stops, its worker ends and its session file records the archived state. `by` is the owner or the service's reason. */
  archive(id: string, by: ArchiveBy): Promise<void>;
  /** The service's own archive operations on the session that service-archives.json holds. */
  serviceArchiveOf(id: string): Promise<readonly ServiceArchive[]>;
  /** A transcript line that starts no turn; the feed shows it as a notice. */
  notice(id: string, text: string): Promise<void>;
  /** What the feed shows under the owner's unanswered message while a restart waits; null clears it. */
  setWait(id: string, wait: ChatWait | null): void;
  /** A thread's state for a stall check, attaching it first; null when it is not live. */
  view(id: string): Promise<ThreadView | null>;
  /** Whether the thread is mid-turn or has input queued; the reload waits for it. */
  busy(id: string): boolean;
  /** Whether the thread runs a turn now; queued input alone does not count, since after a failed turn it can wait there unseen. */
  running(id: string): boolean;
  /** Re-runs the session's extensions, so it gets the current tools and brief. */
  reload(id: string): Promise<void>;
  /**
   * `reload` for a thread that may not be attached (a job): only when the daemon shows it doing nothing, no turn, queued input or background
   * work in its kernel, which a reload would drop. "busy" leaves it for a later look; "saved" is a thread with no live session, which loads
   * the build on disk when it resumes.
   */
  reloadIdle(id: string): Promise<"reloaded" | "busy" | "saved">;
  /** Whether the hub holds an attach of the thread now; while it does, its children come from the attach and not from the daemon's rows. */
  isLive?(id: string): boolean;
  /** Whether the chat is dormant now, when the daemon refuses to delete its subagents (`deleteSubagent`); absent: never. */
  isDormant?(id: string): boolean;
  /** `live` fires after each attach with the children known then; `children` on every change while attached; `idle` at each turn's end. */
  observe(observer: { live(id: string, children: readonly ChildAgent[]): void; children(id: string, children: readonly ChildAgent[]): void; idle(id: string): void }): () => void;
  /**
   * The chat's state as the server holds it while attached: the no-report notice looks for the job's last message in the transcript, the tick
   * reads who started the running turn and whether the last one failed, and `links` takes the board, the name and the children for the agents list.
   */
  state?(id: string): ThreadView | undefined;
  /** When the thread's streaming turn last sent a session event; null when no turn streams (idle, compacting, a bash, a provider retry). */
  quietSince?(id: string): number | null;
}
/** The parts of a thread's state the chat side reads. */
export interface ThreadView {
  messages: readonly ThreadMessage[]; board?: ChatBoard | null; children?: readonly ChildAgent[]; queue?: QueueState; retry?: RetryState | null;
  info?: { name?: string; model?: ModelInfo | null; thinkingLevel?: ThinkingLevel; availableThinkingLevels?: readonly ThinkingLevel[]; retryAttempt?: number; queuedActions?: number };
}
export type ChatSummary = (id: string) => Promise<{ lifecycle?: string; sessionFile?: string } | undefined>;
/** The chat side's inputs to `chatAgents` (src/chat-agents.ts); the catalog adds the daemon's sessions. */
export interface ChatLinks { children: readonly ChildAgent[]; board: ChatBoard | null; roots: string[]; messages: readonly ThreadMessage[] }

/** What the check-in reads besides the children: the board, the catalog rows (threads a plan item links), its memory and the owner's setting per chat. */
export interface CheckInSource {
  /** The board as its file holds it, reused while the file is unchanged (`BoardStore.view`), so a caller never changes it. */
  board(id: string): Promise<ChatBoard | null>;
  rows(): Promise<readonly SessionRow[]>;
  /** The roots chats started with rlm.create_session (`<data dir>/chat-jobs.json`); absent in tests that need none. */
  registry?: JobRegistry;
  /** The home folder whose `.prime/agent/session-artifacts/<chat id>/scheduled-jobs.json` holds a chat's heartbeats; the user's home when absent. */
  home?: string;
  /** The disk of the other box that runs a chat (`chatDisk`), where its jobs' quota parks are; null or absent: this box's at `home`. */
  artifacts?: (chat: string) => Promise<ArtifactDisk | null>;
  memory: CheckInRecord;
  settings: CheckInSettings;
  /** How often the scheduler wakes to run the chats whose interval has passed; 0 starts no timer (tests call `tick`). Default CHECK_IN_TICK_MS. */
  tickMs?: number;
  now?: () => number;
  /** How long a job must stay quiet before the no-report notice; default NO_REPORT_GRACE_MS. Tests pass 0. */
  noReportGraceMs?: number;
  /** The pool's account availability, null when the pool cannot be read. */
  claude?: () => Promise<ClaudeState | null>;
  /** Whether pi-pool would give the tree rooted at `tree` a `provider` account now (`poolAdmits`); absent or failing: it holds. */
  poolAdmits?: (tree: string, provider: string) => Promise<boolean>;
  /** Where the sessions of the cut jobs pi-pool holds are kept across restarts (`PoolHeldJobs`); absent: kept in memory only. */
  poolHeldFile?: string;
  /** Gets the whole chat list each time it loads or changes, so each box's turn queue starts the runs of the chats it runs first (`leadWriter`). Absent: none is written. */
  lead?: (chats: readonly string[]) => Promise<void>;
  /** The sessions every box's turn queue holds (`queueReader`), queued or working, which the check-in reads as waiting, not stalled; absent or failing: none. */
  queue?: () => Promise<PoolPlaces>;
  /** Told at each wake whether any chat or any of its jobs works now; the service holds the Mac awake while it does (src/chat-awake.ts). */
  awake?: (working: boolean) => void;
  /** The newest correction each chat's `/refine` or `[correction check]` covered (`<data dir>/correction-checks.json`, keys `<chat>` and `<chat>:ask`). Absent: none is sent. */
  correctionChecks?: CheckRecord;
  /** The jobs that got a `[brief check]` (`<data dir>/brief-checks.json`). Absent: no brief check runs. */
  briefChecks?: BriefCheckRecord;
  /** The finished jobs the cleanup deleted (`<data dir>/deleted-jobs.json`). Absent (tests): each serve remembers its own deletes only. */
  deletedJobs?: DeletedJobRecord;
  /** The jobs the failed-turn check found fine (`<data dir>/quiet-jobs.json`). Absent (tests): each serve looks at every job once. */
  quietJobs?: QuietJobRecord;
  /** The notices held for parked chats (`<data dir>/held-notices.json`, `Chats.tell`). Absent: every notice goes at once. */
  heldNotices?: HeldNoticeRecord;
  /** The owner's Stops and Archives of jobs (`<data dir>/job-cancels.json`, `Chats.cancelJob`). Absent (tests): no cancel is kept. */
  cancels?: JobCancelRecord;
  /**
   * Stops what a gone job left (src/job-leftovers.ts `endLeftovers`): the processes its sessions' kernels started detached and the Aside tabs
   * they opened, under its session folder `dir`, the repo copies in the wiki session folders it opened, and the /tmp trees it made with the
   * processes in them, once the cleanup deleted or archived it. Absent: nothing is stopped.
   */
  leftovers?: (dir: string, session?: string) => Promise<Leftovers>;
  /** Stops what the subagents the daemon marked deleted under a chat left (`deletedFolders`, `endLeftovers`). Absent: no sweep. */
  deletedLeftovers?: (chat: string) => Promise<Leftovers>;
  /** Whether a session holds a pending `board.wake` (src/wakes.ts); the cleanup keeps such a job, since its wake would reopen it. */
  waking?: (session: string) => Promise<boolean>;
  /** The messages sent to stopped subagents through their parents (`<data dir>/relayed.json`); the cleanup keeps a job owed one. Absent: none. */
  relayed?: RelayRecord;
  /** The Prime update restoring this box's daemon now (`primeUpdateRunning`), or null; the idle-root sweep archives nothing while one runs. Absent: none. */
  updating?: () => Promise<PrimeUpdate | null>;
  /** The board.wakes the service still owes at a time (`pendingWakes`); the check-in counts a job asleep on one as working. Absent: none. */
  wakes?: (now: number) => Promise<readonly Wake[]>;
  /**
   * The box of hosts.json named `host` when Tailscale reads it offline (src/host-reach.ts), else null; the check-in holds the steps of jobs
   * there on an open For you todo that asks the owner to bring it back (`hostHolds`). Absent: no box reads offline.
   */
  hostAway?: (host: string) => Promise<AwayHost | null>;
  /** The sessions in one tool call past STALL_MS at a time (`stalledCalls`); the check-in counts a job stalled in one as not working. Absent: none. */
  stalls?: (now: number) => ReadonlyMap<string, StalledCall>;
  /**
   * Where the cleanup saves a root it archives (`JobResumes`, src/job-resume.ts), and how it writes the note of a step it hands back to the chat
   * (the board store's apply). Absent: no root is archived and no step is handed back.
   */
  resumes?: { store: JobResumes; applyBoard(id: string, ops: readonly BoardOp[]): Promise<unknown> };
  /**
   * Sends "continue" to each interrupted run that `isJob` keeps, as the resume script finds them at any depth (`InterruptedRuns.resumeJobs`).
   * Absent (tests): the job sweep resumes nothing.
   */
  interrupted?: (isJob: (run: JobOf) => boolean, owners: ReadonlySet<string>) => Promise<InterruptedReport | null>;
  /** The turns the service holds and gives back itself (`readHeldTurns`), which the check-in reads as moving; absent or failing: none. */
  held?: (now: number) => Promise<HeldTurns>;
  /** The jobs whose session never got its first prompt (`unstartedJobs`, src/brief-keeper.ts), which the check-in reads as not started; absent or failing: none. */
  unstarted?: (now: number) => Promise<readonly Unstarted[]>;
  /** The owner's corrections ledger, for its handoffs (`handoffRules`). Absent: no step gets a scope line. */
  corrections?: () => Promise<Ledger>;
  /** A clean-room chat's scratch ledger (CLEAN_ROOM_CORRECTIONS_FILE), null for any other chat. Absent: every chat reads the real one. */
  cleanRoom?: (chat: string) => Promise<Ledger | null>;
  /**
   * The duty runner's side of the check-in duty (src/chat-duty-run.ts): each check-in run is recorded as a run of the built-in duty and starts
   * one check-in job with the precheck as context. Absent (tests): the precheck runs and nothing starts.
   */
  duty?: { checkIn(chatId: string, run: CheckInRun): Promise<CheckInStart | void>; lastCheckIn(chatId: string): Promise<number | undefined>;
    /** Records a met check-in for a chat with nothing to check when its newest one did not read met (`Duties.checkInClean`); absent in test fakes. */
    checkInClean?(chatId: string, at: number, trigger: CheckInRun["trigger"]): Promise<void>;
    /** Writes a notice's full list next to the chat's duty runs and returns the path (`Duties.writeDetail`); absent in test fakes. */
    writeDetail?(chatId: string, name: string, parts: readonly string[]): Promise<string> };
  /** The chat's duties (`<data dir>/duties/<chat>.json`), for the goals they run (`goalsToFold`) and a chat with goals and no duty (`goalsWithoutDuty`). Absent: neither is counted. */
  duties?: (id: string) => Promise<readonly DutyRef[]>;
  /** The session ids of the chat's duty jobs (its duty run records, check-ins included), whose subagents may own its steps. Absent: none. */
  dutyJobs?: (id: string) => Promise<readonly string[]>;
  /** The chat's duty runs, newest first, whose metric verdicts tell when a fix step is done (`metricFacts`). Absent: no fix step looks done. */
  dutyRuns?: (id: string) => Promise<readonly DutyRunRecord[]>;
  /** The GitHub state of PRs by number, in the repo of a folder (`prStates`, src/pr-states.ts). Absent: no PR reads as merged. */
  prs?: (cwd: string, numbers: readonly string[]) => Promise<ReadonlyMap<string, PrState>>;
  /**
   * `<data dir>/archived-chats.json`: the chats the owner archived (`Chats.archive`), until the owner unarchives one (`Chats.restore`) or sends to it (`Chats.reopen`). The
   * scan never takes such a chat back and its sidebar row stays archived, while its session may still wake and answer an agent message. Absent
   * (tests): an owner archive is not remembered.
   */
  archived?: IdIndex;
  /** `<data dir>/clean-room-chats.json`: the clean-room test chats, which the scan never takes back as chats after their teardown. Absent (tests): none. */
  cleanRoomChats?: IdIndex;
  /**
   * Set on a serve that does not own the live chats (a test or scratch data dir, `chat serve --no-adopt`): `<data dir>/own-chats.json`, the chats
   * this serve created. It pins, steers, reloads and checks in only those, even when its chats.json is a copy of the live one, and never scans
   * the session files for lost chats (10-10: a scratch serve on the real daemon attached 4 live chats and reloaded 3).
   */
  owned?: IdIndex;
}
