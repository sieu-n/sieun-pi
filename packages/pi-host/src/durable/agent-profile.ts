/**
 * The agent a durable thread belongs to, and what its folder gives every conversation of that thread.
 *
 * apps/chat writes an `agent.ref` chat.doc into the root conversation of each work thread and each root job thread filed under an agent
 * (`apps/chat/docs/agent-model.md`, phase 3). The agent folder (`~/.pi/agent/agents/<slug>/`) holds `brief.md`, which every conversation of
 * the thread reads as one more Prime context file (`prime-prompt.ts`), and `harness/harness_state.json`, a Prime harness store that is the
 * thread's local store in place of its per-thread one: the digest merges it over the global store, and the kernel's `RLM_HARNESS_STATE_DIR`
 * points at it, so `rlm.harness` and `refine.run()` write agent memory. A thread with no ref, or a ref of a bad shape, keeps its own store
 * and no brief.
 */
import type { Context } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type DocumentReader } from "@earendil-works/pi-durable";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { threadHarnessDir } from "./prime-harness.ts";
import { ChatDoc } from "./registry.ts";
import { getLocalHarnessStateDir } from "./vendor/prime-harness.ts";

export type AgentRole = "work" | "job";
/** An `agent.ref` value: the agent's id, its folder on this box, and whether the thread is its work thread or a job filed under it. */
export interface AgentRef { agent: string; dir: string; role: AgentRole }
export const AGENT_REF_DOC = "agent.ref";

/** The ref in a chat.doc value, or undefined for any other shape. */
export function parseAgentRef(value: unknown): AgentRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { agent, dir, role } = value as Record<string, unknown>;
  if (typeof agent !== "string" || !agent || typeof dir !== "string" || !isAbsolute(dir) || (role !== "work" && role !== "job")) return undefined;
  return { agent, dir, role };
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
