import { open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentKind } from "./outbox.ts";
import { zTime } from "./checkin-goals.ts";
import type { JobFact } from "./checkin-steps.ts";
import { fileLines } from "./file-lines.ts";
import type { JobModel } from "./job-resume.ts";
import { isThinkingLevel, type ThinkingLevel } from "./shared/types.ts";

/**
 * The brief of every job a chat or its jobs start, kept until the job's session file shows it. Prime holds a new session's first prompt and
 * entries in its worker's memory and writes them to the file later. At 23:43 to 00:04Z on 10-15/16, ten children in three trees (Crawler VP's
 * "opensearch disk move" at 23:58:30Z and "post reads schema fix" at 00:03:27Z among them) showed only their 5 header lines for 17 to 37 min,
 * and the supervisor restart at 00:20:13Z threw away what their workers held, the brief with it. The check-in then read both jobs as working
 * or idle. The kernel wrapper (message-limit-check.py) writes each spawn's brief to
 * `<data dir>/spawn-briefs/` as rlm.spawn or rlm.create_session returns, so the brief no longer lives only in that memory.
 *
 * This sends a brief whose session file still has none BRIEF_LATE_MS after the spawn, whatever dropped it, unless the live worker of its tree
 * ran the session's agent, and sends it at most once to each worker. A worker writes its session file late under load: at 06:03 to 06:06Z on
 * 10-16 four lim-* children showed only their 5 header lines at 06:14Z, though their worker's recovery journal had their agent_start 6 to 40 s
 * after the spawn, and the first version of this keeper sent each a second copy. The second version waited for a supervisor restart and so
 * missed a worker that stops under a live supervisor: at 14:35:39Z on 10-15 every worker got SIGTERM while the supervisor ran on until 14:46Z,
 * and 20 children spawned from 14:14 to 14:34Z never got their brief. Of 1,714 children spawned from 10-13 00:00Z to 10-16 07:39Z, 65 never got
 * it: 45 at a supervisor restart and 20 at that worker stop. A record goes once its session holds its brief or its child ended.
 */

export const BRIEFS_DIR = "spawn-briefs";
/**
 * A session with no first prompt this long after its spawn has lost it or is stuck. Of 1,976 child sessions started from 10-13 to 10-16 05:30Z
 * the first prompt landed within 274 s at p99 (p50 3 s, p90 33 s); of 1,662 roots, within 189 s at p99.
 */
export const BRIEF_LATE_MS = 5 * 60_000;
/** The keeper reads the records on the wakes' 30 s tick (wakes.ts TICK_MS). */
export const BRIEF_TICK_MS = 30_000;

