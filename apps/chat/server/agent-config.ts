/**
 * `GET /api/agents/:id/config`: one agent as a role with its data, read from where each part lives.
 *
 * | Part | Read from |
 * |---|---|
 * | name, model, status, cwd, created | pi-host's thread row (`durable_threads`) and tree (`durable_tree`); `project` is false for the home folder (`projects.ts`) |
 * | purpose | the conversation's first entry (`durable_entries after 0`): the owner's first message or the brief its parent or a duty sent |
 * | system text | pi-host's durable Preamble, `PRIME_BASE_PROMPT` in packages/pi-family/preamble.ts of the pi-host that runs |
 * | thread file | `<durable dir>/threads/<thread>.sqlite`, beside pi-host's `index.sqlite` |
 * | board | the `chat.board` document of its chat's root conversation, through `Boards` |
 * | duties, check-in | `<data dir>/boards/<chat>/duties.json`, and each duty's precheck state in `<data dir>/boards/<chat>/duties/` |
 * | memory | none of its own: pi-host's durable registry installs only the Preamble, coding tools and subagent (packages/pi-host/src/durable/registry.ts) |
 * | instructions | AGENTS.md and CLAUDE.md in its cwd and each folder above it, and `<agent dir>/AGENTS.md`; pi-durable loads none of them |
 * | usage | pi-host's `durable_usage` sums for the thread over the last 7 days |
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentConfig, AgentId, ChatBoard, ConfigFile, PlanItem } from "../web/src/lib/api/types.ts";
import type { Duty, DutyRunRecord } from "../web/src/lib/api/shared/chat-duties.ts";
import { NotFound, type App } from "./app.ts";
import { judgedRun } from "../web/src/lib/api/shared/duty-card.ts";
import { awaitingGo, BOARD_DOC, nextRun, type DutyFile } from "./boards.ts";
import { isNoProject } from "./projects.ts";
import { readJson } from "./store.ts";
import { conversationIdOf, parseConversationId } from "./threads.ts";

const DAY = 86_400_000;
const PURPOSE_CAP = 1500;
const PREVIEW_CAP = 400;

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

export function fileInfo(label: string, path: string, opts: { preview?: boolean; loaded?: boolean; note?: string } = {}): ConfigFile {
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(path);
  } catch {
    stat = undefined;
  }
  const out: ConfigFile = { label, path, exists: !!stat, size: stat?.isFile() ? stat.size : null, modifiedAt: stat ? stat.mtimeMs : null };
  if (opts.preview && stat?.isFile()) {
    try {
      const head = readFileSync(path, "utf8").slice(0, 4000).split("\n").filter(line => line.trim()).slice(0, 6).join("\n");
      out.preview = head.length > PREVIEW_CAP ? `${head.slice(0, PREVIEW_CAP - 1)}…` : head;
    } catch {
      // A file that cannot be read keeps its size and no preview.
    }
  }
  if (opts.loaded !== undefined) out.loaded = opts.loaded;
  if (opts.note) out.note = opts.note;
  return out;
}

/** AGENTS.md and CLAUDE.md in `cwd` and each folder above it, nearest first, then the agent dir's global AGENTS.md. */
export function instructionFiles(cwd: string, agentDir: string): ConfigFile[] {
  const out: ConfigFile[] = [];
  let dir = resolve(cwd || "/");
  for (;;) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(dir, name);
      if (existsSync(path)) out.push(fileInfo(dir === resolve(cwd) ? `${name} in its cwd` : `${name} above its cwd`, path, { preview: true, loaded: false }));
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const global = join(agentDir, "AGENTS.md");
  if (existsSync(global)) out.push(fileInfo("Prime's global AGENTS.md", global, { preview: true, loaded: false }));
  return out;
}

