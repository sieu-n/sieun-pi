/**
 * What every durable thread runs with: Prime's preamble, pi-durable's coding tools in the thread's cwd, the foreground
 * subagent tool, the `send_message` tool the agent speaks to people through, and the chat's own document and entry kinds. One registry serves every thread in the host.
 */
import type { JsonValue } from "@earendil-works/chord";
import { createRegistry, defineDocFamily, defineEntry, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Preamble } from "./open.ts";
import { SendMessage } from "./send-message.ts";
import { Subagent } from "./subagent.ts";

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

export function threadRegistry(): Registry {
  const registry = createRegistry();
  registry.install(Preamble);
  registry.install(CodingTools);
  registry.install(Subagent);
  registry.install(SendMessage);
  return registry;
}

/** The environment a conversation's tools run in: the host's machine, in the conversation's cwd or the host's default. */
export const threadEnv = (defaultCwd: string) => (target: { cwd?: string }) => new NodeExecutionEnv({ cwd: target.cwd ?? defaultCwd });
