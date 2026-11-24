/**
 * `GET /api/agents/:id/config`: one agent as a role with its data, read from where each part lives.
 *
 * | Part | Read from |
 * |---|---|
 * | name, model, status, cwd, created | pi-host's thread row (`durable_threads`) and tree (`durable_tree`); `project` is false for the home folder (`projects.ts`) |
 * | purpose | the conversation's first input among its first 20 entries (`durable_entries after 0`): the owner's first message or the brief its parent or a duty sent, never a tagged notice such as an imported `[harness-digest]` |
 * | system text | pi-host's durable Preamble, `PRIME_BASE_PROMPT` in packages/pi-family/preamble.ts of the pi-host that runs |
 * | thread file | `<durable dir>/threads/<thread>.sqlite`, beside pi-host's `index.sqlite` |
 * | board | the `chat.board` document of its chat's root conversation, the last read of it through `Boards.latest` |
 * | duties, check-in | `<data dir>/agents/<agent>/duties.json`, or chat.sqlite's `duties_files` when APPS_CHAT_DB_KINDS names duties (`duties-db.ts`), and each duty's precheck state in `<data dir>/agents/<agent>/duties/` |
 * | folder | its agent's folder, `<agents dir>/<slug>/` with `brief.md` and the harness store's file and entry count (`agent-folder.ts`); `GET /api/agents/:id/folder` gives the entries |
 * | memory | Prime's harness digest in pi-host: Prime's global store merged with the agent's store, or with the thread's own store when no agent holds it |
 * | instructions | AGENTS.md and CLAUDE.md in its cwd and each folder above it, and `<agent dir>/AGENTS.md`, which pi-host loads through Prime's resource loader plus the CLAUDE.md beside each AGENTS.md (`context-files.ts`), read on the box that runs the thread |
 * | usage | the sums over the Usage page's 7 days by hour of its main thread, comm threads and root job threads, from the usage store's kept hour sums (`StoreUsage`) |
 * | wakes | the board.wakes of those threads that have not gone out yet, in `<data dir>/wakes/` or chat.sqlite's `wakes` (`Boards.wakesOn`) |
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentConfig, AgentFolderSummary, AgentId, AgentSummary, AgentWake, ChatBoard, CommMembership, ConfigFile, PlanItem, ThreadKind, UsagePart } from "../web/src/lib/api/types.ts";
import { CHECK_IN_DUTY, type Duty, type DutyRunRecord } from "../web/src/lib/api/shared/chat-duties.ts";
import { fileInfo, instructionFiles } from "./agent-folder.ts";
import { agentScripts } from "./agent-scripts.ts";
import type { AgentRecord } from "./agent-store.ts";
import { NotFound, type App } from "./app.ts";
import { judgedRun } from "../web/src/lib/api/shared/duty-card.ts";
import { awaitingGo, BOARD_DOC, nextRun, type DutyFile } from "./boards.ts";
import { isNoProject } from "./projects.ts";
import type { EntryRecord, Ping } from "./host/types.ts";
import type { UsageTotal } from "./usage-store.ts";
import { ownerText } from "./rooms.ts";
import { conversationIdOf, parseConversationId } from "./threads.ts";
import { bucketStart } from "./usage.ts";
import { BUCKET_MS, RANGE_MS } from "../web/src/lib/api/shared/usage-range.ts";
import { wakeTarget, type Wake } from "./wakes.ts";
import { waiting } from "../web/src/lib/api/shared/snooze.ts";

const PURPOSE_CAP = 1500;
/** Entries read for the purpose: an imported Prime session opens with its harness digest and other tagged notices before the first input. */
const FIRST_INPUT_SCAN = 20;
/** A brief another agent or a duty sent, or an owner message (`ownerText`), not a tagged notice such as `[harness-digest]`. */
const isFirstInput = (entry: EntryRecord): boolean => entry.kind === "agent.message" || ownerText(entry) !== undefined;

/** Prime's agent dir, which pi-host runs with (`--agent-dir`): its harness store, AGENTS.md and skills. */
export function primeAgentDir(app: App): string {
  return app.config.fixture ? join(app.config.dataDir, "prime-agent") : (process.env.PI_HOST_AGENT_DIR ?? join(homedir(), ".prime/agent"));
}