/** One spawn the kernel wrapper recorded: a child from rlm.spawn (its RLM child id) or a root from rlm.create_session (its session id). */
export interface BriefRecord {
  kind: "child" | "root";
  id: string;
  name: string;
  prompt: string;
  /** Epoch ms when the spawn returned. */
  at: number;
  /** The root session of its tree, which `startRoot` loads when the daemon no longer finds the session. */
  root: string;
  /** A child's folder (`<root artifacts>/sub-<id>`), where Prime writes its rlm-subagent.json and session file. */
  sessionDir?: string;
  /** A root's session file, from rlm.create_session. */
  sessionFile?: string;
  /** The spawn's `model` selector (`provider/model`) and `thinking`, when it named them; a root the keeper starts in its place runs on them. */
  model?: string;
  thinking?: ThinkingLevel;
  /** The keeper's last send: when, and the worker of the tree it went to ("" when none ran then). */
  sent?: { at: number; worker: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const ID = /^[\w-]{1,128}$/;
/** A record file's content, parsed at the boundary; null when it is not one. */
export function parseBriefRecord(value: unknown): BriefRecord | null {
  if (!isRecord(value) || (value.kind !== "child" && value.kind !== "root") || typeof value.id !== "string" || !ID.test(value.id)) return null;
  if (typeof value.prompt !== "string" || typeof value.at !== "number" || !Number.isFinite(value.at) || typeof value.root !== "string" || !ID.test(value.root)) return null;
  const sent = isRecord(value.sent) && typeof value.sent.at === "number" && typeof value.sent.worker === "string" ? { sent: { at: value.sent.at, worker: value.sent.worker } } : {};
  return { kind: value.kind, id: value.id, name: typeof value.name === "string" ? value.name : "", prompt: value.prompt, at: value.at, root: value.root,
    ...(typeof value.sessionDir === "string" ? { sessionDir: value.sessionDir } : {}), ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
    ...(typeof value.model === "string" && value.model.includes("/") ? { model: value.model } : {}), ...(isThinkingLevel(value.thinking) ? { thinking: value.thinking } : {}), ...sent };
}

/**
 * What the session of a record shows now: its session id and file once Prime wrote them, whether its brief landed (`started`), whether any
 * prompt landed (`prompted`), and whether its child ended. A child's brief arrives labelled "[task from parent]"; a root's is its first prompt.
 */
export interface BriefSeen { sessionId?: string; file?: string; started: boolean; prompted: boolean; ended: boolean; unborn?: boolean }

const TASK_LABEL = "[task from parent]";
/**
 * Whether a session file holds any prompt and whether one is a child's task. A message from a parent, sibling or check-in can land before
 * the task: from 10-13 to 10-16 07:39Z 11 of 65 children that never got their task had one, "duty prompt button" a check-in at 03:39Z.
 */
async function prompts(file: string): Promise<{ prompted: boolean; task: boolean }> {
  const lines = fileLines(file);
  let prompted = false;
  try {
    for await (const line of lines) {
      const message = line.startsWith('{"type":"custom_message","customType":"agent_message"');
      if (!message && !line.includes('"role":"user"')) continue;
      const entry = JSON.parse(line) as { content?: unknown; message?: { role?: string; content?: unknown } };
      if (!message && entry.message?.role !== "user") continue;
      prompted = true;
      const content = message ? entry.content : entry.message!.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "").join("") : "";
      if (text.startsWith(TASK_LABEL)) return { prompted, task: true };
    }
  } catch { /* unreadable: what was read */ }
  return { prompted, task: false };
}

/** RLM child statuses after which nothing will start the child. */
const ENDED = new Set(["deleted", "cancelled", "error", "failed", "done"]);

/** Reads a record's session: a child's rlm-subagent.json (status, session file) else the one session file in its folder; a root's own file. */
export async function seeBrief(record: BriefRecord): Promise<BriefSeen> {
  let file = record.sessionFile;
  let ended = false;
  let admitted = false;
  if (record.kind === "child" && record.sessionDir) {
    try {
      const spawn: unknown = JSON.parse(await readFile(join(record.sessionDir, "rlm-subagent.json"), "utf8"));
      admitted = true;
      if (isRecord(spawn)) {
        if (typeof spawn.sessionFile === "string") file = spawn.sessionFile;
        ended = typeof spawn.status === "string" && ENDED.has(spawn.status);
      }
    } catch { /* not written yet */ }
    if (!file) {
      const names = await readdir(record.sessionDir).catch(() => [] as string[]);
      const own = names.filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl");
      if (own.length === 1) file = join(record.sessionDir, own[0]!);
    }
  }
  // A child whose folder holds neither rlm-subagent.json nor a session file never became a session: on 10-17 at 21:29:46Z clean-room run 6
  // SIGKILLed the chat's worker 67 ms after rlm.spawn returned, and Prime wrote nothing for the child, not even its ledger line.
  if (!file) return { started: false, prompted: false, ended, ...(record.kind === "child" && !admitted ? { unborn: true } : {}) };
  const sessionId = /([\w-]+)\.jsonl$/.exec(file)?.[1];
  const seen = await prompts(file);
  return { ...(sessionId ? { sessionId } : {}), file, started: record.kind === "child" ? seen.task : seen.prompted, prompted: seen.prompted, ended };
}

/** What the keeper does with one record this tick. */
export type BriefAct = { act: "drop"; why: "started" | "ended" } | { act: "wait" } | { act: "send"; session: string } | { act: "restart" };

/** The live Prime worker of a tree, and whether it ran the session's agent: then the brief is in its hands and only the file is late. */
export interface TreeWorker { id: string; ran: boolean }

/**
 * The rule for one record: drop it once its session holds its brief or its child ended; else wait out BRIEF_LATE_MS from the spawn; then
 * send the brief to its session, once to each worker, unless the tree's live worker ran a session whose file shows no prompt yet (only the
 * file is late). A worker that stops, alone or in a supervisor restart, takes a prompt it held with it, and the next worker has a new id. A
 * session whose file shows another message but not its brief lost the brief. A child Prime never wrote at all is started again as a root job
 * of its chat (`restart`).
 */
export function briefAct(record: BriefRecord, seen: BriefSeen, worker: TreeWorker | undefined, now: number): BriefAct {
  if (seen.started) return { act: "drop", why: "started" };
  if (seen.ended) return { act: "drop", why: "ended" };
  if (now - record.at >= BRIEF_LATE_MS && seen.unborn) return { act: "restart" };
  if (now - record.at < BRIEF_LATE_MS || !seen.sessionId || (worker?.ran && !seen.prompted) || record.sent?.worker === (worker?.id ?? "")) return { act: "wait" };
  return { act: "send", session: seen.sessionId };
}

/** The message that carries a lost brief: the brief as the parent wrote it, then one line on why it comes now. */
export function briefText(record: BriefRecord, now: number): string {
  const head = record.kind === "child" ? "[task from parent]\n\n" : "";
  return `${head}${record.prompt}\n\n(The chat service sent this brief at ${zTime(now)}: Prime started this session at ${zTime(record.at)} ` +
    "and its first prompt never reached it. If this brief already reached you, do it once.)";
}

/**
 * The brief of a child that never became a session, for the root job that takes its place: the brief, then where the job reports, since
 * a root has no parent and reaches its chat as a sibling (chat-brief.ts jobReplyGuideline).
 */
export function restartText(record: BriefRecord, chat: string, now: number): string {
  return `${record.prompt}\n\n(The chat service started this job at ${zTime(now)} in place of "${record.name}", which the chat spawned at ` +
    `${zTime(record.at)}: its worker stopped before Prime wrote the session. You are a root job of the chat ${chat}, so wherever this brief ` +
    `says to send to your parent, send to the chat with agent_message.send(report, receiver_role="sibling", receiver_name="${chat}").)`;
}

const WORKER_FILE = /^[0-9a-f]{12}\.json$/;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** What one recovery journal showed so far: its inode, the bytes read up to the last whole line, and each session's latest agent start. */
interface JournalRead { ino: number; read: number; starts: Map<string, number> }
const AGENT_START = /"operation":\s*"agent_start"/;

/**
 * Brings the read of a worker's recovery journal up to its end with the bytes added since the last call, or from the start when the file
 * shrank or was replaced; null when it cannot be read. The keeper's 30 s tick and every chat's check-in read each late session's journal, and
 * on 10-27 on us-metal02, with 39 late spawn records, a copy of one pass read 78 MB of journals in 5,000 reads every time.
 */
async function readJournal(reads: Map<string, JournalRead>, journal: string): Promise<JournalRead | null> {
  const handle = await open(journal, "r").catch(() => null);
  if (!handle) { reads.delete(journal); return null; }
  try {
    const { ino, size } = await handle.stat();
    let known = reads.get(journal);
    if (!known || known.ino !== ino || size < known.read) reads.set(journal, known = { ino, read: 0, starts: new Map() });
    if (size === known.read) return known;
    const bytes = Buffer.alloc(size - known.read);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, known.read);
    const whole = bytes.subarray(0, bytes.subarray(0, bytesRead).lastIndexOf(10) + 1);
    for (const line of whole.toString("utf8").split("\n")) {
      if (!AGENT_START.test(line)) continue;
      const entry: unknown = (() => { try { return JSON.parse(line); } catch { return null; } })();
      if (!isRecord(entry) || typeof entry.sessionId !== "string" || typeof entry.recordedAt !== "string") continue;
      const at = Date.parse(entry.recordedAt);
      if (at > (known.starts.get(entry.sessionId) ?? -Infinity)) known.starts.set(entry.sessionId, at);
    }
    known.read += whole.length;
    return known;
  } catch { return null; } finally { await handle.close(); }
}

