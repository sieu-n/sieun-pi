/**
 * `GET /api/agents/:id/prompt`: the prompt each kind of an agent's threads runs with. pi-host's builder makes it (`conversationPromptInput` and
 * `primePromptParts` in packages/pi-host/src/durable/prime-prompt.ts, the role text from `roleFields` in agent-profile.ts), run from the pi-host
 * tree the box runs, `~/.local/share/pi-host/current`, in a child process (`agent-prompt-child.ts`), since that code loads Prime's own modules
 * from that tree's node_modules. The fixture and a checkout run use the checkout's pi-host.
 *
 * A registered agent shows three kinds: its main thread's root, the comm thread of its DM (else of its first room), and a job of its main
 * thread, built for its newest job's conversation. Any other page shows its own conversation. A build took 2.7 s on us-metal02 on 11-23, so
 * calls for one agent that overlap share one build.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentId, AgentPrompt, PromptKind, PromptSection } from "../web/src/lib/api/types.ts";
import { agentRef, commRef, type AgentRef } from "./agent-folder.ts";
import { primeAgentDir } from "./agent-config.ts";
import { NotFound, type App } from "./app.ts";

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

/** The pi-host tree to build with: the checkout's for the fixture, else the one the box runs, else the checkout's. */
export function builderTree(fixture: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const installed = env.PI_HOST_DIR ?? join(homedir(), ".local/share/pi-host/current");
  const trees = fixture ? [CHECKOUT, installed] : [installed, CHECKOUT];
  const tree = trees.find(dir => existsSync(join(dir, BUILDER)));
  if (!tree) throw new Error(`no pi-host tree with ${BUILDER} at ${trees.join(" or ")}`);
  return realpathSync(tree);
}

function runChild(tree: string, request: PromptChildRequest): Promise<PromptChildAnswer> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "agent-prompt-child.ts"), tree], { cwd: join(tree, "packages"), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { err += chunk; });
    child.on("error", fail);
    child.on("close", code => {
      const lines = err.split("\n").map(line => line.trim()).filter(Boolean);
      const at = lines.findIndex(line => /Error\b/.test(line));
      const cause = at >= 0 ? lines.slice(at, at + 2).join(" ") : lines.at(-1);
      if (code !== 0) return fail(new Error(`the prompt build in ${tree} exited ${code}: ${cause || "no output"}`));
      try {
        done(JSON.parse(out) as PromptChildAnswer);
      } catch (error) {
        fail(new Error(`the prompt build in ${tree} wrote no JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const building = new Map<AgentId, Promise<AgentPrompt>>();

export function agentPrompt(app: App, id: AgentId): Promise<AgentPrompt> {
  let pending = building.get(id);
  if (!pending) {
    pending = build(app, id).finally(() => building.delete(id));
    building.set(id, pending);
  }
  return pending;
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
    conversations.push(at(agent.conversation > 1 ? "job" : "work", agent.thread, agent.conversation, ref));
  }
  const tree = builderTree(app.config.fixture);
  const answer = await runChild(tree, { agentDir: primeAgentDir(app), conversations });
  return {
    agent: agent.id, builtBy: tree, builtAt, skills: answer.skills,
    kinds: answer.kinds.map((kind, index) => {
      const conversation = conversations[index]!;
      const sections: PromptSection[] = kind.parts.map(part => (part.key === "harness" && conversation.conversationId === 1 ? { ...part, message: true as const } : part));
      return { kind: kind.kind, thread: conversation.thread.id, conversation: conversation.conversationId, sections };
    }),
  };
}
