/**
 * The agent a durable thread belongs to, and what its folder gives every conversation of that thread.
 *
 * apps/chat writes an `agent.ref` chat.doc into the root conversation of each work thread, each root job thread filed under an agent and
 * each comm thread (`apps/chat/docs/agent-model.md`, phases 3 and 4). The agent folder (`~/.pi/agent/agents/<slug>/`) holds `brief.md`, which
 * every conversation of the thread reads as one more Prime context file (`prime-prompt.ts`), and `harness/harness_state.json`, a Prime
 * harness store that is the thread's local store in place of its per-thread one: the digest merges it over the global store, and the
 * kernel's `RLM_HARNESS_STATE_DIR` points at it, so `rlm.harness` and `refine.run()` write agent memory. A thread with no ref, or a ref of a
 * bad shape, keeps its own store and no brief.
 *
 * The ref's role also sets the root conversation's tools and instructions (`applyAgentRole`), in the commit that writes the ref: a comm
 * thread loses the coding tools that change files and gets `stop_work` (`comm.ts`), and a work thread that has a comm thread loses
 * `tell_owner`. pi-host keeps what it wrote in the `agent.role` document, so it changes or clears only a value it set itself.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { AgentDoc, defineDoc, ROOT_CONVERSATION_ID, type AgentState, type ConversationId, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { threadHarnessDir } from "./prime-harness.ts";
import { ChatDoc } from "./registry.ts";
import { getLocalHarnessStateDir } from "./vendor/prime-harness.ts";

/**
 * An `agent.ref` value: the agent's id, its folder on this box, and what the thread is to it. `work` is the agent's work thread, with `comm`
 * the id of its DM comm thread once the agent is split; `job` is a job filed under it; `comm` talks with the owner in room `room` (`dm_<slug>`)
 * and hands work to the work thread `work`.
 */
export type AgentRef =
  | { agent: string; dir: string; role: "work"; comm?: string }
  | { agent: string; dir: string; role: "job" }
  | { agent: string; dir: string; role: "comm"; room: string; work: string };
export type AgentRole = AgentRef["role"];
export const AGENT_REF_DOC = "agent.ref";

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The ref in a chat.doc value, or undefined for any other shape. */
export function parseAgentRef(value: unknown): AgentRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { agent, dir, role, comm, room, work } = value as Record<string, unknown>;
  if (!isId(agent) || typeof dir !== "string" || !isAbsolute(dir)) return undefined;
  if (role === "job") return { agent, dir, role };
  if (role === "work") {
    if (comm === undefined) return { agent, dir, role };
    return isId(comm) ? { agent, dir, role, comm } : undefined;
  }
  if (role === "comm" && isId(room) && isId(work)) return { agent, dir, role, room, work };
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What a role sets on the root conversation.

/** The deferred tool a comm thread is offered (`comm.ts`); no other thread loads it. */
export const STOP_WORK_TOOL = "stop_work";
/** The coding tools a comm thread does without: it reads files, and it hands any change to the work thread. */
export const COMM_REMOVED_TOOLS = ["write", "edit", "bash", "subagent"] as const;

/** The root conversation's instructions for a comm thread. */
export function commInstructions(ref: { agent: string; room: string; work: string }): string {
  const work = JSON.stringify(ref.work);
  return [
    `You are agent ${ref.agent}'s comm thread in room ${ref.room}. You talk with the owner. The work thread ${ref.work} does the agent's work.`,
    "",
    `1. Answer a status question from the work thread's state. Read it in ipython with \`await agent_observe.get_agent(${work})\` or \`await agent_observe.recent_messages(${work})\`, and read the board with chat_board. Never ask the work thread for its status.`,
    `2. Hand any task that takes more than a minute to the work thread with \`await agent_message.send(task, receiver_role="sibling", receiver_name=${work})\`. Steer it the same way with \`mode="steer"\`, and stop its turn with stop_work.`,
    "3. A `[work-done ...]` or `[work-failed ...]` input is a notice from pi-host, not the owner's turn. Tell the owner about it only when he asked for that result or it needs his decision (c117). Otherwise end the turn without a message.",
    "4. Speak to the owner only with tell_owner. You do not edit files, so you have no write, edit, bash or subagent tool.",
  ].join("\n");
}

/** The root conversation's instructions for a work thread whose agent has a comm thread. */
export function workInstructions(ref: { agent: string; comm: string }): string {
  return [
    `You are agent ${ref.agent}'s work thread. You do not talk with people, so you have no tell_owner tool.`,
    `The comm thread ${ref.comm} talks with the owner and hands you tasks as agent messages.`,
    `When a task finishes, fails or gets blocked, report to the comm thread with \`await agent_message.send(report, receiver_role="sibling", receiver_name=${JSON.stringify(ref.comm)})\`, and lead the report with the answer.`,
    "If a handed task ends with no report, pi-host sends your last text to the comm thread for you.",
  ].join("\n");
}

