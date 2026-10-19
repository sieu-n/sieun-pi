import { execFile, type ExecFileException } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCutJobs } from "../scripts/duties/whole-system.ts";
import { WAIT_READ_TREES } from "./idle-unload.ts";
import type { InterruptedHead, InterruptedReport, InterruptedRun, JobOf, PoolHeldRun } from "./shared/interrupted.ts";
import type { SessionRow } from "./shared/types.ts";

/** The resume-paused-sessions skill owns the rule for which runs count as interrupted; the chat only runs it. */
const script = fileURLToPath(new URL("../../../skills/resume-paused-sessions/scripts/resume_paused.py", import.meta.url));
const CHECK_TTL_MS = 15_000;
/**
 * A pass longer than this logs a warning and keeps running: the dry run took 45 to 58 s on 10-18 and 67 s at 06:58Z, and the old 90 s kill
 * at 06:52Z and 06:57Z threw away a finished pass, 8 sent continues included, and left the Mac's jobs unchecked. Each daemon call and relay
 * read inside the script has its own bound (60 s and 20 s).
 */
const OVERRUN_WARN_MS = 90_000;
const ID_FLAGS = new Set(["--owners", "--only", "--unstuck"]);

/** The flags of a run, with each id list as its count: the 06:52Z log line on 10-18 named 134 owners and no cause. */
const describeArgs = (args: readonly string[]): string =>
  args.map((arg, index) => ID_FLAGS.has(args[index - 1] ?? "") ? `<${arg.split(",").filter(Boolean).length} ids>` : arg).join(" ");

const REASONS: ReadonlySet<string> = new Set<InterruptedRun["reason"]>(["error", "cut_off", "empty_reply", "hung", "worker_failed", "worker_stopped",
  "aborted", "never_started", "daemon_restart"]);
const isText = (value: unknown): value is string => typeof value === "string";
const isOptionalText = (value: unknown): boolean => value === undefined || typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isResult = (value: unknown): boolean => isText(value) || (isRecord(value) && (!("error" in value) || isText(value.error)));

/** The first field of `entry` the server reads that has the wrong type, as `<list>[<index>].<field>`, or null. */
function badField(list: string, entries: unknown, checks: Record<string, (value: unknown) => boolean>, optional = false): string | null {
  if (entries === undefined && optional) return null;
  if (!Array.isArray(entries)) return list;
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) return `${list}[${index}]`;
    const field = Object.entries(checks).find(([key, check]) => !check(entry[key]));
    if (field) return `${list}[${index}].${field[0]}`;
  }
  return null;
}

/** The script's JSON report, or why it is not one: the server reads each field below, so a wrong one is named instead of failing later. */
function parseReport(stdout: string): { report: InterruptedReport } | { malformed: string } {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return { malformed: stdout.trim() ? `printed ${Buffer.byteLength(stdout)} bytes that are not JSON` : "printed nothing" }; }
  if (!isRecord(value)) return { malformed: "printed JSON that is not an object" };
  const run = { id: isText, name: isText, reason: (reason: unknown) => isText(reason) && REASONS.has(reason), error: isText, errored_at: (at: unknown) => at === null || isOptionalText(at),
    head: isText, session_id: isOptionalText, head_session_id: isOptionalText, host: isOptionalText };
  const bad = (isText(value.checked_at) ? null : "checked_at")
    ?? badField("paused", value.paused, run)
    ?? badField("heads", value.heads, { id: isText, name: isText, result: isResult })
    ?? badField("children", value.children, { id: isText, name: isText, head: isText, result: isResult }, true)
    ?? badField("incomplete", value.incomplete, { host: (host: unknown) => host === null || isText(host), error: isText }, true)
    ?? badField("unresolved", value.unresolved, { id: isText, name: isText, session_id: isText, head: isText, head_session_id: isText,
      archived_at: isOptionalText, error: isText, host: isOptionalText }, true)
    ?? badField("stopped", value.stopped, { id: isText, name: isText, session_id: isText, head: isText, head_session_id: isText,
      stopped_at: (at: unknown) => at === null || isOptionalText(at), stopped_by: isText, host: isOptionalText }, true)
    ?? badField("held", value.held, { id: isText, name: isText, session_id: isText, head: isText, head_session_id: isText, tree: isText,
      provider: (provider: unknown) => provider === null || isText(provider), errored_at: (at: unknown) => at === null || isText(at), held_by: isText,
      pool_at: (at: unknown) => at === null || isText(at), host: isOptionalText }, true);
  return bad ? { malformed: `printed a report whose ${bad} is missing or has the wrong type` } : { report: value as unknown as InterruptedReport };
}