/** The continual harness store Prime and pi-rlm sessions read: `{entries: {memory, prompt, ...}}`, newest memories first. */
function harnessStore(agentDir: string): ConfigFile {
  const path = join(agentDir, "harness", "harness_state.json");
  const info = fileInfo("Prime's continual harness (global)", path, {
    loaded: false,
    note: "Prime and pi-rlm sessions read and write these memories through their Python kernel; a pi-host durable thread has no kernel and never sees them.",
  });
  if (!info.exists) return info;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { entries?: { memory?: Record<string, { title?: string; updated_at?: string }> } };
    const memories = Object.values(state.entries?.memory ?? {});
    info.count = memories.length;
    info.preview = memories.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))).slice(0, 3).map(m => `- ${m.title ?? "(untitled)"}`).join("\n");
  } catch {
    info.note = `${info.note} The file did not parse.`;
  }
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
    openTodos: board.todos.filter(todo => !todo.done).map(todo => ({ id: todo.id, text: todo.text, at: todo.at, ...(todo.step ? { step: todo.step } : {}) })),
  };
}

const scheduleText = (duty: Duty): string => (duty.schedule.kind === "daily" ? `daily at ${duty.schedule.at} KST` : `every ${duty.schedule.minutes} min`);

/** The chat whose board, duties and check-in an agent works under: itself for a chat, else the chat its thread or root job belongs to. */
export function homeChat(app: App, id: AgentId): string | null {
  let { thread } = parseConversationId(id);
  for (let hops = 0; hops < 8; hops++) {
    const meta = app.threads.meta(thread);
    if (meta.kind === "chat") return app.threads.thread(thread) ? thread : null;
    if (!meta.parent) return null;
    thread = parseConversationId(meta.parent).thread;
  }
  return null;
}

