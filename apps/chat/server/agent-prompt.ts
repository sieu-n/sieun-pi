/**
 * `GET /api/agents/:id/prompt`: the prompt each kind of an agent's threads runs with. pi-host's builder makes it (`conversationPromptInput` and
 * `primePromptParts` in packages/pi-host/src/durable/prime-prompt.ts, the role text from `roleFields` in agent-profile.ts), run from the pi-host
 * tree the box runs, `~/.local/share/pi-host/current`, in a child process (`agent-prompt-child.ts`), since that code loads Prime's own modules
 * from that tree's node_modules. The fixture and a checkout run use the checkout's pi-host.
 *
 * A registered agent shows three kinds: its main thread's root, the comm thread of its DM (else of its first room), and a job of its main
 * thread, built for its newest job's conversation. Any other page shows its own conversation. Calls for one agent that overlap share one build.
 *
 * The child stays up and builds every call, so each answer is built from the files as they are at that call. A child per call took 3.1 to
 * 5.9 s on the server on 11-24 (requests/2026-11-23.jsonl), nearly all of it node, tsx and the import of pi-host's and Prime's modules,
 * while a build in a child that had them loaded took 50 to 80 ms (agent-prompt-child.ts). The live server starts the child as it starts
 * and again when the box's pi-host tree changes, so his first open after a restart or a pi-host install finds it loaded. It holds about
 * 290 MB.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentId, AgentPrompt, AgentPromptOutline, PromptKind, PromptSection } from "../web/src/lib/api/types.ts";
import { agentRef, commRef, type AgentRef } from "./agent-folder.ts";
import { primeAgentDir } from "./agent-config.ts";
import { NotFound, type App } from "./app.ts";
import { KeptJson } from "./compress.ts";

/** One conversation to build, as the child reads it: the fields of pi-host's `PromptAt`, with the ref as apps/chat writes it. */
export interface PromptChildRequest {
  agentDir: string;
  conversations: { kind: PromptKind; conversationId: number; cwd: string; agent?: AgentRef; thread: { id: string; file: string; name: string } }[];
}
export interface PromptChildAnswer {
  kinds: { kind: PromptKind; parts: { key: string; text: string; source: string }[] }[];
  skills: AgentPrompt["skills"];
}

const CHECKOUT = resolve(import.meta.dirname, "../../..");
const BUILDER = "packages/pi-host/src/durable/prime-prompt.ts";

/** The pi-host tree to build with: the checkout's for a fixture with no PI_HOST_DIR, else the one the box runs, else the checkout's. */
export function builderTree(fixture: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const installed = env.PI_HOST_DIR ?? join(homedir(), ".local/share/pi-host/current");
  const trees = fixture && !env.PI_HOST_DIR ? [CHECKOUT, installed] : [installed, CHECKOUT];
  const tree = trees.find(dir => existsSync(join(dir, BUILDER)));
  if (!tree) throw new Error(`no pi-host tree with ${BUILDER} at ${trees.join(" or ")}`);
  return realpathSync(tree);
}

/** How many builder children this process started; a test reads it. */
export let builderStarts = 0;

/** A child that loaded pi-host's builder from `tree`, with the calls it has not answered yet. */
class Builder {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, { done: (answer: PromptChildAnswer) => void; fail: (error: Error) => void }>();
  private next = 0;
  private err = "";
  ended: Error | undefined;
  /** Whether it answered a build: until then a call waits for node, tsx and the imports, 3 to 9 s at load 120 to 235 on 11-24. */
  ready = false;

  readonly tree: string;

  constructor(tree: string) {
    this.tree = tree;
    builderStarts += 1;
    this.child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "agent-prompt-child.ts"), tree], { cwd: join(tree, "packages"), stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", line => this.answer(line));
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.err = (this.err + chunk).slice(-4000); });
    this.child.on("error", error => this.end(error));
    this.child.on("close", code => {
      const lines = this.err.split("\n").map(line => line.trim()).filter(Boolean);
      const at = lines.findIndex(line => /Error\b/.test(line));
      const cause = at >= 0 ? lines.slice(at, at + 2).join(" ") : lines.at(-1);
      this.end(new Error(`the prompt builder in ${tree} exited ${code}: ${cause || "no output"}`));
    });
    // The server never waits on the child to exit; the child exits when the server does, since its stdin ends then.
    this.child.unref();
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) (pipe as unknown as { unref?: () => void }).unref?.();
  }

  build(request: PromptChildRequest): Promise<PromptChildAnswer> {
    if (this.ended) return Promise.reject(this.ended);
    const id = (this.next += 1);
    return new Promise((done, fail) => {
      this.waiting.set(id, { done, fail });
      this.child.stdin.write(`${JSON.stringify({ id, request })}\n`);
    });
  }

  /** Ends the child once it answered the calls it has. */
  stop(): void {
    this.child.stdin.end();
  }

  private answer(line: string): void {
    let message: { id: number; answer?: PromptChildAnswer; error?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch (error) {
      return this.end(new Error(`the prompt builder in ${this.tree} wrote no JSON: ${error instanceof Error ? error.message : String(error)}`));
    }
    const call = this.waiting.get(message.id);
    this.waiting.delete(message.id);
    if (message.answer) this.ready = true;
    if (message.answer) call?.done(message.answer);
    else call?.fail(new Error(`the prompt build in ${this.tree} failed: ${message.error ?? "no answer"}`));
  }

  private end(error: Error): void {
    this.ended ??= error;
    for (const call of this.waiting.values()) call.fail(error);
    this.waiting.clear();
    if (builder === this) builder = undefined;
  }
}