/** Where the pi-host that runs keeps its source, for the preamble it sends; the repo copy is the fallback. */
function preambleFiles(): string[] {
  return [
    join(process.env.PI_HOST_DIR ?? join(homedir(), ".local/share/pi-host/current"), "packages/pi-family/preamble.ts"),
    resolve(import.meta.dirname, "../../../packages/pi-family/preamble.ts"),
  ];
}

/** `PRIME_BASE_PROMPT` as the file writes it: an array of string lines joined with newlines. */
export function readPreamble(files = preambleFiles()): { text: string | null; source: string } {
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const body = /PRIME_BASE_PROMPT\s*=\s*\[([\s\S]*?)\]\.join\("\\n"\)/.exec(source)?.[1];
    if (!body) continue;
    const lines = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => JSON.parse(`"${match[1]}"`) as string);
    return { text: lines.join("\n"), source: `${file} (PRIME_BASE_PROMPT)` };
  }
  return { text: null, source: "packages/pi-family/preamble.ts (PRIME_BASE_PROMPT), not found on this box" };
}

/**
 * The instruction files the thread loads, read on the box that runs it: this box's disk, or that box's agent relay (`instructions` op). A box
 * that is away gives no files and a note that says so.
 */
async function instructionsOn(app: App, thread: string, cwd: string, agentDir: string): Promise<{ cwdExists: boolean; files: ConfigFile[]; away?: string }> {
  const box = app.routing?.boxOf(thread);
  const relay = box && box !== app.config.box ? app.routing?.relay(box) : undefined;
  if (!relay) return { cwdExists: existsSync(cwd), files: instructionFiles(cwd, agentDir) };
  try {
    return await relay.instructions(cwd);
  } catch (error) {
    return { cwdExists: true, files: [], away: `${box} did not answer (${error instanceof Error ? error.message : String(error)}), so its instruction files are not listed now.` };
  }
}

/** Each harness store's memory count and newest titles, by path, kept until the file's size or mtime changes. */
const storeSummaries = new Map<string, { mtimeMs: number; size: number; summary: { count: number; preview: string } | null }>();

/**
 * A harness store with its memory count and newest three memory titles, read as `{entries: {memory, prompt, ...}}`. Prime's global store was
 * 1.5 MB on 11-22 and its parse took 12 to 140 ms at box load 190 to 220, so a store is parsed again only after it changed.
 */
function harnessStore(label: string, path: string, note: string): ConfigFile {
  const info = fileInfo(label, path, { loaded: true, note });
  if (!info.exists) return info;
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    return info;
  }
  let kept = storeSummaries.get(path);
  if (!kept || kept.mtimeMs !== stat.mtimeMs || kept.size !== stat.size) {
    let summary: { count: number; preview: string } | null = null;
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as { entries?: { memory?: Record<string, { title?: string; updated_at?: string }> } };
      const memories = Object.values(state.entries?.memory ?? {});
      summary = {
        count: memories.length,
        preview: memories.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))).slice(0, 3).map(m => `- ${m.title ?? "(untitled)"}`).join("\n"),
      };
    } catch {
      summary = null;
    }
    storeSummaries.set(path, kept = { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  }
  if (kept.summary) Object.assign(info, kept.summary);
  else info.note = `${info.note} The file did not parse.`;
  return info;
}

function walk(plan: readonly PlanItem[], visit: (item: PlanItem) => void): void {
  for (const item of plan) {
    visit(item);
    walk(item.children, visit);
  }
}

function boardSummary(board: ChatBoard): Omit<NonNullable<AgentConfig["board"]>, "chat" | "chatName" | "own"> {
  const count = (items: readonly PlanItem[]) => {
    let open = 0;
    let done = 0;
    walk(items, item => {
      if (item.status === "done") done += 1;
      else if (item.status !== "dropped") open += 1;
    });
    return { open, done };
  };
  const all = count(board.plan);
  return {
    doc: BOARD_DOC, rev: board.rev, updatedAt: board.updatedAt,
    goals: board.plan.map(item => ({ id: item.id, text: item.text, status: item.status, ...count(item.children) })),
    steps: { ...all, total: all.open + all.done }, awaitingGo: awaitingGo(board).length,
    openTodos: board.todos.filter(todo => waiting(todo, Date.now())).map(todo => ({ id: todo.id, text: todo.text, at: todo.at, ...(todo.step ? { step: todo.step } : {}) })),
  };
}

