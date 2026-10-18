import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kernel-free waits. A job that waits for a CI run or a time calls `board.wake(...)` (skills/board), which writes one file to
 * `<dataDir>/wakes/`, and then ends its turn with nothing running. The chat service looks at each wake every TICK_MS and, when its run finished
 * or its time came, sends the job's session an agent message through the daemon, which reopens a passivated or evicted session. Before this
 * the only wait was a bash handle in the job's Python kernel, and Prime counts a session with one as busy, so it neither passivates the job nor
 * evicts its worker. 10-14 20:5xZ: 125 of 152 working sessions were such waits (82 on a CI run, 11 on a sleep), their kernels held 8.69 GB,
 * and 18 of them were root jobs whose Bun worker each stayed up only to wait, 8.92 GB with their kernels.
 */
export type WakeOn = { kind: "run"; run: number; repo?: string } | { kind: "time"; at: number };
/** `root`: the chat tree's root session, when the wake's session is a child of it; board.wake reads it from RLM_SESSION_DIR. */
export interface Wake { session: string; root?: string; on: WakeOn; note: string; since: number }
/** What a run's state read answers: still going, finished with its conclusion, or not readable now (looked at again next tick). */
export type RunState = { done: false } | { done: true; conclusion: string; url: string; label: string } | { error: string };

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
    return { session: value.session, ...root, note, since, on: { kind: "run", run: on.run, ...(typeof on.repo === "string" && on.repo ? { repo: on.repo } : {}) } };
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
  return `[wake] Run ${wake.on.run}${wake.on.repo ? ` in ${wake.on.repo}` : ""} finished: ${done?.conclusion ?? "unknown"}${done?.label ? ` (${done.label})` : ""}. ` +
    `${done?.url ?? ""} You set this wake with board.wake.${note}`.replace(/\s+/g, " ").trim();
}

export interface WakeDeps {
  dir: string;
  now?: () => number;
  /** Reads a run's state. A run whose `stamp` did not move is not read again before RUN_LOOK_MS. */
  runState: (on: Extract<WakeOn, { kind: "run" }>) => Promise<RunState>;
  /** The run's CI cache stamp (any string that changes when the run moves), or null when the cache has none. */
  stamp?: (run: number) => Promise<string | null>;
  /** Sends the session the text; resolves "gone" when the daemon knows no such session. */
  deliver: (session: string, text: string) => Promise<"sent" | "gone">;
  /**
   * Starts the worker of the chat tree `root` with no prompt. The daemon finds a child only while its tree's worker runs, so a child whose tree
   * was evicted is "gone" until then (10-14 13:37Z: the idle sweep evicted this job's tree, wake-probe-2's wake at 13:39Z was dropped, and the
   * same message reached it at 13:45Z once a wake had restarted the root). Absent: such a wake is dropped.
   */
  startRoot?: (root: string) => Promise<void>;
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
  private readonly now: () => number;
  constructor(private readonly deps: WakeDeps) { this.now = deps.now ?? Date.now; }

