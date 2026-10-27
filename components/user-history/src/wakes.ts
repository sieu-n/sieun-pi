import { hostExecFile } from "./spawn-host.ts";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "./outbox.ts";

/**
 * Kernel-free waits. A job that waits for a CI run or a time calls `board.wake(...)` (skills/board), which writes one file to
 * `<dataDir>/wakes/`, and then ends its turn with nothing running. The chat service looks at each wake every TICK_MS and, when its run finished
 * or its time came, sends the job's session an agent message through the daemon, which reopens a passivated or evicted session. Before this
 * the only wait was a bash handle in the job's Python kernel, and Prime counts a session with one as busy, so it neither passivates the job nor
 * evicts its worker. 10-14 20:5xZ: 125 of 152 working sessions were such waits (82 on a CI run, 11 on a sleep), their kernels held 8.69 GB,
 * and 18 of them were root jobs whose Bun worker each stayed up only to wait, 8.92 GB with their kernels.
 */
/**
 * `attempt`: the lowest run attempt the wake waits for. A rerun keeps the run id and raises its attempt, so a job that waits for the rerun of a
 * finished run sets attempt to the next one; promote 17 (run 39493311906) on 10-21 had attempt 1 cancelled at 23:16Z and its rerun from 01:02Z,
 * and wakes set on it at 01:00Z went out at once on attempt 1's cancel.
 */
export type WakeOn = { kind: "run"; run: number; repo?: string; attempt?: number } | { kind: "time"; at: number };
/** `root`: the chat tree's root session, when the wake's session is a child of it; board.wake reads it from RLM_SESSION_DIR. */
export interface Wake { session: string; root?: string; on: WakeOn; note: string; since: number }
/** What a run's state read answers: still going, finished with its conclusion, or not readable now (looked at again next tick). */
/** `endedAt`: the run's last update on GitHub (`updatedAt`), which for a finished run is when its latest attempt ended. */
export type RunState = { done: false } | { done: true; conclusion: string; attempt?: number; endedAt?: number; url: string; label: string; why?: string } | { error: string };

export const TICK_MS = 30_000;
/** The file the ticker rewrites as it starts and on every beat (`startWakes`); board.wake refuses a wake while it is over 2 min old, since no service would deliver it. */
export const TICKED = ".ticked";
/** A run the CI cache does not stamp, or one read with `gh`, is read at most this often (GitHub's REST limit is 5,000 requests an hour). */
export const RUN_LOOK_MS = 2 * 60_000;
/**
 * A run wake whose run has read only errors for this long goes out with the error, so the job can set it again. HOLD_MS of the Whole system
 * duty (10 min, the owner's line on 10-15). On 10-18 three jobs had waited 60 to 71 h on slack-green runs that finished on 10-14 and 10-15,
 * because board.wake got no repo and the CI cache, which holds only its own repo, answered "not in the cache" every 2 min.
 */
export const UNREADABLE_MS = 10 * 60_000;
/** The longest a ticking service takes to send a run wake after its run ends: one RUN_LOOK_MS between reads of an unmoved run, plus one tick. */
export const RUN_WAKE_DUE_MS = RUN_LOOK_MS + TICK_MS;
/**
 * How long after a run's latest attempt ended a wake for a later attempt still waits for the rerun; past it the wake goes out saying the rerun
 * never started. On 10-24 14 wakes had waited 30 to 72 h for attempt 2 of runs that ended at attempt 1 on 10-21 to 10-23 and were never rerun,
 * and the chat counted their jobs as live owners, so Crawler VP's p890 and p929 sat blocked for 3 days after their blocker shipped.
 */