const scheduleText = (duty: Duty): string => (duty.schedule.kind === "daily" ? `daily at ${duty.schedule.at} KST` : `every ${duty.schedule.minutes} min`);

/** The chat whose board, duties and check-in an agent works under: itself for a chat, else the chat its thread or root job belongs to. */
export function homeChat(app: App, id: AgentId): string | null {
  const record = app.agents.record(id) ?? app.agents.record(parseConversationId(id).thread);
  if (record) return record.id;
  let { thread } = parseConversationId(id);
  for (let hops = 0; hops < 8; hops++) {
    const meta = app.threads.meta(thread);
    if (meta.kind === "chat") return app.threads.thread(thread) ? thread : null;
    if (!meta.parent) return null;
    const parent = app.agents.record(meta.parent);
    if (parent) return parent.id;
    thread = parseConversationId(meta.parent).thread;
  }
  return null;
}

/** The agent an agent id, DM room id, or any thread or conversation id of the agent or of a job under it belongs to. */
export function agentRecordOf(app: App, id: string): AgentRecord | undefined {
  const chat = homeChat(app, id);
  return chat ? app.agents.record(chat) : undefined;
}

/**
 * The last answer of `app.host.ping()`, with a new ping started behind each config read. This box's ping lists every thread (durable_threads,
 * 450 KB on 11-22), and in a probe at box load 190 to 220 it took 185 ms at p50 and 1,048 ms at p90 on pi-host's one socket, where every other
 * call of the read waited behind it (~/work/p155-config). Only the first read of a page load's server waits for it.
 */
const pings = new WeakMap<App, { last?: Ping; flight?: Promise<Ping> }>();
function lastPing(app: App): Promise<Ping> {
  let kept = pings.get(app);
  if (!kept) pings.set(app, kept = {});
  const slot = kept;
  slot.flight ??= app.host.ping().catch((error): Ping => ({ ok: false, error: String(error) })).then(answer => {
    slot.last = answer;
    slot.flight = undefined;
    return answer;
  });
  return slot.last ? Promise.resolve(slot.last) : slot.flight;
}

/** A conversation's purpose as kept: its first input, the text cut at `PURPOSE_CAP`, and who sent it by id. */
type FirstInput = { text: string; truncated: boolean; from: string; at: number | undefined; via?: string };

/**
 * Each conversation's first input, kept once found, since entries after it never change it. Its read of the first 20 entries carried 850 KB
 * for agent factory's work thread on 11-22, whose imported Prime session opens with its harness digest, and took 827 ms at p50 at box load
 * 190 to 220 (~/work/p155-config).
 */