  /**
   * One pass: a session's due wakes go out as one message and their files are removed; a wake whose read or send failed stays for the next tick.
   * Returns the count of sessions messaged. 10-14 12:35 to 12:56Z: release driver held up to 17 wakes due in one tick, each sent as its own
   * message, and the daemon refused the rest with "too many pending messages: 20 unfinished, limit is 20" every 2 s.
   */
  async tick(): Promise<number> {
    const names = await readdir(this.deps.dir).catch(() => [] as string[]);
    const now = this.now();
    const states = new Map<number, RunState | null>();
    const due = new Map<string, { file: string; wake: Wake; state: RunState | null }[]>();
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const file = join(this.deps.dir, name);
      let wake: Wake | null;
      try { wake = parseWake(JSON.parse(await readFile(file, "utf8"))); } catch { wake = null; }
      if (!wake) { this.deps.log(`wakes: ${name} is not a wake; removed`); await rm(file, { force: true }); continue; }
      let state: RunState | null = null;
      if (wake.on.kind === "run") {
        if (!states.has(wake.on.run)) {
          states.set(wake.on.run, await this.look(wake.on, now));
          await this.moved();
        }
        state = states.get(wake.on.run) ?? null;
        const failed = this.failing.get(wake.on.run);
        if (failed && now - failed.since >= UNREADABLE_MS) state = { error: failed.error };
        else if (!state || !("done" in state) || !state.done) continue;
      } else if (wake.on.at > now) continue;
      due.set(wake.session, [...due.get(wake.session) ?? [], { file, wake, state }]);
    }
    let sent = 0;
    for (const [session, wakes] of due) {
      const what = wakes.map(({ wake }) => wake.on.kind === "run" ? `run ${wake.on.run}` : "its time").join(", ");
      try {
        const text = wakes.map(({ wake, state }) => wakeText(wake, state, now)).join("\n");
        const root = wakes.find(({ wake }) => wake.root)?.wake.root;
        let result = await this.deps.deliver(session, text);
        if (result === "gone" && root && this.deps.startRoot) {
          await this.deps.startRoot(root);
          result = await this.deps.deliver(session, text);
        }
        for (const { file } of wakes) await rm(file, { force: true });
        if (result === "sent") sent++;
        this.deps.log(`wakes: ${result === "sent" ? "woke" : "dropped, no such session:"} ${session.slice(0, 8)} for ${what}, waited ${Math.round((now - Math.min(...wakes.map(({ wake }) => wake.since))) / 60_000)} min`);
      } catch (error) {
        this.deps.log(`wakes: wake ${session.slice(0, 8)} for ${what}: ${error instanceof Error ? error.message : String(error)}; tried again next tick`);
      }
      await this.moved();
    }
    for (const run of this.looked.keys()) if (!states.has(run)) this.looked.delete(run);
    for (const run of this.failing.keys()) if (!states.has(run)) this.failing.delete(run);
    return sent;
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
    execFile(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: PATH_WITH_LOCAL } }, (error, stdout, stderr) => {
      if (error && !stdout) { reject(new Error(String(stderr || error.message).trim().split("\n")[0])); return; }
      resolve(stdout);
    });
  });
}

/** The repo the local CI cache polls (ci-cache.mjs SLUG). */
export const CI_CACHE_REPO = "sieu-n/auto-sns-agent";
/** ci-run-status's answer for a run the poller has not listed yet. */
const NOT_CACHED = / is not in the cache /;

/**
 * A run's state from the local CI cache (`ci-run-status <id>`, no GitHub call) or, for a run in another repo, from `gh run view`. A run the
 * cache has not listed yet is read with `gh run view` in the cache's repo: from 00:24Z to 00:44Z on 10-18 a GitHub token sat at 0 calls left,
 * the poller backed off to a 10 min cycle, and run 39083318405, created at 00:35:23Z, read "not in the cache" from 00:38Z to 00:44Z, so its
 * wake counted as unreadable and would have gone out with an error at UNREADABLE_MS while the run was still queued.
 */
export async function readRunState(on: Extract<WakeOn, { kind: "run" }>, exec: (command: string, args: string[]) => Promise<string> = run): Promise<RunState> {
  const gh = (repo: string) => exec("gh", ["run", "view", String(on.run), "--repo", repo, "--json", "status,conclusion,url,workflowName,headBranch"]);
  const raw = JSON.parse(on.repo ? await gh(on.repo)
    : await exec("ci-run-status", [String(on.run)]).catch((error: unknown) => {
      if (error instanceof Error && NOT_CACHED.test(error.message)) return gh(CI_CACHE_REPO);
      throw error;
    })) as Record<string, unknown>;
  if (raw.status !== "completed") return { done: false };
  const workflow = typeof raw.workflow === "string" ? raw.workflow : typeof raw.workflowName === "string" ? raw.workflowName : "";
  const branch = typeof raw.headBranch === "string" ? raw.headBranch : "";
  return { done: true, conclusion: typeof raw.conclusion === "string" ? raw.conclusion : "unknown", url: typeof raw.url === "string" ? raw.url : "",
    label: [workflow, branch].filter(Boolean).join(" on ") };
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
  const wakes: Wake[] = [];
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const wake = await readFile(join(dir, name), "utf8").then(text => parseWake(JSON.parse(text)), () => null).catch(() => null);
    if (wake) wakes.push(wake);
  }
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
 * Ticks the wakes at once and then every TICK_MS until the returned stop is called; a tick still running when the next comes is left to run.
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
  let running = false;
  const beat = () => {
    if (running) { void stamp().catch(fail); return; }
    running = true;
    void stamp().then(() => wakes.tick()).then(stamp).catch(fail).finally(() => { running = false; });
  };
  beat();
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