/**
 * The live worker of each tree, from Prime's `<agent dir>/daemon-workers/<daemon>/<worker id>.json` (one per root session; a worker that starts
 * after another stopped gets a new id and journal), and whether its recovery journal shows the session's agent start since the worker began.
 */
export function primeWorkers(workersDir: string): (root: string, session: string) => Promise<TreeWorker | undefined> {
  const journals = new Map<string, JournalRead>();
  return async (root, session) => {
    for (const daemon of await readdir(workersDir).catch(() => [] as string[])) {
      const dir = join(workersDir, daemon);
      for (const name of (await readdir(dir).catch(() => [] as string[])).filter(entry => WORKER_FILE.test(entry))) {
        const worker: unknown = await readFile(join(dir, name), "utf8").then(text => JSON.parse(text), () => null);
        if (!isRecord(worker) || worker.rootSessionId !== root || typeof worker.workerId !== "string" || typeof worker.pid !== "number") continue;
        const journal = typeof worker.recoveryJournalPath === "string" ? worker.recoveryJournalPath : null;
        if (!alive(worker.pid)) { if (journal) journals.delete(journal); continue; }
        const since = typeof worker.createdAt === "string" ? Date.parse(worker.createdAt) : NaN;
        const read = journal && Number.isFinite(since) ? await readJournal(journals, journal) : null;
        return { id: worker.workerId, ran: (read?.starts.get(session) ?? -Infinity) >= since };
      }
    }
    return undefined;
  };
}

