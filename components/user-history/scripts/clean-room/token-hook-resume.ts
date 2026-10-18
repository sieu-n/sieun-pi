import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the continue after a token hook failure (resume_paused.py, src/unloaded.ts). In the 10-16 to 10-17 hook outage
 * the idle unload stopped 16 root jobs right after their last turn failed on the pi-pool token hook, the resume pass read the stop's archive
 * as a stop on purpose, and none got a continue once the hook worked again. A fresh chat gets one ordinary task for a job. `clean-room.ts
 * kill-hooks` SIGKILLs every pi-pool-token run of the chat's create_session root jobs, for a window from its first kill, so their turns fail
 * the way the 16 roots' did while the chat keeps its token. A subagent's hook names its chat's worker, so a subagent fails and recovers with
 * its chat, which steered it back first in runs 5 to 7 (10-18); only a root shows whether the resume pass brings a job back. The run passes when the job's turn ends on the hook failure, the job gets
 * a continue from the service after the window with nobody stepping in, the chat answers, and the job the unload stops
 * after it finished gets no continue. The criteria live in the run folder's
 * criteria.md.
 */
export const TASK = "start a separate thread for this: go through every .ts file under components/user-history/src, write one plain sentence on what each exported function over 80 lines does, put the list in a file, and tell me the ten longest";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const ARTIFACTS = join(HOME, ".prime/agent/session-artifacts");
const SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
const HOOK_ERROR = /from shell command: \S*pi-pool-token|token hook gave no token/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Check { id: string; ok: boolean | null; detail: string }
/** One hook run `kill-hooks` stopped. */
export interface HookKill { at: number; pid: number; session: string }

/**
 * The short ids the hook names the jobs by: Prime sets the hook's session variable to the active id, the last 12 characters of the session id
 * (pi-pool.log hook_no_token rows, 10-18), or a new one once the daemon reloads the session, read from `prime-agent list`, with the pids of
 * the workers that run those sessions, which start their hooks.
 */
function activeIds(jobs: ReadonlySet<string>): { ids: Set<string>; workers: Set<number> } {
  const ids = new Set([...jobs].map(id => id.slice(-12)));
  const workers = new Set<number>();
  try {
    const rows = (JSON.parse(execFileSync("prime-agent", ["list", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })) as { sessions: { sessionId?: string; activeSessionId?: string; workerPid?: number }[] }).sessions;
    for (const row of rows) {
      if (!row.sessionId || !jobs.has(row.sessionId)) continue;
      if (row.activeSessionId) { ids.add(row.activeSessionId); ids.add(row.activeSessionId.slice(-12)); }
      if (typeof row.workerPid === "number" && row.workerPid > 0) workers.add(row.workerPid);
    }
  } catch { /* the suffix still matches */ }
  return { ids, workers };
}
/**
 * The chat's create_session root jobs, by the names the chat service files in chat-jobs.json, with their session ids from `prime-agent list`.
 * Each root runs on its own worker, so its hook names it and not the chat: the 16 jobs the 10-16 to 10-17 outage left dead were all such roots.
 */