export async function agentConfig(app: App, id: AgentId): Promise<AgentConfig> {
  let agent = app.threads.agent(id);
  if (!agent) {
    await app.threads.refresh().catch(() => undefined);
    agent = app.threads.agent(id);
  }
  if (!agent) throw new NotFound(`No agent ${id}.`);
  const { thread, conversation } = parseConversationId(id);
  const row = app.threads.thread(thread)!;
  const agentDir = primeAgentDir(app);
  const chat = homeChat(app, id);
  const dutiesPath = chat ? join(app.store.dir, "boards", chat, "duties.json") : null;
  const dutyFile = dutiesPath ? readJson<DutyFile>(dutiesPath, { duties: [], runs: {} }) : null;

  // Which duty run started each root job, from the run records' `job`.
  const dutyJobs = new Map<string, { chat: string; id: string; name: string }>();
  if (chat && dutyFile) {
    for (const [dutyId, runs] of Object.entries(dutyFile.runs ?? {})) {
      const duty = dutyFile.duties.find(d => d.id === dutyId);
      for (const run of runs as DutyRunRecord[]) if (run.job) dutyJobs.set(run.job.id, { chat, id: dutyId, name: duty?.name ?? dutyId });
    }
  }

  const [first, ping, usage, board] = await Promise.all([
    app.host.entries(thread, { conversation, after: 0, limit: 1 }).then(got => got.entries[0], () => undefined),
    app.host.ping().catch(error => ({ ok: false as const, error: String(error) })),
    app.host.usage({ since: Date.now() - 7 * DAY, threads: [thread] }).catch(() => null),
    chat ? app.boards.board(chat).catch(() => null) : Promise.resolve(null),
  ]);

  let purpose: AgentConfig["identity"]["purpose"] = null;
  const message = first?.model?.[0];
  if (first && message && (message.role === "user" || first.kind === "agent.message")) {
    const text = typeof message.content === "string" ? message.content : message.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("\n");
    const data = first.kind === "agent.message" ? (first.data as { from?: string; via?: string } | undefined) : undefined;
    const from = app.threads.principal(data?.from ?? "owner");
    purpose = {
      text: text.length > PURPOSE_CAP ? `${text.slice(0, PURPOSE_CAP - 1)}…` : text, truncated: text.length > PURPOSE_CAP,
      from: { id: from.id, name: from.name }, at: message.timestamp ?? agent.createdAt, ...(data?.via ? { via: data.via } : {}),
    };
  }

  const durableDir = !app.config.fixture && app.config.durableIndex ? dirname(app.config.durableIndex) : null;
  const threadFile = durableDir ? fileInfo("pi-durable thread file", join(durableDir, "threads", `${thread}.sqlite`), { note: "Its transcript, every job conversation and its documents, such as chat.board." }) : null;

  // Its swarm: child conversations in its own thread file, and root jobs filed under it.
  const nodes = app.threads.tree(thread);
  const below = (conv: number): number[] => nodes.filter(n => n.parent === conv).flatMap(n => [n.id, ...below(n.id)]);
  const children = new Set(below(conversation));
  const jobs: AgentConfig["swarm"]["jobs"] = nodes.filter(n => children.has(n.id)).map(n => ({
    id: conversationIdOf(thread, n.id), name: n.name, kind: "job" as const, status: app.threads.statusOfConversation(thread, n.id), createdAt: n.createdAt,
    parent: n.parent === null ? null : conversationIdOf(thread, n.parent), depth: n.depth - (nodes.find(x => x.id === conversation)?.depth ?? 0),
  }));
  for (const other of app.threads.threadsList()) {
    const meta = app.threads.meta(other.id);
    if (meta.kind !== "job" || meta.parent !== id) continue;
    jobs.push({
      id: other.id, name: other.name || "Untitled", kind: dutyJobs.has(other.id) ? "duty" : "root job", status: app.threads.statusOfConversation(other.id, 1),
      createdAt: other.createdAt, parent: id, depth: 1,
    });
  }
  jobs.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

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

  // Data that outlives a turn: the duty precheck state files of its chat.
  const related: ConfigFile[] = [harnessStore(agentDir)];
  if (chat && isChatRoot) {
    const stateDir = join(app.store.dir, "boards", chat, "duties");
    let names: string[] = [];
    try {
      names = readdirSync(stateDir).filter(name => name.endsWith(".state.json")).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      related.push(fileInfo(`duty ${name.replace(".state.json", "")} precheck state`, join(stateDir, name), {
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
      host: app.config.box, hostKind: app.host.name, hostVersion: ping.ok ? ping.version : null, socket: app.config.socket, cwd: row.cwd, cwdExists: existsSync(row.cwd),
      project: !isNoProject(row.cwd, app.config.home), canMove: conversation === 1, thread, conversation, threadFile, dataDir: app.store.dir,
    },
    board: chat && board ? { chat, chatName: app.threads.thread(chat)?.name ?? chat, own: chat === id, ...boardSummary(board) } : null,
    memory: {
      kind: "none",
      note: "A pi-host durable thread keeps no memory of its own. pi-host runs every thread with only the Prime preamble, the coding tools in its cwd and the "
        + "subagent tool (packages/pi-host/src/durable/registry.ts), so what it knows past its transcript is its board and the files it reads.",
      related,
    },
    instructions: {
      files: instructionFiles(row.cwd, agentDir),
      note: "Its model sees only the system text above: pi-durable loads no AGENTS.md, CLAUDE.md or skill. These files reach it only when it reads them with its tools.",
    },
    swarm: {
      parent: agent.parent ?? null, jobs,
      channels: app.channels.memberChannels(id).map(channel => ({ id: channel, name: app.channels.row(channel)?.name ?? channel })),
      duties, checkIn,
      dutiesFile: isChatRoot && dutiesPath ? fileInfo("duties, runs and check-in", dutiesPath) : null,
    },
    usage: usage === null ? null : {
      days: 7, turns: totals.reduce((sum, t) => sum + t.turns, 0), cost: totals.reduce((sum, t) => sum + t.cost, 0),
      tokens: {
        input: totals.reduce((sum, t) => sum + t.input, 0), output: totals.reduce((sum, t) => sum + t.output, 0),
        cacheRead: totals.reduce((sum, t) => sum + t.cacheRead, 0), cacheWrite: totals.reduce((sum, t) => sum + t.cacheWrite, 0),
      },
      scope: conversation === 1 ? `thread ${thread}, every conversation in it` : `thread ${thread}, which ${parentName ?? "its chat"} and its jobs share`,
    },
  };
}