let builder: Builder | undefined;

/** The builder for `tree`, started when there is none or the one there loaded another tree, which ends once it answered its calls. */
function builderFor(tree: string): Builder {
  if (builder?.tree === tree && !builder.ended) return builder;
  builder?.stop();
  return (builder = new Builder(tree));
}

/** Whether the builder of the tree a call would build with answered a build, so a call to it takes 50 to 80 ms of its time. */
function builderWarm(app: App): boolean {
  try {
    return builder !== undefined && !builder.ended && builder.ready && builder.tree === builderTree(app.config.fixture);
  } catch {
    return false;
  }
}

/**
 * Starts the builder of the live server (main.ts) with one build of one of this box's agents, which loads Prime's modules, and does it
 * again when the box's pi-host tree changes, which `install-pi-host-box.mjs` does by moving its `current` link. Every other agent's first
 * read meanwhile answers from its stored answer. A build of each of the 234 agents at each start, walks' test agents included, held
 * 75 MB of stored answers on 11-24 and queued a page's build behind them in the child. A fixture's, a test's or a rig's builder starts at
 * its first call.
 */
export function warmPrompts(app: App): void {
  if (app.config.fixture) return;
  const warm = () => {
    const first = app.agents.list().find(record => !record.archived && !record.test && app.threads.agent(record.id) && (app.routing?.boxOf(record.workThread) ?? app.config.box) === app.config.box);
    if (first) void agentPrompt(app, first.id).catch(error => app.log(`prompt: the builder did not warm: ${error instanceof Error ? error.message : String(error)}`));
  };
  warm();
  const installed = process.env.PI_HOST_DIR ?? join(homedir(), ".local/share/pi-host/current");
  try {
    watch(dirname(installed), (_event, name) => {
      if (name !== basename(installed)) return;
      let tree: string | undefined;
      try {
        tree = builderTree(false);
      } catch {
        return;
      }
      if (builder?.tree !== tree) warm();
    }).unref();
  } catch (error) {
    app.log(`prompt: no watch on ${dirname(installed)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const building = new Map<AgentId, Promise<AgentPrompt>>();
/** Each agent's newest answer, by its text: a build that made the same text answers with it, so `builtAt` is when that text was first built. */
const newest = new Map<AgentId, { text: string; answer: AgentPrompt }>();
/** How many builds this process ran; a test reads it. */
export let promptBuilds = 0;
const textOf = (answer: AgentPrompt): string => JSON.stringify({ ...answer, builtAt: 0 });
/** The store cache that keeps an agent's newest answer for the next server (store.ts `cache`). */
const cacheName = (id: AgentId): string => `prompt-${id}`;

/** The agent's newest answer, from this server's builds or else the one an earlier server stored. */
function storedPrompt(app: App, id: AgentId): AgentPrompt | undefined {
  let kept = newest.get(id);
  if (!kept) {
    const answer = app.store.cache<AgentPrompt | null>(cacheName(id), null);
    if (answer && Array.isArray(answer.kinds)) newest.set(id, (kept = { text: textOf(answer), answer }));
  }
  return kept?.answer;
}

/** The state a new server process starts with: no builder and no answer in memory; a test calls it. */
export function forgetPrompts(): void {
  builder?.stop();
  builder = undefined;
  newest.clear();
}

export function agentPrompt(app: App, id: AgentId): Promise<AgentPrompt> {
  let pending = building.get(id);
  if (!pending) {
    promptBuilds += 1;
    pending = build(app, id).then(answer => {
      const text = textOf(answer);
      const kept = storedPrompt(app, id);
      if (kept && newest.get(id)?.text === text) return kept;
      newest.set(id, { text, answer });
      app.store.saveCache(cacheName(id), answer);
      return answer;
    }).finally(() => building.delete(id));
    building.set(id, pending);
  }
  return pending;
}

/**
 * GET /api/agents/:id/prompt: the whole answer of the newest build, waiting for one on its way, and built only when there is none. The
 * page reads it for the texts of the outline it shows, whose read built them (`agentPromptOutlineAnswer`); a second build per open doubled
 * the builder's work, and at load 120 to 235 on us-metal02 on 11-24 the route's server time reached p90 553 ms. The same text keeps its
 * bytes, compressed once, and its ETag, so a page that holds it gets 304 with no body: 67 to 102 KB as brotli for agent factory, vent and
 * Crawler guy on 11-24.
 */
export async function agentPromptAnswer(app: App, id: AgentId): Promise<KeptJson> {
  const warm = builderWarm(app);
  const answer = await ((warm ? building.get(id) : undefined) ?? storedPrompt(app, id) ?? agentPrompt(app, id));
  return new KeptJson(`prompt:${id}`, [answer], () => {
    const json = JSON.stringify(answer);
    return { json, rest: json, entries: [] };
  });
}

/** The answer without the sections' text (`AgentPromptOutline`), which fits one round trip where the whole answer took four or five. */
export const promptOutline = (answer: AgentPrompt): AgentPromptOutline => ({
  ...answer,
  kinds: answer.kinds.map(kind => ({ ...kind, sections: kind.sections.map(({ text, ...section }) => ({ ...section, chars: text.length })) })),
});

/**
 * GET /api/agents/:id/prompt/outline as a `KeptJson`, kept by the answer it outlines; each read builds. At a 200 ms round trip in a
 * walk on 11-24, a first open that read the whole answer, 63 to 94 KB as brotli, drew the tab 1.4 s after the click once the page had
 * sat idle.
 *
 * While the builder is not warm, after a server start or a pi-host install, a read answers at once with the stored answer marked
 * `pending` and starts the build; a read with `wait` waits for that build. A first call there waited 6.5 to 8.8 s on 11-24.
 */
export async function agentPromptOutlineAnswer(app: App, id: AgentId, wait = false): Promise<KeptJson> {
  const kept = !wait && !builderWarm(app) ? storedPrompt(app, id) : undefined;
  if (kept) void agentPrompt(app, id).catch(error => app.log(`prompt: ${id} did not build: ${error instanceof Error ? error.message : String(error)}`));
  const answer = kept ?? await agentPrompt(app, id);
  return new KeptJson(`prompt-outline:${id}`, [answer, kept !== undefined], () => {
    const json = JSON.stringify(kept ? { ...promptOutline(answer), pending: true } : promptOutline(answer));
    return { json, rest: json, entries: [] };
  });
}

async function build(app: App, id: AgentId): Promise<AgentPrompt> {
  let agent = app.threads.agent(id);
  if (!agent) {
    await app.threads.refresh().catch(() => undefined);
    agent = app.threads.agent(id);
  }
  if (!agent) throw new NotFound(`No agent ${id}.`);
  const builtAt = Date.now();
  const box = app.routing?.boxOf(agent.thread);
  if (box && box !== app.config.box) {
    return { agent: agent.id, builtBy: "", builtAt, kinds: [], skills: [], away: `Its threads run on ${box}, and this page builds prompts only for threads on ${app.config.box}.` };
  }
  const durableDir = !app.config.fixture && app.config.durableIndex ? dirname(app.config.durableIndex) : join(app.config.dataDir, "durable");
  const at = (kind: PromptKind, thread: string, conversationId: number, ref: AgentRef | undefined): PromptChildRequest["conversations"][number] => {
    const row = app.threads.thread(thread);
    return {
      kind, conversationId, cwd: row?.cwd ?? app.config.home, ...(ref ? { agent: ref } : {}),
      thread: { id: thread, file: join(durableDir, "threads", `${thread}.sqlite`), name: row?.name ?? agent.name },
    };
  };
  const record = app.threads.registered(agent.id)?.id === agent.id ? app.agents.record(agent.id) : app.agents.record(agent.thread);
  const conversations: PromptChildRequest["conversations"] = [];
  if (record && agent.id === record.id) {
    const dir = app.agents.agentsDirOf(record);
    conversations.push(at("work", record.workThread, 1, agentRef(dir, record, "work")));
    const room = record.comm?.[record.room] ? record.room : Object.keys(record.comm ?? {})[0];
    if (room) conversations.push(at("comm", record.comm![room]!, 1, commRef(dir, record, room)));
    const newest = app.threads.jobsOf(record.id).filter(job => job.thread === record.workThread && job.conversation > 1).sort((a, b) => b.conversation - a.conversation)[0];
    conversations.push(at("job", record.workThread, newest?.conversation ?? 2, agentRef(dir, record, "work")));
  } else {
    // A job's page: its own conversation, with the ref its thread holds (a job of the main thread reads the main thread's).
    const dir = record && app.agents.agentsDirOf(record);
    const ref = record && dir ? (agent.thread === record.workThread ? agentRef(dir, record, "work") : agentRef(dir, record, "job")) : undefined;
    // A root job thread filed under the agent is a job too, at its root conversation.
    const kind: PromptKind = agent.conversation > 1 || (record !== undefined && agent.thread !== record.workThread) ? "job" : "work";
    conversations.push(at(kind, agent.thread, agent.conversation, ref));
  }
  const tree = builderTree(app.config.fixture);
  const answer = await builderFor(tree).build({ agentDir: primeAgentDir(app), conversations });
  return {
    agent: agent.id, builtBy: tree, builtAt, skills: answer.skills,
    kinds: answer.kinds.map((kind, index) => {
      const conversation = conversations[index]!;
      const sections: PromptSection[] = kind.parts.map(part => (part.key === "harness" && conversation.conversationId === 1 ? { ...part, message: true as const } : part));
      return { kind: kind.kind, thread: conversation.thread.id, conversation: conversation.conversationId, sections };
    }),
  };
}