type RoleFields = Pick<AgentState, "tools" | "modelTools" | "instructions">;
/** Equal JSON values; the agent document's drafts compare by their JSON text. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const ROLE_FIELDS = ["tools", "modelTools", "instructions"] as const;

/** The tools filter, offered tools and instructions a ref's role gives the root conversation; none for a job or a work thread with no comm. */
export function roleFields(ref: AgentRef | undefined): RoleFields {
  if (ref?.role === "comm") return { tools: { remove: [...COMM_REMOVED_TOOLS] }, modelTools: { add: [STOP_WORK_TOOL] }, instructions: commInstructions(ref) };
  if (ref?.role === "work" && ref.comm) return { tools: { remove: ["tell_owner"] }, instructions: workInstructions({ agent: ref.agent, comm: ref.comm }) };
  return {};
}

/** The values pi-host last wrote into the root conversation's agent for its role, by field; null for a field it did not set. */
export type AppliedRole = { tools: JsonValue; modelTools: JsonValue; instructions: string | null };
export const AgentRoleDoc = defineDoc<AppliedRole>({
  kind: "agent.role",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ tools: null, modelTools: null, instructions: null }),
  checkpointWhen: () => true,
});

/**
 * Brings the root conversation's agent to what `ref`'s role asks, inside the caller's commit. A field is pi-host's to change only while it is
 * unset or still holds the value pi-host wrote; a value something else set stays as it is. Writes nothing when the agent already matches,
 * so a repeated ref changes nothing.
 */
export async function applyAgentRole(tx: Tx, ref: AgentRef | undefined): Promise<void> {
  const want = roleFields(ref);
  const state = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID) as AgentState;
  const applied = await tx.doc(AgentRoleDoc, ROOT_CONVERSATION_ID) as AppliedRole;
  for (const field of ROLE_FIELDS) {
    const current = state[field] as JsonValue | undefined;
    const mine = applied[field];
    if (current !== undefined && (mine === null || !same(current, mine))) continue;
    const next = want[field] as JsonValue | undefined;
    if (next === undefined) {
      if (current !== undefined) delete state[field];
      if (mine !== null) applied[field] = null;
      continue;
    }
    if (!same(current, next)) (state as Record<string, unknown>)[field] = structuredClone(next);
    if (!same(mine, next)) (applied as Record<string, unknown>)[field] = structuredClone(next);
  }
}

/**
 * Clears from a new child conversation the role fields it copied from its owner, inside the commit that creates it: a child of a comm or
 * work thread is neither, so it keeps only fields something other than pi-host's role set.
 */
export async function dropAgentRole(tx: Tx, conversation: ConversationId): Promise<void> {
  const applied = await tx.doc(AgentRoleDoc, ROOT_CONVERSATION_ID) as AppliedRole;
  const state = await tx.doc(AgentDoc, conversation) as AgentState;
  for (const field of ROLE_FIELDS) {
    if (applied[field] !== null && state[field] !== undefined && same(state[field], applied[field])) delete state[field];
  }
}

/** The agent of the thread whose documents `reader` reads: the root conversation's `agent.ref`, which its child conversations share. */
export async function threadAgent(reader: Pick<DocumentReader, "snapshot"> | undefined, context: Context): Promise<AgentRef | undefined> {
  if (!reader) return undefined;
  const doc = await reader.snapshot(ChatDoc, ROOT_CONVERSATION_ID, AGENT_REF_DOC, context);
  return parseAgentRef(doc?.value);
}

/** The agent's Prime harness store, `<agent folder>/harness`. */
export const agentHarnessDir = (ref: AgentRef): string => getLocalHarnessStateDir(ref.dir)!;

/**
 * A conversation's local harness store: the agent's for a thread with a ref, else the thread's own, by Prime's rule for a session
 * (`threadHarnessDir`), where the root conversation's session is the thread and a child's is `<thread>-<conversation>`.
 */
export function conversationHarnessDir(thread: { id: string; file: string }, conversation: number, ref: AgentRef | undefined): string {
  if (ref) return agentHarnessDir(ref);
  return threadHarnessDir(thread.file, conversation === ROOT_CONVERSATION_ID ? thread.id : `${thread.id}-${conversation}`);
}

export interface ContextFile { path: string; content: string }
const briefs = new Map<string, { stamp: string; file: ContextFile | undefined }>();

/** The agent's `brief.md` as a Prime context file, or undefined when it is missing or blank; read again only when the file changed. */
export function briefFile(ref: AgentRef): ContextFile | undefined {
  const path = join(ref.dir, "brief.md");
  const stat = statSync(path, { throwIfNoEntry: false });
  const stamp = stat?.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "none";
  const kept = briefs.get(path);
  if (kept?.stamp === stamp) return kept.file;
  let content = "";
  try {
    content = stamp === "none" ? "" : readFileSync(path, "utf8");
  } catch {
    content = "";
  }
  const file = content.trim() ? { path, content } : undefined;
  briefs.set(path, { stamp, file });
  return file;
}