// measured: promote 17 run 39493311906 had attempt 1 cancelled at 23:16Z on 10-20 and its rerun started at 01:02Z on 10-21, a 106 min gap.
export const RERUN_GAP_MS = 120 * 60_000;
/** Whether `wake` waits for a later attempt than the finished run's latest one, and that attempt ended RERUN_GAP_MS or more before `now`. */
export function rerunMissed(wake: Wake, state: RunState | null, now: number): boolean {
  if (wake.on.kind !== "run" || !state || !("done" in state) || !state.done) return false;
  return (wake.on.attempt ?? 1) > (state.attempt ?? 1) && state.endedAt !== undefined && now - state.endedAt >= RERUN_GAP_MS;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SESSION = /^[\w-]{1,128}$/;
/** A wake file's content, parsed at the boundary; null when it is not one. */
export function parseWake(value: unknown): Wake | null {
  if (!isRecord(value) || typeof value.session !== "string" || !SESSION.test(value.session) || !isRecord(value.on)) return null;
  const note = typeof value.note === "string" ? value.note : "";
  const since = typeof value.since === "number" ? value.since : 0;
  const root = typeof value.root === "string" && SESSION.test(value.root) && value.root !== value.session ? { root: value.root } : {};
  const on = value.on;
  if (on.kind === "run" && typeof on.run === "number" && Number.isSafeInteger(on.run) && on.run > 0) {
    const attempt = typeof on.attempt === "number" && Number.isSafeInteger(on.attempt) && on.attempt > 1 ? { attempt: on.attempt } : {};
    return { session: value.session, ...root, note, since, on: { kind: "run", run: on.run, ...(typeof on.repo === "string" && on.repo ? { repo: on.repo } : {}), ...attempt } };
  }
  if (on.kind === "time" && typeof on.at === "number" && Number.isFinite(on.at)) return { session: value.session, ...root, note, since, on: { kind: "time", at: on.at } };
  return null;
}

/** The agent message a due wake sends; it names the wait so the job knows which of its waits ended. */
export function wakeText(wake: Wake, state: RunState | null, now: number): string {
  const note = wake.note ? ` Your note: ${wake.note}` : "";
  if (wake.on.kind === "run" && state && "error" in state) {
    return `[wake] Run ${wake.on.run}${wake.on.repo ? ` in ${wake.on.repo}` : ""} could not be read for ${Math.round(UNREADABLE_MS / 60_000)} min: ${state.error}. ` +
      `If it runs in another repo than the CI cache's, set board.wake(run=${wake.on.run}, repo="owner/name") again.${note}`;
  }
  if (wake.on.kind === "time") return `[wake] It is ${new Date(now).toISOString()}, the time you set with board.wake (${new Date(wake.on.at).toISOString()}).${note}`;
  const done = state && "done" in state && state.done ? state : null;
  if (done && rerunMissed(wake, done, now)) {
    const ended = done.endedAt === undefined ? "" : ` at ${new Date(done.endedAt).toISOString().slice(0, 16)}Z`;
    return `[wake] Run ${wake.on.run}${wake.on.repo ? ` in ${wake.on.repo}` : ""}: you waited for attempt ${wake.on.attempt}, but the rerun never started. ` +
      `Attempt ${done.attempt ?? 1} ended ${done.conclusion}${ended}${done.label ? ` (${done.label})` : ""} and no rerun followed in ${Math.round((now - (done.endedAt ?? now)) / 3_600_000)} h. ` +
      `${done.url} Wake on the run that replaced it, or set board.wake again once a rerun starts. You set this wake with board.wake.${note}`.replace(/\s+/g, " ").trim();
  }
  const about = [done?.attempt ? `attempt ${done.attempt}` : "", done?.label ?? ""].filter(Boolean).join(", ");
  const rerun = done?.attempt && done.conclusion !== "success"
    ? ` A rerun keeps this run id: to wait for its next attempt, set board.wake(run=${wake.on.run}, attempt=${done.attempt + 1}).` : "";
  return `[wake] Run ${wake.on.run}${wake.on.repo ? ` in ${wake.on.repo}` : ""} finished: ${done?.conclusion ?? "unknown"}${about ? ` (${about})` : ""}. ` +
    `${done?.why ? `${done.why} ` : ""}${done?.url ?? ""}${rerun} You set this wake with board.wake.${note}`.replace(/\s+/g, " ").trim();
}

export interface WakeDeps {
  dir: string;
  now?: () => number;
  /** Reads a run's state. A run whose `stamp` did not move is not read again before RUN_LOOK_MS. */
  runState: (on: Extract<WakeOn, { kind: "run" }>) => Promise<RunState>;
  /** The run's CI cache stamp (any string that changes when the run moves), or null when the cache has none. */
  stamp?: (run: number) => Promise<string | null>;
  /**
   * Hands the session the text on disk (src/agent-outbox.ts), which delivers it in the background: through a stopped subagent's parent, and
   * after starting the tree `root` when the daemon does not find the session. The daemon finds a child only while its tree's worker runs
   * (10-14 13:37Z: the idle sweep evicted this job's tree and wake-probe-2's wake at 13:39Z was dropped).
   */
  deliver: (session: string, text: string, root?: string, kind?: AgentKind, setAt?: number) => Promise<void>;
  /**
   * Called after each run read and each send, so TICKED shows a tick that is still moving. 10-15 12:16 to 12:35Z each send timed out after
   * 30 s and a tick with 5 sessions due took over 2.5 min, so TICKED aged past WAKE_LATE_MS while the tick ran and board.wake refused everywhere.
   */
  progress?: () => Promise<void>;
  log: (line: string) => void;
}

/** The wake files, one tick at a time; it remembers each run's last stamp and look so a quiet run costs one stat a tick. */
export class Wakes {
  private readonly looked = new Map<number, { stamp: string | null; at: number }>();
  /** Each run whose reads have only failed, from its first failed read on. */
  private readonly failing = new Map<number, { since: number; error: string }>();
  /** The wake files a pass handles now; a later pass leaves them alone. */
  private readonly handling = new Set<string>();
  /** The run reads under way, which a later pass shares instead of starting its own. */
  private readonly reading = new Map<number, Promise<RunState | null>>();
  private readonly now: () => number;
  constructor(private readonly deps: WakeDeps) { this.now = deps.now ?? Date.now; }

  /**
   * One pass: a session's due wakes go to the outbox as one message and their files are removed; a wake whose read or outbox write failed stays
   * for the next tick. Returns the count of sends. 10-14 12:35 to 12:56Z: release driver held up to 17 wakes due in one tick, each sent as its own
   * message, and the daemon refused the rest with "too many pending messages: 20 unfinished, limit is 20" every 2 s.
   *
   * Time wakes go at once, and a session's run wakes wait only for the reads of their own runs. A pass leaves alone the files an earlier pass
   * still handles and shares a run read still under way, so a slow read holds only the wakes on that run. Before, every wake waited for every
   * run read of its pass, and a pass still running skipped the next ones: on 10-19 from 15:32Z to 18:07Z 143 wakes were queued 100 s or more
   * after their pass began, and on 10-20 at 13:08Z two run wakes 4,995 s, while one read hung.
   */
  async tick(): Promise<number> {
    const names = await readdir(this.deps.dir).catch(() => [] as string[]);
    const now = this.now();
    const parsed: { file: string; wake: Wake }[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const file = join(this.deps.dir, name);
      let wake: Wake | null;
      try { wake = parseWake(JSON.parse(await readFile(file, "utf8"))); } catch { wake = null; }
      if (!wake) { if (!this.handling.has(file)) { this.deps.log(`wakes: ${name} is not a wake; removed`); await rm(file, { force: true }); } continue; }
      parsed.push({ file, wake });
    }
    const runs = new Set<number>();
    for (const { wake } of parsed) if (wake.on.kind === "run") runs.add(wake.on.run);
    for (const run of this.looked.keys()) if (!runs.has(run)) this.looked.delete(run);
    for (const run of this.failing.keys()) if (!runs.has(run)) this.failing.delete(run);
    // Every run is read at once and every session is sent at once: after the chat moved to us-metal02 (10-18 04:19Z) 170 wakes waited, and one
    // at a time at 3 to 5 s a send, a time wake set for 04:40:30Z went out at 04:42:58Z. The outbox keeps each send single (src/agent-outbox.ts).
    const mine = parsed.filter(({ file }) => !this.handling.has(file));
    for (const { file } of mine) this.handling.add(file);
    const groups = new Map<string, { file: string; wake: Wake }[]>();
    for (const item of mine) {
      const key = `${item.wake.session} ${item.wake.on.kind}`;
      groups.set(key, [...groups.get(key) ?? [], item]);
    }
    const results = await Promise.all([...groups.values()].map(async group => {
      try {
        const due: { file: string; wake: Wake; state: RunState | null }[] = [];
        const states = new Map<number, RunState | null>(await Promise.all([...new Set(group.flatMap(({ wake }) => wake.on.kind === "run" ? [wake.on.run] : []))]
          .map(async run => [run, await this.read(group.find(({ wake }) => wake.on.kind === "run" && wake.on.run === run)!.wake.on as Extract<WakeOn, { kind: "run" }>, now)] as const)));
        if (states.size) await this.moved();
        for (const { file, wake } of group) {
          let state: RunState | null = null;
          if (wake.on.kind === "run") {
            state = states.get(wake.on.run) ?? null;
            const failed = this.failing.get(wake.on.run);
            if (failed && now - failed.since >= UNREADABLE_MS) state = { error: failed.error };
            else if (!state || !("done" in state) || !state.done || ((wake.on.attempt ?? 1) > (state.attempt ?? 1) && !rerunMissed(wake, state, now))) continue;
          } else if (wake.on.at > now) continue;
          due.push({ file, wake, state });
        }
        return due.length ? await this.send(due, now) : false;
      } finally { for (const { file } of group) this.handling.delete(file); }
    }));
    return results.filter(Boolean).length;
  }

  /** The read of a run, shared by every pass while it is under way (`look`). */
  private read(on: Extract<WakeOn, { kind: "run" }>, now: number): Promise<RunState | null> {
    const going = this.reading.get(on.run);
    if (going) return going;
    const read = this.look(on, now).finally(() => this.reading.delete(on.run));
    this.reading.set(on.run, read);
    return read;
  }

  /** One session's due wakes as one message to the outbox; their files go once it is on disk. */
  private async send(wakes: { file: string; wake: Wake; state: RunState | null }[], now: number): Promise<boolean> {
    const session = wakes[0]!.wake.session;
    const what = wakes.map(({ wake }) => wake.on.kind === "run" ? `run ${wake.on.run}` : "its time").join(", ");
    try {
      const text = wakes.map(({ wake, state }) => wakeText(wake, state, now)).join("\n");
      const root = wakes.find(({ wake }) => wake.root)?.wake.root;
      await this.deps.deliver(session, text, root, "wake", Math.max(...wakes.map(({ wake }) => wake.since)));
      for (const { file } of wakes) await rm(file, { force: true });
      this.deps.log(`wakes: woke ${session} for ${what}, waited ${Math.round((now - Math.min(...wakes.map(({ wake }) => wake.since))) / 60_000)} min, queued ${Math.round((this.now() - now) / 1000)} s after the tick began`);
      return true;
    } catch (error) {
      this.deps.log(`wakes: wake ${session} for ${what}: ${error instanceof Error ? error.message : String(error)}; tried again next tick`);
      return false;
    } finally { await this.moved(); }
  }

  private async moved(): Promise<void> {
    await this.deps.progress?.().catch(error => this.deps.log(`wakes: ${TICKED}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The run's state, or null when its stamp did not move and it was read less than RUN_LOOK_MS ago. */
  private async look(on: Extract<WakeOn, { kind: "run" }>, now: number): Promise<RunState | null> {
    const stamp = on.repo || !this.deps.stamp ? null : await this.deps.stamp(on.run).catch(() => null);
    const last = this.looked.get(on.run);
    if (last && now - last.at < RUN_LOOK_MS && (stamp === null || stamp === last.stamp)) return null;
    this.looked.set(on.run, { stamp, at: now });
    const state = await this.deps.runState(on).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in state) {
      this.deps.log(`wakes: run ${on.run}: ${state.error}`);
      if (!this.failing.has(on.run)) this.failing.set(on.run, { since: now, error: state.error });
    } else this.failing.delete(on.run);
    return state;
  }
}

const CI_CACHE = process.env.CI_CACHE_DIR ?? join(homedir(), ".cache", "virev");
const PATH_WITH_LOCAL = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", process.env.PATH ?? ""].join(":");
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    hostExecFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: PATH_WITH_LOCAL } }, (error, stdout, stderr) => {
      if (error && !stdout) { reject(new Error(String(stderr || error.message).trim().split("\n")[0])); return; }
      resolve(stdout);
    });
  });
}

/** The repo the local CI cache polls (ci-cache.mjs SLUG). */
export const CI_CACHE_REPO = "sieu-n/auto-sns-agent";
/**
 * The other repos whose runs jobs wake on with no repo given, tried in order when the cache's repo has no such run. On 10-18 at 11:32Z two
 * slack-green jobs set board.wake on runs 39123561025 and 39123644786 with no repo, every read answered 404 in the cache's repo, and the
 * finished runs held their wakes 12 and 13 min (d7 queue_holds_30 2 at 11:46Z).
 */
export const OTHER_RUN_REPOS: readonly string[] = ["sieu-n/slack-green", "sieu-n/sieun-pi"];
/**
 * ci-run-status's status for a run with no result (ci-cache.mjs NO_RESULT): a ghost, which GitHub still lists as queued when every job of its
 * attempt finished or when it has had no job for GHOST_EMPTY_MS (2 min) after it started, or a finished run with no job that GitHub calls
 * success. The cache's ghost rule already waited out that grace, and such a run never reaches a result, so its wake goes out with the reason.
 * Crawler VP 10-20: about 15 jobs slept from 10-19 21:07Z on promote run 39323562100, which read this way, because the ticker took only a
 * "completed" status as final.
 */
export const NO_RESULT = "ghost, no result";
const NO_RESULT_WHY = "The CI cache reads it as a ghost or a jobless run, so it will not report a result: rerun it or push again if you still need one.";
/** ci-run-status's answer for a run the poller has not listed yet. */
const NOT_CACHED = / is not in the cache /;
/** ci-run-status's answer once the cache has not moved past its readers' dead line (ci-cache.mjs deadMs, 10 min at the 30 s pace). */
const DEAD_CACHE = / has not moved since /;
/**
 * The gh the CI cache's shims hand off to (ci-cache.mjs REAL_GH). The gh on PATH answers `gh run view` from the cache until the cache is 10 min
 * old, so a read that must skip a stale cache calls this one.
 */
export const REAL_GH = process.env.CI_CACHE_REAL_GH || (process.platform === "darwin" ? "/opt/homebrew/bin/gh" : join(homedir(), ".local/opt/gh-2.89.0/bin/gh"));
/** The poller's pace when its heartbeat names none (ci-cache.mjs INTERVAL_S). */
export const CACHE_INTERVAL_S = 30;
/** Poll intervals with no good read of GitHub after which a wake reads its run from GitHub instead of the cache. */
export const STALE_CYCLES = 3;
/** What the poller's heartbeat (ci-cache.heartbeat.json, written after every cycle, good or failed) says. */
export interface CacheBeat { fetchedAt: number; intervalSeconds: number; error?: string }

/** The heartbeat's content, parsed at the boundary; null when it is not one. */
export function parseBeat(value: unknown): CacheBeat | null {
  if (!isRecord(value) || typeof value.fetchedAt !== "string") return null;
  const fetchedAt = Date.parse(value.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  const interval = typeof value.intervalSeconds === "number" && value.intervalSeconds > 0 ? value.intervalSeconds : CACHE_INTERVAL_S;
  return { fetchedAt, intervalSeconds: interval, ...typeof value.error === "string" && value.error ? { error: value.error } : {} };
}

/** Whether the cache's last good read of GitHub is over STALE_CYCLES of the poller's own pace old; a backed-off poller paces itself slower. */
export const beatStale = (beat: CacheBeat, now: number): boolean => now - beat.fetchedAt > STALE_CYCLES * beat.intervalSeconds * 1000;

/** The poller's heartbeat in `dir`, or null when there is none to read. */
export async function readBeat(dir = CI_CACHE): Promise<CacheBeat | null> {
  try { return parseBeat(JSON.parse(await readFile(join(dir, "ci-cache.heartbeat.json"), "utf8"))); } catch { return null; }
}

/**
 * Whether the CI cache is stale now, logging each change once: "wakes: CI cache stale ..." when it goes stale and "wakes: CI cache fresh ..." when
 * it reads GitHub again. From 11:23:57Z to 13:08:28Z on 10-20 every ci-cache cycle on us-metal02 failed with "fetch failed", ci-run-status
 * answered "has not moved since 11:23:16Z" from 11:34Z, and the ticker sent the wakes on promote run 39382235504 out at 11:45:16Z as unreadable,
 * while gh, which reads GitHub without Node's resolver, still worked.
 */
export function cacheWatch(log: (line: string) => void, beat: () => Promise<CacheBeat | null> = readBeat, now: () => number = Date.now): () => Promise<boolean> {
  let was = false;
  return async () => {
    const read = await beat();
    const stale = read !== null && beatStale(read, now());
    if (stale !== was && read) log(stale
      ? `wakes: CI cache stale since ${new Date(read.fetchedAt).toISOString()} (pace ${read.intervalSeconds} s${read.error ? `, last cycle: ${read.error}` : ""}); run wakes read GitHub with gh run view`
      : `wakes: CI cache fresh again at ${new Date(read.fetchedAt).toISOString()}; run wakes read the cache`);
    was = stale;
    return stale;
  };
}
/** gh's answer for a run id its repo does not have. */
const NO_SUCH_RUN = /HTTP 404/;

/**
 * A run's state from the local CI cache (`ci-run-status <id>`, no GitHub call) or, for a run in another repo, from `gh run view`. A run the
 * cache has not listed yet is read with `gh run view` in the cache's repo: from 00:24Z to 00:44Z on 10-18 a GitHub token sat at 0 calls left,
 * the poller backed off to a 10 min cycle, and run 39083318405, created at 00:35:23Z, read "not in the cache" from 00:38Z to 00:44Z, so its
 * wake counted as unreadable and would have gone out with an error at UNREADABLE_MS while the run was still queued. While `stale` says the cache
 * has not read GitHub for STALE_CYCLES of its pace, or ci-run-status calls it dead, the run is read with the real gh (REAL_GH), past the shims.
 * A run the cache reads as completed is read once more with the real gh, which answers its latest attempt: a rerun starts between two of the
 * poller's cycles, and at 01:02:43Z on 10-21 the cache still read promote run 39493311906's attempt 1 as cancelled 6 s after attempt 2 started.
 * When that read fails, the cache's answer stands.
 */
export async function readRunState(on: Extract<WakeOn, { kind: "run" }>, exec: (command: string, args: string[]) => Promise<string> = run,
  stale: () => Promise<boolean> = async () => false): Promise<RunState> {
  const gh = (repo: string, bin = "gh") => exec(bin, ["run", "view", String(on.run), "--repo", repo, "--json", "status,conclusion,attempt,url,workflowName,headBranch,updatedAt"]);
  const anyRepo = async (bin = "gh"): Promise<string> => {
    let missing: unknown;
    for (const repo of [CI_CACHE_REPO, ...OTHER_RUN_REPOS]) {
      try { return await gh(repo, bin); } catch (error) {
        if (!(error instanceof Error && NO_SUCH_RUN.test(error.message))) throw error;
        missing = error;
      }
    }
    throw missing;
  };
  const cached = async (): Promise<{ text: string; cache: boolean }> => {
    if (await stale()) return { text: await anyRepo(REAL_GH), cache: false };
    try { return { text: await exec("ci-run-status", [String(on.run)]), cache: true }; } catch (error) {
      if (error instanceof Error && NOT_CACHED.test(error.message)) return { text: await anyRepo(), cache: false };
      if (error instanceof Error && DEAD_CACHE.test(error.message)) return { text: await anyRepo(REAL_GH), cache: false };
      throw error;
    }
  };
  const read = on.repo ? { text: await gh(on.repo), cache: false } : await cached();
  let raw = JSON.parse(read.text) as Record<string, unknown>;
  if (read.cache && raw.status === "completed") raw = JSON.parse(await gh(CI_CACHE_REPO, REAL_GH).catch(() => read.text)) as Record<string, unknown>;
  const ghost = raw.status === NO_RESULT;
  if (raw.status !== "completed" && !ghost) return { done: false };
  const workflow = typeof raw.workflow === "string" ? raw.workflow : typeof raw.workflowName === "string" ? raw.workflowName : "";
  const branch = typeof raw.headBranch === "string" ? raw.headBranch : "";
  const attempt = typeof raw.attempt === "number" && Number.isSafeInteger(raw.attempt) && raw.attempt > 0 ? { attempt: raw.attempt } : {};
  const updated = Date.parse(String(raw.updatedAt));
  const endedAt = Number.isFinite(updated) ? { endedAt: updated } : {};
  return { done: true, conclusion: ghost ? "no result" : typeof raw.conclusion === "string" ? raw.conclusion : "unknown", ...attempt, ...endedAt, url: typeof raw.url === "string" ? raw.url : "",
    label: [workflow, branch].filter(Boolean).join(" on "), ...ghost ? { why: NO_RESULT_WHY } : {} };
}

/** The CI cache poller rewrites a run's stamp only when its status, conclusion, attempt or a job moved. */
export async function runStamp(id: number): Promise<string | null> {
  const info = await stat(join(CI_CACHE, "ci-runs.d", `${id}.stamp`)).catch(() => null);
  return info ? `${info.ino}:${info.mtimeMs}:${info.size}` : null;
}

/**
 * How late a wake may be and still count as owed: the service ticks every TICK_MS, and board.wake refuses a wake once the last tick is over
 * 2 min old (TICKED). A time wake more than this past its time, or any wake while the last tick is older than this, is one nobody delivers.
 */
export const WAKE_LATE_MS = 2 * 60_000;

/**
 * The wakes the service still owes at `now`: every run wake and every time wake still ahead, whatever the age of the last tick (`tickedAt`,
 * from TICKED), since a wake file stays until the service sends it; and a time wake already due while the last tick is at most WAKE_LATE_MS
 * old, however late its send is. The check-in counts a job asleep on one as a live owner (`withWakes`). AI harness 10-18 01:32Z: the service
 * was busy for about 2 min (a 4.1 s catalog list, a burst of session opens, idle unloads), TICKED aged past WAKE_LATE_MS, and the old rule owed
 * none of the 75 pending wakes, so that check-in nudged jobs asleep on their wakes and restarted one. 03:27Z: with the daemon's list at 131.6 s
 * the ticker sent wakes up to 41 min late, and the check-in restarted "waiting jobs count as live" 5 min after its 03:22:27Z wake was due.
 */
export function owedWakes(wakes: readonly Wake[], tickedAt: number | undefined, now: number): Wake[] {
  const ticking = tickedAt !== undefined && now - tickedAt <= WAKE_LATE_MS;
  return wakes.filter(wake => wake.on.kind === "run" || wake.on.at > now || ticking);
}

/** The wake files in `dir` the service still owes at `now` (`owedWakes`). */
export async function pendingWakes(dir: string, now: number): Promise<Wake[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const tickedAt = Date.parse(await readFile(join(dir, TICKED), "utf8").catch(() => ""));
  // Every file at once: each catalog projection reads them, and 76 reads one after another each waited behind the rest of the main thread's work.
  const read = await Promise.all(names.filter(name => name.endsWith(".json"))
    .map(name => readFile(join(dir, name), "utf8").then(text => parseWake(JSON.parse(text)), () => null).catch(() => null)));
  const wakes = read.filter((wake): wake is Wake => wake !== null);
  return owedWakes(wakes, Number.isFinite(tickedAt) ? tickedAt : undefined, now);
}

/** What a session's owed wakes wait for: "a board.wake at 14:40Z", or "board.wakes on run 38555915600 and at 15:00Z". */
export function wakeLabel(wakes: readonly Wake[]): string {
  const what = [...wakes].sort((a, b) => (a.on.kind === "time" ? a.on.at : 0) - (b.on.kind === "time" ? b.on.at : 0))
    .map(({ on }) => on.kind === "time" ? `at ${new Date(on.at).toISOString().slice(11, 16)}Z` : `on run ${on.run}${on.repo ? ` in ${on.repo}` : ""}`);
  return `${what.length === 1 ? "a board.wake" : "board.wakes"} ${what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0]}`;
}

/**
 * The wakes of `session` and of every session below it (`below` gives a session's child sessions). A job that ended its turn while its
 * subagents sleep on board.wakes is live: ops guy 10-18 01:14Z, crawler prod alerts was told "ended" twice in 2 min while alerts-g-media slept
 * on runs 39084595194 and 39084587449 and its siblings on their own wakes.
 */
export function treeWakes(session: string, below: (session: string) => readonly string[], wakes: readonly Wake[]): Wake[] {
  const sessions = new Set([session]);
  for (const id of sessions) for (const child of below(id)) sessions.add(child);
  return wakes.filter(wake => sessions.has(wake.session));
}

/** A job's wakes in the Agents card's words, soonest time first: "waits for run 39080016700", "waits for 14:40Z", "waits for run 1 and 15:00Z". */
export function wakeWait(wakes: readonly Wake[]): string {
  const what = [...new Set([...wakes].sort((a, b) => (a.on.kind === "time" ? a.on.at : 0) - (b.on.kind === "time" ? b.on.at : 0))
    .map(({ on }) => on.kind === "time" ? `${new Date(on.at).toISOString().slice(11, 16)}Z` : `run ${on.run}`))];
  return `waits for ${what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0] ?? "a board.wake"}`;
}

/** Whether `session` has a wake file in `dir`. */
export async function waking(dir: string, session: string): Promise<boolean> {
  return (await readdir(dir).catch(() => [] as string[])).some(name => name.startsWith(`${session}-`) && name.endsWith(".json"));
}

/**
 * Ticks the wakes at once and then every TICK_MS until the returned stop is called; a tick still running when the next comes is left to run,
 * and the next runs beside it on the files it does not hold (`Wakes.tick`).
 * TICKED is stamped when the ticker starts, on every TICK_MS beat even while a tick runs, after each run read and send, and when a tick ends,
 * so it ages only while no service runs this ticker. 10-15: a tick took 30 s to over 2 min (a run read under load, a send held up to 30 s by a
 * slow daemon), and releases and crashes restarted the service at 10:3xZ, 13:49:5xZ and 15:21:3xZ. At the 10:33:18Z VP of CI check-in the stamp
 * was the old service's last finished tick, past WAKE_LATE_MS, so `pendingWakes` owed nothing and "ci release driver", asleep on run
 * 38708750431, read idle and p96 stuck. Crawler VP's 13:41:51Z check-in ran inside a tick of sends that each timed out after 30 s, and its
 * 15:22:22Z one read the wakes 30 s after the restarted service began and before its first tick: both owed no wake at all, so "index land
 * follow through", asleep on run 38724863673, and "crawler lab window", asleep on wakes at 16:00Z and 22:00Z, read idle, and p92, p107, p110,
 * p178, p185 and p18 stuck and blocked on others.
 */
export function startWakes(deps: WakeDeps, everyMs = TICK_MS): () => void {
  const fail = (error: unknown) => deps.log(`wakes: ${error instanceof Error ? error.message : String(error)}`);
  const stamp = () => mkdir(deps.dir, { recursive: true, mode: 0o700 }).then(() => writeFile(join(deps.dir, TICKED), new Date((deps.now ?? Date.now)()).toISOString()));
  const wakes = new Wakes({ ...deps, progress: stamp });
  const beat = () => { void stamp().then(() => wakes.tick()).then(stamp).catch(fail); };
  beat();
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