function exitCause(error: ExecFileException, ms: number): string {
  const after = `after ${(ms / 1000).toFixed(1)} s`;
  if (error.signal) return `ended by ${error.signal} ${after}`;
  if (typeof error.code === "number") return `exited ${error.code} ${after}`;
  return `failed (${error.code ?? error.name}) ${after}: ${error.message.split("\n")[0]}`;
}

const warnLine = (line: string): void => { process.stderr.write(`${line}\n`); };

/**
 * Runs the script to its end and answers its report, with a warning once it runs past `warnAfterMs`. A run that failed but printed a report
 * (a stop after its first box) answers that report, with the cause in `incomplete` when the script named none; a run with no report rejects
 * with its flags, exit cause and last output lines.
 */
export function runScript(args: readonly string[], file = script, warnAfterMs = OVERRUN_WARN_MS, warn = warnLine): Promise<InterruptedReport> {
  const started = Date.now();
  const overrun = setTimeout(() => warn(`resume: resume_paused.py ${describeArgs(args)} still running after ${(warnAfterMs / 1000).toFixed(1)} s`), warnAfterMs);
  return new Promise((resolve, reject) => {
    execFile(process.env.PYTHON ?? "python3", ["-B", file, "--json", ...args], { maxBuffer: Infinity }, (error, stdout, stderr) => {
      clearTimeout(overrun);
      const ms = Date.now() - started;
      if (ms > warnAfterMs) warn(`resume: resume_paused.py ${describeArgs(args)} took ${(ms / 1000).toFixed(1)} s`);
      const parsed = parseReport(stdout);
      if (!error && "report" in parsed) { resolve(parsed.report); return; }
      const said = stderr.trim().split("\n").slice(-3).join(" / ");
      const cause = error ? exitCause(error, ms) : `${"malformed" in parsed ? parsed.malformed : "printed no JSON"} after ${(ms / 1000).toFixed(1)} s`;
      const line = `resume_paused.py ${describeArgs(args)} ${cause}${error && "malformed" in parsed && stdout.trim() ? ` and ${parsed.malformed}` : ""}${said ? `: ${said}` : ""}`;
      if (!("report" in parsed)) { reject(new Error(line)); return; }
      const report = parsed.report;
      resolve(report.incomplete?.length ? report : { ...report, incomplete: [{ host: null, error: line }] });
    });
  });
}

const withIncomplete = (report: InterruptedReport, ...earlier: readonly InterruptedReport[]): InterruptedReport => {
  const incomplete = [...earlier.flatMap(run => run.incomplete ?? []), ...report.incomplete ?? []];
  return incomplete.length ? { ...report, incomplete } : report;
};


/**
 * Runs one check at a time for every open tab, and never next to a resume, so two clicks or two tabs cannot send "continue" to the same
 * head twice. A check answers with the last finished report and starts a new run once that report is 15 s old. On 10-18 on us-metal02 the
 * dry run took 45 to 58 s and a new run queued every 15 s behind the last one, so the script ran back to back and every page check
 * waited past its 90 s abort. Before the first run ends (after a service start or a resume) a check answers an empty report at once, and the
 * page's next check (each minute and on focus) gets the run's: a page load held a request open for that run for 90 to 120 s on 10-18.
 */