function rootJobs(chat: string): { id: string; name: string }[] {
  try {
    const registry = JSON.parse(readFileSync(join(DATA, "chat-jobs.json"), "utf8")) as { jobs?: Record<string, { chatId?: string }> };
    const names = new Set(Object.entries(registry.jobs ?? {}).filter(([, entry]) => entry.chatId === chat).map(([name]) => name));
    if (!names.size) return [];
    const rows = (JSON.parse(execFileSync("prime-agent", ["list", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })) as { sessions: { sessionId?: string; sessionName?: string; runtimeKind?: string }[] }).sessions;
    return rows.flatMap(row => row.sessionId && row.sessionName && names.has(row.sessionName) && row.runtimeKind !== "subagent" ? [{ id: row.sessionId, name: row.sessionName }] : []);
  } catch { return []; }
}
/** The pids of the chat services on this box, which run a hook check for a tree; empty off Linux. */
function chatServices(): Set<number> {
  if (process.platform !== "linux") return new Set();
  return new Set(readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { return /chat-service-cli\.mjs\0serve\0/.test(readFileSync(`/proc/${name}/cmdline`, "utf8")) ? [Number(name)] : []; } catch { return []; }
  }));
}
/** The children, grandchildren and great-grandchildren of `parents` on Linux, from each thread's /proc children list. */
export function descendants(parents: ReadonlySet<number>, depth = 3): number[] {
  const found: number[] = [];
  let level = [...parents];
  for (let step = 0; step < depth && level.length; step++) {
    level = level.flatMap(pid => {
      try {
        return readdirSync(`/proc/${pid}/task`).flatMap(tid => {
          try { return readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").split(" ").filter(Boolean).map(Number); } catch { return []; }
        });
      } catch { return []; }
    });
    found.push(...level);
  }
  return found;
}
/** The session each running pi-pool-token under `parents` serves, from its environment; on Linux only the parents' descendants are read. */
function hookRuns(parents: ReadonlySet<number>): { pid: number; session: string }[] {
  return process.platform === "linux" ? linuxHookRuns(parents) : macHookRuns();
}
/**
 * On Linux, each process under `parents` whose argv runs pi-pool-token itself, and its session variable. Only the parents' process trees are
 * read: on 10-18 a run that read every /proc entry each 20 ms held 0.5 of a core for its whole 40-minute window on us-metal02.
 */
export function linuxHookRuns(parents: ReadonlySet<number>): { pid: number; session: string }[] {
  return descendants(parents).flatMap(pid => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const at = argv.findIndex(arg => arg.endsWith("pi-pool/bin/pi-pool-token"));
      if (at < 0 || at > 2 || argv.includes("--cli") || !/(?:^|\/)(?:sh|bash|zsh|python3?(?:\.\d+)?|pi-pool-token)$/.test(argv[0] ?? "")) return [];
      const session = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find(entry => entry.startsWith(`${SESSION_ENV}=`))?.slice(SESSION_ENV.length + 1);
      return session ? [{ pid, session }] : [];
    } catch { return []; }
  });
}
function macHookRuns(): { pid: number; session: string }[] {
  let out: string;
  try { out = execFileSync("ps", ["-E", "-ww", "-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); } catch { return []; }
  // Only the hook itself, as Prime starts it through a shell or as its Python run: a job's bash line that names the hook is left alone.
  const hook = /^\s*\d+\s+(?:\S*\/)?(?:sh|bash|zsh|python3?)(?:\s+-[A-Za-z]+)*\s+\S*pi-pool\/bin\/pi-pool-token(?:\s+--provider\s+\S+)?\s+\S+=/i;
  return out.split("\n").filter(line => hook.test(line)).flatMap(line => {
    const session = new RegExp(`${SESSION_ENV}=(\\S+)`).exec(line)?.[1];
    const pid = Number(line.trim().split(/\s+/)[0]);
    return session && pid > 0 ? [{ pid, session }] : [];
  });
}

/**
 * Polls from setup until `until` and, once the run's chat has a job, SIGKILLs each pi-pool-token run of the chat's tree for `windowMs` from
 * the first kill, the chat service's hook check for the tree included. Kills no other tree's hook.
 * Each kill is appended to kills.jsonl in the run folder, and the window to hook-window.json.
 */
export async function killHooks(run: string, until: number, windowMs: number): Promise<HookKill[]> {
  const kills: HookKill[] = [];
  let first: number | undefined;
  let jobs = new Set<string>();
  let active = new Set<string>();
  let parents = new Set<number>();
  let looked = 0;
  while (Date.now() < until && (first === undefined || Date.now() < first + windowMs)) {
    const stateFile = join(run, "run.json");
    const chat = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as RunState).chat.id : undefined;
    if (chat && Date.now() - looked > 5000) {
      looked = Date.now();
      // Only the chat's root jobs: the chat keeps its token, as the chats of the 16 dead roots did, so nothing above a root steers it back.
      const roots = rootJobs(chat);
      if (roots.length) writeFileSync(join(run, "roots.json"), JSON.stringify(roots, null, 1));
      jobs = new Set(roots.map(root => root.id));
      const tree = jobs.size ? activeIds(jobs) : { ids: new Set<string>(), workers: new Set<number>() };
      active = tree.ids;
      parents = new Set([...tree.workers, ...active.size ? chatServices() : []]);
    }
    for (const hook of active.size ? hookRuns(parents) : []) {
      if (!active.has(hook.session) && !jobs.has(hook.session)) continue;
      try { process.kill(hook.pid, "SIGKILL"); } catch { continue; }
      const kill = { at: Date.now(), pid: hook.pid, session: hook.session };
      first ??= kill.at;
      kills.push(kill);
      appendFileSync(join(run, "kills.jsonl"), JSON.stringify(kill) + "\n");
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  writeFileSync(join(run, "hook-window.json"), JSON.stringify({ from: first ?? null, to: first === undefined ? null : Math.min(Date.now(), first + windowMs), kills: kills.length }, null, 1));
  return kills;
}

/** A job's messages as role, stop reason, error and text, in order. */
function messagesOf(file: string): { at: number; role: string; stop?: string; error?: string; text: string }[] {
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    try {
      const entry = JSON.parse(line) as { type?: string; timestamp?: string; customType?: string; content?: unknown; message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } };
      if (entry.type === "custom_message" && entry.customType === "agent_message") {
        return [{ at: Date.parse(entry.timestamp ?? ""), role: "agent", text: typeof entry.content === "string" ? entry.content : "" }];
      }
      if (entry.type !== "message" || !entry.message?.role) return [];
      const content = entry.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(block => (block as { text?: string }).text ?? "").join("") : "";
      return [{ at: Date.parse(entry.timestamp ?? ""), role: entry.message.role, ...(entry.message.stopReason ? { stop: entry.message.stopReason } : {}),
        ...(entry.message.errorMessage ? { error: entry.message.errorMessage } : {}), text }];
    } catch { return []; }
  });
}

export const tokenHookResume: Scenario = {
  name: "token-hook-resume",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "`clean-room.ts kill-hooks`, started before setup, SIGKILLs every pi-pool-token run of the chat's jobs for a window from its first kill and logs each kill to kills.jsonl.", "",
    "## The message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const checks: Check[] = [];
  const window = existsSync(join(run, "hook-window.json")) ? JSON.parse(readFileSync(join(run, "hook-window.json"), "utf8")) as { from: number | null; to: number | null; kills: number } : null;
  const killed = existsSync(join(run, "kills.jsonl")) ? readFileSync(join(run, "kills.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as HookKill) : [];
  const roots = existsSync(join(run, "roots.json")) ? JSON.parse(readFileSync(join(run, "roots.json"), "utf8")) as { id: string; name: string }[] : [];
  const files = roots.map(root => join(HOME, ".prime/agent/sessions", `${root.id}.jsonl`)).filter(existsSync);
  const jobs = files.map(file => {
    const id = file.split("/").at(-1)!.replace(/\.jsonl$/, "");
    const messages = messagesOf(file);
    const failed = messages.findIndex((message, index) => message.role === "assistant" && message.stop === "error" && HOOK_ERROR.test(message.error ?? "") &&
      messages[index + 1]?.role !== "assistant");
    // The first input after the window: the service's "continue", or a message from inside the chat's tree (criterion e catches any other).
    const resumedAt = failed < 0 ? -1 : messages.findIndex((message, index) => index > failed && (window?.to ?? Infinity) <= message.at &&
      ((message.role === "user" && /^continue\b/.test(message.text.trim())) || message.role === "agent"));
    const answered = resumedAt < 0 ? undefined : messages.slice(resumedAt + 1).find(message => message.role === "assistant" && message.stop !== "error");
    return { id, file, messages, failed: failed < 0 ? undefined : messages[failed], resumed: resumedAt < 0 ? undefined : messages[resumedAt], answered,
      reported: readSessionFile(file).some(event => event.kind === "call" && /receiver_role\s*=\s*\\?['"]parent/.test(event.input)) };
  });
  const hit = jobs.find(job => job.failed);
  checks.push({ id: "a", ok: hit ? true : window?.to && Date.now() > window.to ? false : null,
    detail: `${killed.length} hook runs of ${new Set(killed.map(kill => kill.session)).size} jobs killed, window ${window?.from ? iso(window.from) : "not started"} to ${window?.to ? iso(window.to) : "open"}; ` +
      (hit ? `job ${hit.id} ended its turn at ${iso(hit.failed!.at)}: "${clip(hit.failed!.error ?? "", 200)}"` : "no job turn ended on the hook failure yet") });

  const unloaded = (() => { try { return JSON.parse(readFileSync(join(DATA, "unloaded.json"), "utf8")) as Record<string, string>; } catch { return {}; } })();
  const stoppedAt = hit && unloaded[hit.id] ? Date.parse(unloaded[hit.id]!) : undefined;
  const service = existsSync(join(DATA, "service.log")) ? readFileSync(join(DATA, "service.log"), "utf8").split("\n") : [];
  const name = hit ? roots.find(root => root.id === hit.id)?.name ?? "" : "";
  const continueLine = name ? service.find(line => line.startsWith(`job ${name}: interrupted (error at `) && line.includes("continue:")) : undefined;
  // The fix's path: the idle unload stopped the job between its failed turn and its first input after the window, and that input is the
  // resume pass's continue (its service.log line). Any other input after such a stop fails the run.
  const stops = hit ? service.flatMap(line => {
    const match = /^(\S+Z) idle unload: stopped [^:]*: (.*)$/.exec(line);
    return match && match[2]!.split(", ").includes(name) ? [Date.parse(match[1]!)] : [];
  }).concat(stoppedAt !== undefined ? [stoppedAt] : []).filter(at => at >= hit.failed!.at && at <= (hit.resumed?.at ?? Infinity)) : [];
  const stop = stops.length ? Math.min(...stops) : undefined;
  const byPass = Boolean(stop !== undefined && continueLine && hit?.resumed?.role === "user");
  checks.push({ id: "b", ok: !hit?.resumed ? null : byPass,
    detail: !hit ? "no failed job" : stop === undefined ? `the idle unload did not stop job ${hit.id} before ${hit.resumed ? "its resume" : "now"}` :
      `the idle unload stopped job ${hit.id} at ${iso(stop)}, ${Math.round((stop - hit.failed!.at) / 1000)} s after its first failed turn; ` +
      (!hit.resumed ? "no input since" : byPass ? `the resume pass sent its continue (service.log: "${clip(continueLine!, 200)}")` :
        `its first input came from ${hit.resumed.role === "agent" ? "the chat's tree" : "a continue with no resume pass line"}, not the resume pass`) });


  checks.push({ id: "c", ok: hit ? (hit.resumed && hit.answered ? true : null) : null,
    detail: hit?.resumed ? `${hit.resumed.role === "agent" ? `a message from the chat's tree at ${iso(hit.resumed.at)}: "${clip(hit.resumed.text, 120)}"` : `the service's continue at ${iso(hit.resumed.at)}`}${continueLine ? ` (service.log: "${clip(continueLine, 200)}")` : ""}; ` +
      (hit.answered ? `the model answered at ${iso(hit.answered.at)}: "${clip(hit.answered.text, 160)}"` : "no model answer after it yet") : "no input after the window yet" });

  const events = readSession(chat);
  const answer = events.filter((event): event is Extract<SessionEvent, { kind: "assistant" }> => event.kind === "assistant" && /\d/.test(event.text) && (hit?.answered?.at ?? Infinity) <= event.at).at(-1);
  checks.push({ id: "d", ok: hit?.reported && answer ? true : null,
    detail: `job reported to the chat: ${hit?.reported ? "yes" : "not yet"}; the chat's answer after the resumed turn: ${answer ? `${iso(answer.at)} "${clip(answer.text, 300)}"` : "none yet"}` });

  // A job the unload stopped after a turn that ended well keeps its stop: no continue reaches it after that stop.
  const finished = jobs.flatMap(job => {
    const stopped = unloaded[job.id] ? Date.parse(unloaded[job.id]!) : undefined;
    const before = stopped === undefined ? undefined : job.messages.filter(message => message.at <= stopped).at(-1);
    if (!before || before.role !== "assistant" || before.stop !== "stop") return [];
    const after = job.messages.filter(message => message.at > stopped! && message.role === "user" && /^continue\b/.test(message.text.trim()));
    return [{ id: job.id, stopped: stopped!, after }];
  });
  const lastSweep = Math.max(0, ...finished.map(job => job.stopped)) + 11 * 60_000;
  // A chat that deletes each job once it reports leaves the unload no finished job to stop; test_resume_paused.py covers that case instead.
  const unexercised = !finished.length && hit?.answered !== undefined && Date.now() >= hit.answered.at + 15 * 60_000;
  checks.push({ id: "f", ok: finished.some(job => job.after.length) ? false : (finished.length && Date.now() >= lastSweep) || unexercised ? true : null,
    detail: unexercised ? "not exercised: the unload stopped no finished job in the 15 min after the resumed turn" : finished.length ? finished.map(job => `job ${job.id} finished, the unload stopped it at ${iso(job.stopped)}, ${job.after.length} continues after it`).join("; ") +
      (Date.now() < lastSweep ? `; waits for one resume pass after ${iso(lastSweep - 11 * 60_000)}` : "") : "no job has finished and been stopped by the unload yet" });

  // The chat's check-in duty jobs run on the server's clock and are part of the system, not someone stepping in.
  const runsFile = join(run, "runs.jsonl");
  const duty = (existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(line => line.trim()) : [])
    .flatMap(line => { const job = (JSON.parse(line) as { job?: { id?: string } }).job; return job?.id ? [job.id] : []; });
  const tree = new Set([chat, ...jobs.map(job => job.id), ...duty]);
  const seeds = new Set(state.seeds);
  const owner = events.filter(event => event.kind === "text" && event.role === "user" && event.at >= state.windowStart && !seeds.has(event.text.trim()) && !event.text.startsWith("[")).map(event => event.kind === "text" ? event.text : "");
  const outside = [chat, ...jobs.map(job => job.id)].flatMap(id => (id === chat ? events : readSessionFile(jobs.find(job => job.id === id)!.file))
    .filter(event => event.kind === "text" && event.customType === "agent_message" && event.fromId !== undefined && !tree.has(event.fromId)).map(event => `${event.kind === "text" ? event.from : ""} to ${id}`));
  checks.push({ id: "e", ok: owner.length === 0 && outside.length === 0,
    detail: `${owner.length} user messages beyond the seed${owner.length ? `: ${owner.map(text => clip(text, 120)).join("; ")}` : ""}; ${outside.length} agent messages from outside the chat's tree${outside.length ? `: ${outside.join("; ")}` : ""}` });

  const verdict: Verdict = checks.some(check => check.id === "e" && check.ok === false) ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.every(check => check.ok === true) ? "pass" : "open";
  const text = [`# token-hook-resume ${verdict}: ${state.chat.name}`, "", `Chat ${chat} on ${state.release}, judged ${iso(Date.now())}.`, "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), ""].join("\n");
  return { verdict, text };
}