/** The model and thinking a record's spawn named (`BriefRecord.model`, `thinking`); undefined when it named no model. */
export function recordModel(record: Pick<BriefRecord, "model" | "thinking">): JobModel | undefined {
  const at = record.model?.indexOf("/") ?? -1;
  if (at <= 0 || at === record.model!.length - 1) return undefined;
  return { provider: record.model!.slice(0, at), modelId: record.model!.slice(at + 1), ...record.thinking ? { thinkingLevel: record.thinking } : {} };
}

export interface BriefDeps {
  dir: string;
  /** Hands the session the text on disk; the outbox starts the tree `root` when the daemon does not find the session (wakes.ts). */
  deliver: (session: string, text: string, root?: string, kind?: AgentKind) => Promise<void>;
  /** The live worker of the tree `root` and whether it ran `session` (`primeWorkers`); undefined when none runs. */
  worker: (root: string, session: string) => Promise<TreeWorker | undefined>;
  /**
   * Starts a root job registered under the chat `record.root` with the brief `restartText` makes (chat-duty-job.ts start), on the spawn's
   * model (`recordModel`); its session id.
   */
  restart?: (record: BriefRecord, text: (chat: string) => string) => Promise<string>;
  log: (line: string) => void;
  now?: () => number;
  see?: (record: BriefRecord) => Promise<BriefSeen>;
}

async function readRecords(dir: string): Promise<{ file: string; record: BriefRecord }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { file: string; record: BriefRecord }[] = [];
  for (const name of names.filter(entry => entry.endsWith(".json"))) {
    const file = join(dir, name);
    const record = await readFile(file, "utf8").then(text => parseBriefRecord(JSON.parse(text)), () => null);
    if (record) out.push({ file, record });
  }
  return out;
}

async function writeRecord(file: string, record: BriefRecord): Promise<void> {
  await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(record), { mode: 0o600 });
  await rename(`${file}.${process.pid}.tmp`, file);
}