export class InterruptedRuns {
  private last: { at: number; report: InterruptedReport } | null = null;
  private pending: Promise<InterruptedReport> | null = null;
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly run: (args: readonly string[]) => Promise<InterruptedReport> = runScript) {}

  check(): Promise<InterruptedReport> {
    if (!this.pending && !(this.last && Date.now() - this.last.at < CHECK_TTL_MS)) {
      const epoch = this.epoch;
      const pending = this.pending = this.serial(() => this.run(["--dry-run"]));
      pending.then(report => { if (this.epoch === epoch) this.last = { at: Date.now(), report }; }, () => {})
        .finally(() => { if (this.pending === pending) this.pending = null; });
    }
    return Promise.resolve(this.last?.report ?? { paused: [], heads: [], checked_at: "" });
  }

  /** A resume changes what is paused, so the next check waits for a run that starts after it. */
  private forget(): void { this.last = null; this.pending = null; this.epoch++; }

  /**
   * A hung run (working, no activity for 30 min) cannot take a message, so `unstick` aborts it first; the script then counts the
   * aborted run as resumable through --unstuck and messages its head. A run whose worker died takes no command at all, so `reopen` opens
   * its head from the saved file, which starts the head on a new worker; the script then sees the reopened head and messages it.
   */
  resume(unstick: (sessionId: string) => Promise<void>, reopen: (sessionId: string) => Promise<void>): Promise<InterruptedReport> {
    const report = this.serial(async () => {
      const planned = await this.run(["--dry-run"]);
      const unstuck: string[] = [];
      for (const run of planned.paused) {
        if (run.reason !== "hung" || !run.session_id) continue;
        try { await unstick(run.session_id); unstuck.push(run.session_id); }
        catch (error) { process.stderr.write(`resume: could not abort ${run.id}: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
      const dead = new Set(planned.paused.flatMap(run => run.reason === "worker_failed" && run.head_session_id ? [run.head_session_id] : []));
      for (const head of dead) {
        try { await reopen(head); }
        catch (error) { process.stderr.write(`resume: could not reopen ${head}: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
      // The abort lands in the session file a moment after the call returns.
      if (unstuck.length) await new Promise(resolve => setTimeout(resolve, 2000));
      return this.run(unstuck.length ? ["--unstuck", unstuck.join(",")] : []);
    });
    this.forget();
    return report;
  }

  /**
   * The server's own pass over the jobs of its chats (`Chats`, once per job sweep): each interrupted run `isJob` keeps gets "continue" itself
   * (`--direct`), after the head of a dead worker among them is reopened. A hung job is left to Resume and the Mac usable watch: an abort drops
   * its turn's place in the pi-pool queue, where limits-mid-areas waited 19 min on 10-15. A hung job asleep in Prime's provider retry after an
   * interruption error (`retry_error`) holds no queue place, so `unstick` aborts it and it gets its continue too: after the 10-18 account outage
   * ssh tailnet only, admin access land and p3-jobs sat that way 113 to 144 min after a 429, with the accounts back. `unstick` resolves once the
   * aborted run reads idle (chat-backend.ts). Null when no job of a chat is interrupted.
   */
  resumeJobs(isJob: (run: JobOf) => boolean, reopen: (sessionId: string) => Promise<void>,
    owners: ReadonlySet<string> = new Set(), found?: (cut: readonly InterruptedRun[]) => Promise<void>,
    cut: ReadonlySet<string> = new Set(), unstick?: (sessionId: string) => Promise<void>): Promise<InterruptedReport | null> {
    const report = this.serial(async () => {
      const listed = new Set([...owners, ...cut]);
      const named = listed.size ? ["--owners", [...listed].join(",")] : [];
      const planned = await this.run(["--dry-run", "--direct", ...named]);
      const jobs = planned.paused
        .filter(run => run.session_id !== undefined && (run.reason !== "hung" || (unstick !== undefined && run.retry_error !== undefined)) &&
          (isJob(run) || cut.has(run.session_id)));
      // A run asleep in its retry that the script would not let the sweep abort says why: a stop record, an unreadable one, or a pool hold
      // or unknown pool answer. It stays with the Resume button.
      for (const run of planned.paused) {
        if (run.reason === "hung" && run.retry_blocked && isJob(run)) process.stderr.write(`resume: ${run.name} (${run.id}) sleeps in its provider retry; not aborted: ${run.retry_blocked}\n`);
      }
      await found?.(jobs).catch(error => { process.stderr.write(`resume: could not record the cut runs: ${error instanceof Error ? error.message : String(error)}\n`); });
      const unresolved = (planned.unresolved ?? []).filter(isJob);
      const stopped = (planned.stopped ?? []).filter(isJob);
      const pooled = (planned.held ?? []).filter(isJob);
      const held = { ...(unresolved.length ? { unresolved } : {}), ...(stopped.length ? { stopped } : {}), ...(pooled.length ? { held: pooled } : {}) };
      const notes = { ...(planned.incomplete?.length ? { incomplete: planned.incomplete } : {}), ...held };
      if (!jobs.length) return Object.keys(notes).length ? { paused: [], heads: [], checked_at: planned.checked_at, ...notes } : null;
      const reopenAll = async (ids: Iterable<string>): Promise<void> => {
        for (const id of new Set(ids)) {
          try { await reopen(id); }
          catch (error) { process.stderr.write(`resume: could not reopen ${id}: ${error instanceof Error ? error.message : String(error)}\n`); }
        }
      };
      await reopenAll(jobs.flatMap(run => run.reason === "worker_failed" && run.head_session_id ? [run.head_session_id] : []));
      const unstuck: string[] = [];
      const skipped = new Set<string>();
      for (const run of jobs) {
        if (run.reason !== "hung" || !unstick) continue;
        // Right before the abort, the script reads the run again: a stop record written since discovery (a delete, the owner's archive) or a
        // pi-pool wait or backoff on its tree drops its retry_error mark, and the run is left alone.
        const now = await this.run(["--dry-run", "--direct", "--only", run.session_id!, ...named, ...(run.host ? [] : ["--this-box"])]).catch(() => null);
        if (!now?.paused.some(again => again.session_id === run.session_id && again.reason === "hung" && again.retry_error !== undefined)) { skipped.add(run.session_id!); continue; }
        try { await unstick(run.session_id!); unstuck.push(run.session_id!); }
        catch (error) { skipped.add(run.session_id!); process.stderr.write(`resume: could not abort ${run.id}: ${error instanceof Error ? error.message : String(error)}\n`); }
      }
      const stuck = unstuck.length ? ["--unstuck", unstuck.join(",")] : [];
      jobs.splice(0, jobs.length, ...jobs.filter(run => !skipped.has(run.session_id!)));
      if (!jobs.length) return Object.keys(notes).length ? { paused: [], heads: [], checked_at: planned.checked_at, ...notes } : null;
      // The send pass skips the other boxes when every job is on this one: the Mac's lists took 30 to 60 s of a 50 to 110 s pass on 10-18,
      // and the 06:56Z send pass died on the 90 s limit before it reached census writer speed, the last of its 11 jobs.
      const box = jobs.some(run => run.host) ? [] : ["--this-box"];
      const sent = await this.run(["--direct", "--only", jobs.map(run => run.session_id).join(","), ...named, ...box, ...stuck]);
      // A job the daemon archived when it went down answers "Unknown active session" to every send, its parent's agent_message included
      // (queue audit, 10-15 22:28Z to 10-16 04:15Z, five failed sends), so it waits forever. Reopening it from its file lets the continue land.
      const gone = new Set((sent.children ?? []).flatMap(child => isGone(child.result) ? [child.id] : []));
      const lost = jobs.flatMap(run => gone.has(run.id) ? [run.session_id!] : []);
      if (!lost.length) return { ...withIncomplete(sent, planned), ...held };
      await reopenAll(lost);
      const again = await this.run(["--direct", "--only", lost.join(","), ...named, ...box, ...stuck]);
      const retried = new Map((again.children ?? []).map(child => [child.id, child]));
      return { ...withIncomplete({ ...sent, children: (sent.children ?? []).map(child => retried.get(child.id) ?? child) }, planned, again), ...held };
    });
    this.forget();
    return report;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export const interruptedRuns = new InterruptedRuns();

/**
 * The jobs under `chats` whose last turn was cut and that got no input since, by the Whole system duty's own rule (`findCutJobs`). The resume
 * script lists only sessions the daemon still runs, so 27 of the 39 cut jobs the duty counted at 05:22Z on 10-16 never got a continue.
 */
export async function cutJobs(dataDir: string, chats: readonly string[], artifacts = join(dataDir, "..", "session-artifacts")): Promise<Set<string>> {
  const deleted = JSON.parse(await readFile(join(dataDir, "deleted-jobs.json"), "utf8").catch(() => "{}")) as Record<string, Record<string, number>>;
  return new Set((await findCutJobs(artifacts, chats, deleted, Date.now())).map(job => job.session));
}

const isGone = (result: InterruptedHead["result"]): boolean => typeof result === "object" && "error" in result && result.error.includes("Unknown active session");

/**
 * The jobs the last pass left because pi-pool held their tree (`InterruptedReport.held`). At the first chat tick (CHECK_IN_TICK_MS) at or after
 * a run's pool time, or at each tick for a run with none, `admits` (`poolAdmits`, the same rule as resume_paused.py account_blocker) asks the
 * pool for its tree, and the chat runs the next pass at once for a tree it admits, instead of up to JOB_CLEANUP_EVERY_MS later. That pass checks
 * the pool again before it sends. A run on another box is left to that box's pool. On 10-19 twitch index gaps sat on its 429 until the
 * 06:06:14Z pass, 6 min after claude7 served again at 06:00Z.
 */
export class PoolHeldJobs {
  private runs: readonly PoolHeldRun[] = [];
  private held: ReadonlySet<string> = new Set();

  constructor(private readonly admits: (tree: string, provider: string) => Promise<boolean>) {}

  set(runs: readonly PoolHeldRun[]): void {
    this.runs = runs.filter(run => run.provider !== null && run.host === undefined);
    this.held = new Set(runs.map(run => run.session_id));
  }

  /**
   * The session of every run the last pass left held, on any box and with any provider: each is a live owner waiting for its pool time. On
   * 10-19 api portal vp's d2 runs at 14:09Z, 14:24Z and 14:40Z read parity prod promote 12, parity missing routes and parity crawler errors as
   * not live while pi-pool held all three trees after their 13:30Z to 14:08Z cuts.
   */
  sessions(): ReadonlySet<string> { return this.held; }

  /** The held runs at or past their pool time whose tree pi-pool admits at `now`. They leave the list, and the next pass lists them again if the pool still holds them. */
  async admitted(now: number): Promise<PoolHeldRun[]> {
    const key = (run: PoolHeldRun): string => `${run.tree}|${run.provider}`;
    const due = this.runs.filter(run => !(Date.parse(run.pool_at ?? "") > now));
    const trees = [...new Map(due.map(run => [key(run), run] as const)).values()];
    const open = new Set<string>();
    for (let from = 0; from < trees.length; from += WAIT_READ_TREES) {
      const part = trees.slice(from, from + WAIT_READ_TREES);
      const said = await Promise.all(part.map(run => this.admits(run.tree, run.provider!).catch(() => false)));
      part.forEach((run, index) => { if (said[index]) open.add(key(run)); });
    }
    const admitted = this.runs.filter(run => open.has(key(run)));
    if (admitted.length) this.runs = this.runs.filter(run => !open.has(key(run)));
    return admitted;
  }
}

/**
 * Each interrupted run under one of `chatRows` at any depth, or under one of their root jobs, gets "continue" itself (`interrupted`), and so
 * does each session in `owners` (the owners of the chats' open steps, see resume_paused.py --owners) wherever it sits, and each top-level
 * session that is no chat (its own head). Never a chat: `Chats.revive` restarts those. On 10-15 nothing restarted alert follow through after
 * its mid-tool stop at 13:29Z or the jobs a token hook failure and a worker stop ended at 13:48Z, two of them two levels under Crawler VP, and
 * their steps stalled over 2 h. On 10-18 the 7 roots moved from the Mac to us-metal02 at 21:14Z (the release owner 01a10810, metal box owner
 * 01a11d24 and five more) were neither a chat nor a chat's job, so after their 429s they slept in Prime's usage wait past 01:23Z on 10-19,
 * when pi-pool already admitted their trees, and no sweep looked at them.
 */
export async function resumeChatJobs(chatRows: readonly SessionRow[], chats: ReadonlySet<string>,
  interrupted: (isJob: (run: JobOf) => boolean, owners: ReadonlySet<string>) => Promise<InterruptedReport | null>, log: (line: string) => void,
  owners: ReadonlySet<string> = new Set(), held?: PoolHeldJobs): Promise<void> {
  const owned = new Set(chatRows.flatMap(row => [row.id, ...(row.agents ?? []).flatMap(agent => agent.link === "root" && agent.sessionId ? [agent.sessionId] : [])]));
  try {
    const report = await interrupted(run => !chats.has(run.session_id ?? "") && (owned.has(run.head_session_id ?? "") || owners.has(run.session_id ?? "") ||
      (run.session_id !== undefined && run.head_session_id === run.session_id)), owners);
    for (const job of report?.children ?? []) {
      const run = report!.paused.find(entry => entry.id === job.id);
      log(`job ${job.name}: interrupted (${run?.reason ?? "?"} at ${run?.errored_at ?? "?"}); continue: ${typeof job.result === "string" ? job.result : JSON.stringify(job.result)}`);
    }
    for (const entry of report?.incomplete ?? []) log(`chats: interrupted jobs: not finished on ${entry.host ?? "this box"}: ${entry.error}`);
    for (const entry of report?.unresolved ?? []) {
      log(`job ${entry.name}: not resumed: ${entry.error} (archive at ${entry.archived_at ?? "?"}, ${entry.session_id}${entry.host ? ` on ${entry.host}` : ""})`);
    }
    for (const entry of report?.stopped ?? []) {
      log(`job ${entry.name}: not resumed, stopped on purpose: ${entry.stopped_by} (${entry.session_id}${entry.host ? ` on ${entry.host}` : ""})`);
    }
    for (const entry of report?.held ?? []) {
      log(`job ${entry.name}: held by pi-pool until ${entry.pool_at ?? "a time it does not say"}: ${entry.held_by} (cut at ${entry.errored_at ?? "?"}, tree ${entry.tree.slice(0, 8)}, ${entry.session_id}${entry.host ? ` on ${entry.host}` : ""})`);
    }
    held?.set(report?.held ?? []);
  } catch (error) { log(`chats: interrupted jobs: ${error instanceof Error ? error.message : String(error)}`); }
}
