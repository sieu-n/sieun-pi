/**
 * What every durable thread runs with: Prime's system prompt (`prime-prompt.ts`) when the host knows Prime's agent dir, else Prime's
 * preamble alone, pi-durable's coding tools in the thread's cwd, the subagent tool (which returns at once, `subagent.ts`), the
 * `send_message` tool, and, when the host loaded it, Prime's chat extension (`prime-chat.ts`: `tell_owner`, `chat_board`, `correction_add`,
 * `search_history`, `poteto_mode` and the turn wrappers) with the room tools beside it (`room-tools.ts`: `set_emoji`), Prime's `ipython` with its RLM runtime (`rlm.ts`) and sieun-rules' tool guards (`rules.ts`), plus the chat's own
 * document and entry kinds, the child delivery task (`children.ts`), and the comm thread's hand-over task and `stop_work` (`comm.ts`).
 * Each thread file gets its own registry, so its prompt can name its file.
 */
import { delimiter } from "node:path";
import { createRegistry, defineEntry, type Extension, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Preamble } from "./open.ts";
import { ownerTag } from "./owner-tag.ts";
import { primeChat, type ChatThread, type PrimeChat } from "./prime-chat.ts";
import { primePrompt, type PrimePromptOptions } from "./prime-prompt.ts";
import { roomTools } from "./room-tools.ts";
import { SendMessage, sendMessageAlias } from "./send-message.ts";
import { ChildTasks } from "./children.ts";
import { KernelToolHint } from "./kernel-tool-hint.ts";
import { subagentExtension } from "./subagent.ts";
import { workingMemory } from "./working-memory.ts";

/** A message one agent or the owner sends another thread, placed as the input's entry so the transcript shows who sent it. */
export const AgentMessageEntry = defineEntry<{ from: string; via?: string }>("agent.message");

export interface ThreadExtras {
  /** The thread a subagent's notice names as its sender; default none. */
  thread?: { id: string; file?: string };
  /** Prime's `ipython` and its RLM runtime for this thread (`rlm.ts` `DurableRlm.extension`). */
  rlm?: Extension;
  /** The comm thread's hand-over task and `stop_work` (`comm.ts` `commExtension`). */
  comm?: Extension;
  /** sieun-rules' guards around every tool call (`rules.ts` `DurableRules.extension`). */
  rules?: Extension;
  /** The hooks that hold new requests and tool calls while pi-host stops (`drain-gate.ts`). */
  gate?: Extension;
}

export function threadRegistry(prompt?: PrimePromptOptions, chat?: { chat: PrimeChat; thread: ChatThread }, extras: ThreadExtras = {}): Registry {
  const registry = createRegistry();
  registry.install(prompt ? primePrompt(prompt) : Preamble);
  registry.install(CodingTools);
  registry.install(subagentExtension(extras.thread ?? { id: "" }));
  // With Prime's chat extension, tell_owner is how the agent speaks to the owner, and send_message stays as an alias (send-message.ts).
  registry.install(chat ? sendMessageAlias(chat.chat.app, chat.thread.id) : SendMessage);
  if (chat) registry.install(primeChat(chat.chat, chat.thread));
  if (chat) registry.install(roomTools(chat.chat.app, chat.thread.id));
  registry.install(ChildTasks);
  if (extras.rlm) registry.install(extras.rlm);
  // A call of a kernel module as a tool, such as agent_message.send, reads how to make it in ipython (`kernel-tool-hint.ts`).
  registry.install(KernelToolHint);
  if (extras.comm) registry.install(extras.comm);
  if (extras.rules) registry.install(extras.rules);
  if (extras.gate) registry.install(extras.gate);
  // Last, so the `working` section follows every other extension's section.
  if (prompt) registry.install(workingMemory());
  return registry;
}

/**
 * The environment a conversation's tools run in: the host's machine, in the conversation's cwd or else the thread's cwd at that call, with the
 * thread's owner tag. On 11-20 the unit blind-replies-run4, which an agent factory thread started from its `bash` tool, named no owner,
 * because only the thread's kernel had the tag.
 */
export const threadEnv = (threadId: string, defaultCwd: () => string) => (target: { cwd?: string }) => new NodeExecutionEnv({
  cwd: target.cwd ?? defaultCwd(),
  shellEnv: ownerTag(threadId, process.env.PATH ?? "", delimiter),
});