/** The tree's worker, read only for a session that is late and has no brief; a failed read counts as no worker. */
async function workerOf(read: BriefDeps["worker"], record: BriefRecord, seen: BriefSeen, now: number): Promise<TreeWorker | undefined> {
  if (seen.started || seen.ended || !seen.sessionId || now - record.at < BRIEF_LATE_MS) return undefined;
  return read(record.root, seen.sessionId).catch(() => undefined);
}

/** One pass over the records. Returns how many briefs went out. */
export async function briefTick(deps: BriefDeps): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const see = deps.see ?? seeBrief;
  let sent = 0;
  for (const { file, record } of await readRecords(deps.dir)) {
    const seen = await see(record);
    const worker = await workerOf(deps.worker, record, seen, now);
    const act = briefAct(record, seen, worker, now);
    const label = `${record.kind} ${record.name || record.id} (${record.id.slice(0, 12)})`;
    if (act.act === "drop") {
      await rm(file, { force: true });
      if (record.sent) deps.log(`briefs: ${label} ${act.why === "started" ? "has its first prompt now" : "ended"}; record dropped`);
      continue;
    }
    if (act.act === "wait") continue;
    if (act.act === "restart") {
      if (!deps.restart) continue;
      try {
        const id = await deps.restart(record, chat => restartText(record, chat, now));
        await rm(file, { force: true });
        sent++;
        deps.log(`briefs: ${label} never became a session ${Math.round((now - record.at) / 60_000)} min after its spawn; started root job ${id} of its chat with its brief`);
      } catch (error) {
        deps.log(`briefs: ${label}: restart: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    try {
      await deps.deliver(act.session, briefText(record, now), record.root, "retry");
      await writeRecord(file, { ...record, sent: { at: now, worker: worker?.id ?? "" } });
      sent++;
      deps.log(`briefs: ${label} had no first prompt ${Math.round((now - record.at) / 60_000)} min after its spawn; sent its brief to ${act.session}`);
    } catch (error) {
      deps.log(`briefs: ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sent;
}

export function startBriefKeeper(deps: BriefDeps, everyMs = BRIEF_TICK_MS): () => void {
  let running = false;
  const beat = () => {
    if (running) return;
    running = true;
    void briefTick(deps).catch(error => deps.log(`briefs: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  };
  beat();
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** A job whose session shows no brief and whose worker never ran it, as the check-in reads it: its fact key, name, spawn time and the keeper's last send. */
export interface Unstarted { key: string; name: string; at: number; sentAt?: number }

/** The recorded jobs whose session file still has no brief BRIEF_LATE_MS after their spawn, unless the tree's live worker ran them and only the file is late. */
export async function unstartedJobs(dir: string, now: number, worker: BriefDeps["worker"], see: (record: BriefRecord) => Promise<BriefSeen> = seeBrief): Promise<Unstarted[]> {
  const out: Unstarted[] = [];
  for (const { record } of await readRecords(dir)) {
    if (now - record.at < BRIEF_LATE_MS) continue;
    const seen = await see(record);
    if (seen.started || seen.ended || ((await workerOf(worker, record, seen, now))?.ran && !seen.prompted)) continue;
    out.push({ key: record.kind === "child" ? record.id : `thread:${record.id}`, name: record.name, at: record.at, ...(record.sent ? { sentAt: record.sent.at } : {}) });
  }
  return out;
}

/** The facts with each job that never got its first prompt read as not started, whatever its RLM status says. */
export function withUnstarted(facts: readonly JobFact[], unstarted: readonly Unstarted[]): JobFact[] {
  if (!unstarted.length) return [...facts];
  const byKey = new Map(unstarted.map(job => [job.key, job] as const));
  return facts.map(fact => {
    const job = byKey.get(fact.key) ?? (fact.sessionId ? byKey.get(`thread:${fact.sessionId}`) : undefined);
    return job ? { ...fact, state: "unstarted", unstarted: { at: job.at, ...(job.sentAt !== undefined ? { sentAt: job.sentAt } : {}) } } : fact;
  });
}
