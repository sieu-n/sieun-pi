/**
 * What every durable thread runs with: Prime's system prompt (`prime-prompt.ts`) when the host knows Prime's agent dir, else Prime's
 * preamble alone, pi-durable's coding tools in the thread's cwd, the subagent tool (which returns at once, `subagent.ts`), the
 * `send_message` tool, and, when the host loaded it, Prime's chat extension (`prime-chat.ts`: `tell_owner`, `chat_board`, `correction_add`,
 * `search_history`, `poteto_mode` and the turn wrappers) and Prime's `ipython` with its RLM runtime (`rlm.ts`), plus the chat's own
 * document and entry kinds, the child delivery task (`children.ts`), and the comm thread's hand-over task and `stop_work` (`comm.ts`).
 * Each thread file gets its own registry, so its prompt can name its file.
 */
import type { JsonValue } from "@earendil-works/chord";
import { createRegistry, defineDocFamily, defineEntry, type Extension, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Preamble } from "./open.ts";
import { primeChat, type ChatThread, type PrimeChat } from "./prime-chat.ts";
import { primePrompt, type PrimePromptOptions } from "./prime-prompt.ts";
import { SendMessage, SendMessageAlias } from "./send-message.ts";
import { ChildTasks } from "./children.ts";
import { subagentExtension } from "./subagent.ts";

/** A message one agent or the owner sends another thread, placed as the input's entry so the transcript shows who sent it. */
export const AgentMessageEntry = defineEntry<{ from: string; via?: string }>("agent.message");

/** Named JSON documents the chat keeps per conversation, such as `chat.meta` and `chat.board`. */
export const ChatDoc = defineDocFamily<{ value: JsonValue }, null>({
  kind: "chat.doc",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ value: null }),
  checkpointWhen: () => true,
});

export interface ThreadExtras {
  /** The thread a subagent's notice names as its sender; default none. */
  thread?: { id: string; file?: string };
  /** Prime's `ipython` and its RLM runtime for this thread (`rlm.ts` `DurableRlm.extension`). */
  rlm?: Extension;
  /** The comm thread's hand-over task and `stop_work` (`comm.ts` `commExtension`). */
  comm?: Extension;
}

export function threadRegistry(prompt?: PrimePromptOptions, chat?: { chat: PrimeChat; thread: ChatThread }, extras: ThreadExtras = {}): Registry {
  const registry = createRegistry();
  registry.install(prompt ? primePrompt(prompt) : Preamble);
  registry.install(CodingTools);
  registry.install(subagentExtension(extras.thread ?? { id: "" }));
  // With Prime's chat extension, tell_owner is how the agent speaks to the owner, and send_message stays as an alias (send-message.ts).
  registry.install(chat ? SendMessageAlias : SendMessage);
  if (chat) registry.install(primeChat(chat.chat, chat.thread));
  registry.install(ChildTasks);
  if (extras.rlm) registry.install(extras.rlm);
  if (extras.comm) registry.install(extras.comm);
  return registry;
}

/** The environment a conversation's tools run in: the host's machine, in the conversation's cwd or else the thread's cwd at that call. */
export const threadEnv = (defaultCwd: () => string) => (target: { cwd?: string }) => new NodeExecutionEnv({ cwd: target.cwd ?? defaultCwd() });