const firstInputs = new WeakMap<App, Map<string, FirstInput>>();
async function firstInput(app: App, thread: string, conversation: number): Promise<FirstInput | undefined> {
  let kept = firstInputs.get(app);
  if (!kept) firstInputs.set(app, kept = new Map());
  const key = `${thread}\u0000${conversation}`;
  const known = kept.get(key);
  if (known) return known;
  const first = await app.host.entries(thread, { conversation, after: 0, limit: FIRST_INPUT_SCAN }).then(got => got.entries.find(isFirstInput), () => undefined);
  const message = first?.model?.[0];
  if (!first || !message || (message.role !== "user" && first.kind !== "agent.message")) return undefined;
  const text = (first.kind === "pi.user" ? ownerText(first) : undefined)
    ?? (typeof message.content === "string" ? message.content : message.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n"));
  const data = first.kind === "agent.message" ? (first.data as { from?: string; via?: string } | undefined) : undefined;
  const found: FirstInput = {
    text: text.length > PURPOSE_CAP ? `${text.slice(0, PURPOSE_CAP - 1)}…` : text, truncated: text.length > PURPOSE_CAP,
    from: data?.from ?? "owner", at: message.timestamp, ...(data?.via ? { via: data.via } : {}),
  };
  kept.set(key, found);
  return found;
}

/**
 * The thread's usage over the Usage page's 7 days by hour: the 168 clock hours that end with the one holding now, which fall on the kept
 * hour sums (usage-store.ts `StoreUsage`), so the read calls no store. Null while the store does not answer.
 */
function weekUsage(app: App, threads: readonly string[], now = Date.now()): Promise<UsageTotal[] | null> {
  const until = bucketStart("hour", now) + BUCKET_MS.hour;
  const since = until - RANGE_MS["7d"];
  // Sums the store has not refreshed are unknown here, as an unreachable store's are: this card has no line that says how old they are.
  if (app.usage.staleSince?.() !== undefined) return Promise.resolve(null);
  return app.usage.usage({ since, until, bucketMs: until - since, threads: [...threads] }).catch(() => null);
}

/**
 * Each thread of the agent once, with its kind: its main thread, its comm threads, and the threads of the root jobs filed under it. A job inside
 * a thread runs in that thread's file, so its turns count with the thread that holds it. Until p233 the 7 days counted the main thread alone,
 * which left 12.6% of agent factory's week out (~/work/agent-definition/surface.md).
 */
function threadKinds(agent: AgentSummary, jobs: readonly SwarmJob[]): Map<string, ThreadKind> {
  const kinds = new Map<string, ThreadKind>([[agent.thread, "main"]]);
  for (const comm of agent.comm ?? []) if (!kinds.has(comm.thread)) kinds.set(comm.thread, "comm");
  for (const job of jobs) {
    const { thread } = parseConversationId(job.id);
    if (!kinds.has(thread)) kinds.set(thread, "jobs");
  }
  return kinds;
}

/** The 7 days' sums by kind of thread, each with how many of its threads ran a turn. */
function usageSplit(totals: readonly UsageTotal[], kinds: ReadonlyMap<string, ThreadKind>): Record<ThreadKind, UsagePart> {
  const split: Record<ThreadKind, UsagePart & { ran: Set<string> }> = {
    main: { cost: 0, turns: 0, threads: 0, ran: new Set() }, comm: { cost: 0, turns: 0, threads: 0, ran: new Set() }, jobs: { cost: 0, turns: 0, threads: 0, ran: new Set() },
  };
  for (const total of totals) {
    const part = split[kinds.get(total.thread) ?? "main"];
    part.cost += total.cost;
    part.turns += total.turns;
    if (total.turns > 0) part.ran.add(total.thread);
  }
  const done = ({ cost, turns, ran }: UsagePart & { ran: Set<string> }): UsagePart => ({ cost, turns, threads: ran.size });
  return { main: done(split.main), comm: done(split.comm), jobs: done(split.jobs) };
}

/** A pending wake as the Threads tab lists it, named by the conversation it wakes. */
function agentWake(app: App, wake: Wake, kinds: ReadonlyMap<string, ThreadKind>, agent: AgentSummary, jobs: readonly SwarmJob[]): AgentWake {
  const { thread, conversation } = wakeTarget(wake.session);
  const id = conversationIdOf(thread, conversation);
  const kind = kinds.get(thread) ?? "main";
  const comm = agent.comm?.find(c => c.thread === thread);
  const room = comm ? app.groups.row(comm.room) : undefined;
  const name = id === agent.id || (thread === agent.thread && conversation === 1) ? "Main thread"
    : comm && conversation === 1 ? (comm.room.startsWith("dm_") ? "DM comm thread" : `Comm thread in ${room?.kind === "solo" ? "" : "#"}${room?.name ?? comm.room}`)
    : jobs.find(job => job.id === id)?.name ?? app.threads.tree(thread).find(node => node.id === conversation)?.name ?? id;
  return { id, kind, name, on: wake.on, note: wake.note, since: wake.since };
}

const kindCount = (kinds: ReadonlyMap<string, ThreadKind>, kind: ThreadKind, word: string): string => {
  const n = [...kinds.values()].filter(k => k === kind).length;
  return `${n} ${word}${n === 1 ? "" : "s"}`;
};

/** Whether the agent is a member of a comm thread's room, left it, or got a post there only through an @mention (group-rooms.ts rule 5). */
function commMembership(row: { members: readonly { agent: AgentId }[]; memberLog?: readonly { agent: AgentId; change: string }[] }, member: { id: AgentId } | undefined): CommMembership {
  if (!member || row.members.some(m => m.agent === member.id)) return "member";
  return row.memberLog?.some(change => change.agent === member.id && change.change === "removed") ? "left" : "mentioned";
}

/** Run wakes first, since they wait on CI with no clock, then the soonest. */
const wakeOrder = (a: AgentWake, b: AgentWake): number => (a.on.kind === "run" ? 0 : a.on.at) - (b.on.kind === "run" ? 0 : b.on.at);

type SwarmJob = AgentConfig["swarm"]["jobs"][number];
type DutyJobs = ReadonlyMap<string, unknown>;

/**
 * A row of a registered agent's Jobs tab. A root job thread sits at depth 1 under the agent, or under the job it is filed under; a job inside
 * the work thread sits at its depth there, and a job inside a root job thread one deeper, under that root job.
 */
function agentJob(app: App, job: AgentSummary, agentId: AgentId, workThread: string, dutyJobs: DutyJobs): SwarmJob {
  const base = { id: job.id, name: job.name, status: job.status, createdAt: job.createdAt, archived: job.archived };
  if (job.conversation === 1) {
    const parent = job.parent?.id ?? agentId;
    return { ...base, kind: dutyJobs.has(job.id) ? "duty" : "root job", parent, depth: parent === agentId ? 1 : 2 };
  }
  const nodes = app.threads.tree(job.thread);
  const node = nodes.find(n => n.id === job.conversation);
  const top = nodes.find(n => n.id === 1)?.depth ?? 0;
  const depth = (node?.depth ?? top + 1) - top + (job.thread === workThread ? 0 : 1);
  return { ...base, kind: "job", parent: node?.parent ? conversationIdOf(job.thread, node.parent) : null, depth };
}

/** A job's own swarm: the conversations under it in its thread file, and the root job threads filed under it. */
function jobJobs(app: App, id: AgentId, thread: string, conversation: number, dutyJobs: DutyJobs): SwarmJob[] {
  const nodes = app.threads.tree(thread);
  const below = (conv: number): number[] => nodes.filter(n => n.parent === conv).flatMap(n => [n.id, ...below(n.id)]);
  const children = new Set(below(conversation));
  const jobs: SwarmJob[] = nodes.filter(n => children.has(n.id)).map(n => ({
    id: conversationIdOf(thread, n.id), name: n.name, kind: "job" as const, status: app.threads.statusOfConversation(thread, n.id), createdAt: n.createdAt,
    parent: n.parent === null ? null : conversationIdOf(thread, n.parent), depth: n.depth - (nodes.find(x => x.id === conversation)?.depth ?? 0),
    archived: app.threads.jobArchived(thread, n.id),
  }));
  for (const other of app.threads.threadsList()) {
    const meta = app.threads.meta(other.id);
    if (meta.kind !== "job" || (meta.parent !== id && meta.parent !== thread) || other.id === thread) continue;
    jobs.push({
      id: other.id, name: other.name || "Untitled", kind: dutyJobs.has(other.id) ? "duty" : "root job", status: app.threads.statusOfConversation(other.id, 1),
      createdAt: other.createdAt, parent: id, depth: 1, archived: other.archived,
    });
  }
  return jobs;
}

export async function agentConfig(app: App, id: AgentId): Promise<AgentConfig> {
  let agent = app.threads.agent(id);
  if (!agent) {
    await app.threads.refresh().catch(() => undefined);
    agent = app.threads.agent(id);
  }
  if (!agent) throw new NotFound(`No agent ${id}.`);
  const { thread, conversation } = agent;
  const row = app.threads.thread(thread)!;
  const agentDir = primeAgentDir(app);
  const chat = homeChat(app, agent.id);
  const dutiesPath = chat ? app.boards.dutiesPath(chat) : null;
  const dutyFile: DutyFile | null = chat ? app.boards.dutyFile(chat) : null;

  // Which duty run started each root job, from the run records' `job`.
  const dutyJobs = new Map<string, { chat: string; id: string; name: string }>();
  if (chat && dutyFile) {
    for (const [dutyId, runs] of Object.entries(dutyFile.runs ?? {})) {
      // The check-in's runs sit beside the duties' as the built-in duty `checkin` (`Boards.checkInRun`), so its jobs read as duty jobs too.
      const duty = dutyId === CHECK_IN_DUTY.id ? CHECK_IN_DUTY : dutyFile.duties.find(d => d.id === dutyId);
      for (const run of runs as DutyRunRecord[]) if (run.job) dutyJobs.set(run.job.id, { chat, id: dutyId, name: duty?.name ?? dutyId });
    }
  }

  // Its swarm. A registered agent's jobs are its rows of GET /api/jobs (`jobsOf`), so the Jobs list, the profile card and the Agents card count
  // the same jobs; on 11-23 this list missed the jobs inside root job threads, and agent factory's tab showed 466 where /api/jobs had 529.
  // A job's own swarm is the conversations under it in its thread file, and the root jobs filed under it.
  const jobs: AgentConfig["swarm"]["jobs"] = app.threads.registered(agent.id)?.id === agent.id
    ? app.threads.jobsOf(agent.id).map(job => agentJob(app, job, agent.id, thread, dutyJobs))
    : jobJobs(app, agent.id, thread, conversation, dutyJobs);
  jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const kinds = threadKinds(agent, jobs);

  const [first, ping, usage, board, instructions] = await Promise.all([
    firstInput(app, thread, conversation),
    lastPing(app),
    weekUsage(app, [...kinds.keys()]),
    chat ? app.boards.latest(chat).catch(() => null) : Promise.resolve(null),
    instructionsOn(app, thread, row.cwd, agentDir),
  ]);

  let purpose: AgentConfig["identity"]["purpose"] = null;
  if (first) {
    const from = app.threads.principal(first.from);
    purpose = { text: first.text, truncated: first.truncated, from: { id: from.id, name: from.name }, at: first.at ?? agent.createdAt, ...(first.via ? { via: first.via } : {}) };
  }

  const durableDir = !app.config.fixture && app.config.durableIndex ? dirname(app.config.durableIndex) : null;
  const threadFile = durableDir ? fileInfo("pi-durable thread file", join(durableDir, "threads", `${thread}.sqlite`), { note: "Its transcript, every job conversation and its documents, such as chat.board." }) : null;

  const isChatRoot = agent.kind === "chat" && conversation === 1;
  const duties: AgentConfig["swarm"]["duties"] = isChatRoot && dutyFile ? dutyFile.duties.map(duty => {
    const runs = [...(dutyFile.runs?.[duty.id] ?? [])].sort((a, b) => b.at - a.at);
    return {
      id: duty.id, name: duty.name, goal: duty.goal, schedule: scheduleText(duty), paused: duty.status === "paused",
      nextAt: duty.status === "paused" ? null : nextRun(duty.schedule, duty.lastRunAt ?? duty.createdAt), lastVerdict: runs[0] ? judgedRun(runs[0], duty.metrics).verdict : null, lastAt: runs[0]?.at ?? null,
      runs: duty.runCount ?? runs.length,
    };
  }) : [];
  const checkIn = isChatRoot && dutyFile?.checkIn ? (() => {
    const view = app.boards.checkIn(thread);
    return { everyMs: view.everyMs, paused: view.paused, nextAt: view.nextAt, lastAt: view.lastAt };
  })() : null;

  const record = chat ? app.agents.record(chat) : undefined;
  const read = record ? await app.folders.read(record).catch(() => null) : null;
  let folder: AgentFolderSummary | null = null;
  if (read) {
    const { entries, ...memory } = read.memory;
    folder = { ...read, memory: { ...memory, count: entries.length } };
  }
  const box = app.routing?.boxOf(thread);
  const scripts = box && box !== app.config.box && app.routing?.relay(box) ? null
    : agentScripts({ folderDir: read?.dir ?? null, brief: read?.brief.text ?? "", cwd: row.cwd, home: app.config.home, duties: dutyFile?.duties ?? [] });

  // Data that outlives a turn: Prime's global store, which pi-host's digest merges into every thread, and the thread's own store when no agent
  // holds it.
  const related: ConfigFile[] = [harnessStore("Memory every agent shares", join(agentDir, "harness", "harness_state.json"),
    "Prime's global store. Every thread of every agent, and every Prime chat, gets it in its harness digest beside its own memory. A thread writes it with rlm.harness and global_=True.")];
  if (!record && durableDir) {
    const session = conversation === 1 ? thread : `${thread}-${conversation}`;
    related.push(harnessStore("its own harness store", join(durableDir, "session-artifacts", session, "harness", "harness_state.json"),
      "No agent holds this thread, so its local store is its own, by Prime's rule for a session; its kernel's rlm.harness writes here."));
  }
  // Each duty's precheck state, which the Duties tab lists beside the duties file.
  const dutyStates: ConfigFile[] = [];
  if (chat && isChatRoot) {
    const stateDir = join(app.boards.dir(chat), "duties");
    let names: string[] = [];
    try {
      names = readdirSync(stateDir).filter(name => name.endsWith(".state.json")).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      dutyStates.push(fileInfo(`duty ${name.replace(".state.json", "")} precheck state`, join(stateDir, name), {
        preview: true, loaded: false, note: "What the duty's last precheck saw; the precheck reads it, the agent does not.",
      }));
    }
  }

  const totals = usage ?? [];
  const parentName = agent.parent?.name ?? null;
  return {
    agent,
    identity: {
      purpose,
      system: readPreamble(),
      duty: dutyJobs.get(thread) && conversation === 1 ? dutyJobs.get(thread)! : null,
      wakeAt: conversation === 1 ? (row.wakeAt ?? null) : null,
    },
    runs: {
      host: record && app.routing?.has(record.host) ? record.host : app.config.box, hostKind: app.host.name, hostVersion: ping.ok ? ping.version : null, socket: app.config.socket, cwd: row.cwd, cwdExists: instructions.cwdExists,
      project: !isNoProject(row.cwd, app.config.home), canMove: conversation === 1, thread, conversation, threadFile, dataDir: app.store.dir,
    },
    board: chat && board ? { chat, chatName: app.boards.nameOf(chat), own: chat === agent.id, ...boardSummary(board) } : null,
    folder,
    memory: record ? {
      kind: "agent",
      note: `Its memory is the harness store in its agent's folder, which ${record.name}'s work thread, its jobs and every root job filed under it share. `
        + "pi-host gives each of them Prime's harness digest of Prime's global store merged with this one, and their kernels' rlm.harness and refine.run() write it.",
      related,
    } : {
      kind: "none",
      note: "No agent holds this thread, so its memory is Prime's harness digest of the global store merged with its own store, both listed here.",
      related,
    },
    instructions: {
      files: instructions.files,
      note: "Every thread puts these files in its prompt, global ones first, then each folder down to its cwd. An edit shows in its next request."
        + (instructions.away ? ` ${instructions.away}` : ""),
    },
    scripts,
    swarm: {
      parent: agent.parent ?? null, jobs,
      rooms: (() => {
        const member = app.threads.registered(id) ?? app.agents.ofComm(id)?.record;
        return member ? app.groups.memberRooms(member.id).map(row => ({
          id: row.id, kind: row.kind, name: row.name, wakeOn: row.members.find(m => m.agent === member.id)?.wakeOn ?? "all",
        })) : [];
      })(),
      commRooms: (agent.comm ?? []).map(({ room }) => {
        const row = app.groups.row(room);
        if (row) return { id: room, kind: row.kind, name: row.name, archived: !!row.archived, membership: commMembership(row, app.threads.registered(id) ?? app.agents.ofComm(id)?.record) };
        return room.startsWith("dm_")
          ? { id: room, kind: "dm" as const, name: "DM", archived: false, membership: "member" as const }
          : { id: room, kind: "channel" as const, name: room, archived: false, membership: "mentioned" as const };
      }),
      duties, checkIn,
      dutiesOf: !isChatRoot && chat ? { id: chat, name: app.boards.nameOf(chat) } : null,
      dutiesFile: isChatRoot && dutiesPath
        ? fileInfo("duties, runs and check-in", dutiesPath, app.config.dbKinds?.includes("duties") ? { note: "Kept in chat.sqlite's duties_files; this file is its JSON export for a week after the move." } : {})
        : null,
      dutyStates,
      wakes: app.boards.wakesOn(new Set(kinds.keys())).map(wake => agentWake(app, wake, kinds, agent, jobs)).sort(wakeOrder),
    },
    usage: usage === null ? null : {
      days: 7, turns: totals.reduce((sum, t) => sum + t.turns, 0), cost: totals.reduce((sum, t) => sum + t.cost, 0),
      tokens: {
        input: totals.reduce((sum, t) => sum + t.input, 0), output: totals.reduce((sum, t) => sum + t.output, 0),
        cacheRead: totals.reduce((sum, t) => sum + t.cacheRead, 0), cacheWrite: totals.reduce((sum, t) => sum + t.cacheWrite, 0),
      },
      scope: conversation === 1
        ? `its main thread with the jobs inside it, ${kindCount(kinds, "comm", "comm thread")} and ${kindCount(kinds, "jobs", "root job thread")}`
        : `thread ${thread}, which ${parentName ?? "its chat"} and its jobs share`,
      split: usageSplit(totals, kinds),
    },
  };
}
