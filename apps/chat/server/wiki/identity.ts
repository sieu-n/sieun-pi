/**
 * Who writes: the caller names its conversation in `x-pi-conversation` (`<thread>` or `<thread>:<n>`; the kernel's `<thread>-<n>` session
 * id form also reads), and the server checks it against pi-host's threads and agents.json. A known agent's write reads `<slug> (<conv>)`;
 * anything else still writes, as `unknown`, and the answer says why.
 */
import type { IncomingMessage } from "node:http";
import { agentRecordOf } from "../agent-config.ts";
import type { AgentRecord } from "../agent-store.ts";
import type { App } from "../app.ts";
import { conversationIdOf } from "../threads.ts";

export const CONVERSATION_HEADER = "x-pi-conversation";

export type Caller =
  | { known: true; author: string; agent: AgentRecord; conversation: string; thread: string; n: number }
  | { known: false; author: string; warning: string; conversation?: string };

const ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[:-](\d+))?$/i;

/** The conversation an id names, when pi-host holds that thread and, past the root, that child conversation. */
export async function knownConversation(app: App, id: string): Promise<{ thread: string; n: number; conversation: string } | null> {
  const match = ID.exec(id.trim());
  if (!match) return null;
  const thread = match[1]!.toLowerCase();
  const n = Number(match[2] ?? 1);
  if (!app.threads.thread(thread)) return null;
  if (n !== 1 && !app.threads.tree(thread).some(node => node.id === n)) {
    // A job made in the last poll interval is in pi-host's tree before it is in this server's copy.
    const tree = await app.host.tree(thread).catch(() => []);
    if (!tree.some(node => node.id === n)) return null;
  }
  return { thread, n, conversation: conversationIdOf(thread, n) };
}

export async function resolveConversation(app: App, id: string | undefined): Promise<Caller> {
  if (!id) return { known: false, author: "unknown", warning: `No ${CONVERSATION_HEADER} header, so the write is stamped unknown.` };
  const found = await knownConversation(app, id);
  if (!found) return { known: false, author: "unknown", warning: `pi-host holds no conversation ${id}, so the write is stamped unknown.` };
  const agent = agentRecordOf(app, found.conversation);
  if (!agent) {
    return { known: false, author: `unknown (${found.conversation})`, conversation: found.conversation, warning: `Conversation ${found.conversation} belongs to no agent in agents.json.` };
  }
  return { known: true, author: `${agent.slug} (${found.conversation})`, agent, ...found };
}

export function callerOf(app: App, req: IncomingMessage): Promise<Caller> {
  const value = req.headers[CONVERSATION_HEADER];
  return resolveConversation(app, Array.isArray(value) ? value[0] : value);
}
